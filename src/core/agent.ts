// Agent class — the runtime object with full module integration

import type {
  AgentMessage,
  AgentEvent,
  AgentState,
  AgentHooks,
  ModelConfig,
  ThinkingLevel,
  UserMessage,
} from "../types.js";
import type { AgentTool } from "../tools/types.js";
import type { Approval } from "../approval/types.js";
import type { LLMProvider } from "../llm/types.js";
import type { SessionConfig } from "../session/types.js";
import type { CompactionConfig } from "../compaction/types.js";
import type { CheckpointConfig } from "../checkpoint/types.js";
import type { DynamicInjectionProvider } from "../injection/types.js";
import type { ExtensionFactory } from "../extensions/types.js";
import type { SubagentConfig } from "../multi-agent/types.js";
import type { SkillSource } from "../skills/types.js";
import type { MCPServerConfig, MCPClient } from "../tools/mcp-adapter.js";
import type { TaskFactory } from "../background/types.js";
import type { PlanningConfig } from "../planning/types.js";
import type { TaskGraphConfig } from "../task-graph/types.js";
import { SessionManager } from "../session/session-manager.js";
import { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import { InjectionManager } from "../injection/injection-manager.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { LaborMarket } from "../multi-agent/labor-market.js";
import { TaskExecutor } from "../multi-agent/task-executor.js";
import { createTaskTool } from "../multi-agent/task-tool.js";
import { MCPAdapter } from "../tools/mcp-adapter.js";
import { discoverSkills } from "../skills/discovery.js";
import { createInvokeSkillTool } from "../skills/skill-tool.js";
import { LLMSummarizer, agentMessagesToCompactionInput } from "../compaction/summarizer.js";
import { Wire } from "../wire/wire.js";
import { BackgroundTaskManager } from "../background/task-manager.js";
import { createBackgroundTaskTools } from "../background/tools.js";
import { PlanningManager } from "../planning/planning-manager.js";
import { createPlanningTools } from "../planning/tools.js";
import { PlanningNagProvider } from "../planning/nag-injection.js";
import { TaskGraph } from "../task-graph/task-graph.js";
import { createTaskGraphTools } from "../task-graph/tools.js";
import { TaskResultInjectionProvider } from "../task-graph/result-injection.js";
import { resolveProvider } from "../llm/provider.js";
import { runAgentLoop } from "./agent-loop.js";

export interface AgentConfig {
  model: ModelConfig;
  systemPrompt: string | (() => string | Promise<string>);
  tools: AgentTool[];
  provider: LLMProvider;
  approval: Approval;
  name?: string;
  toolExecution?: "sequential" | "parallel";
  maxStepsPerTurn?: number;
  thinkingLevel?: ThinkingLevel;
  hooks?: AgentHooks;

  // Advanced modules
  session?: SessionConfig;
  compaction?: CompactionConfig;
  checkpoint?: CheckpointConfig;
  injection?: DynamicInjectionProvider[];
  extensions?: ExtensionFactory[];
  subagents?: Record<string, SubagentConfig>;
  skills?: SkillSource[];
  mcp?: { servers: MCPServerConfig[]; clientFactory: (config: MCPServerConfig) => MCPClient };
  wire?: { bufferSize?: number };
  backgroundTasks?: { factories?: Record<string, TaskFactory> };
  taskGraph?: TaskGraphConfig;
  planning?: PlanningConfig;
}

export class Agent {
  private _state: AgentState;
  private _provider: LLMProvider;
  private _approval: Approval;
  private _listeners = new Set<(event: AgentEvent) => void>();
  private _steeringQueue: AgentMessage[] = [];
  private _followUpQueue: AgentMessage[] = [];
  private _abortController: AbortController | null = null;
  private _config: AgentConfig;
  private _name: string;

  // Integrated modules
  private _sessionManager: SessionManager | undefined;
  private _checkpointManager: CheckpointManager | undefined;
  private _injectionManager: InjectionManager | undefined;
  private _extensionRunner: ExtensionRunner | undefined;
  private _laborMarket: LaborMarket | undefined;
  private _taskExecutor: TaskExecutor | undefined;
  private _mcpAdapter: MCPAdapter | undefined;
  private _wire: Wire;
  private _backgroundTaskManager: BackgroundTaskManager | undefined;
  private _planningManager: PlanningManager | undefined;
  private _taskGraph: TaskGraph;
  private _createdSubagents: Agent[] = [];
  private _initialized = false;

  constructor(config: AgentConfig) {
    this._config = config;
    this._provider = config.provider;
    this._approval = config.approval;
    this._name = config.name ?? "agent";
    this._wire = new Wire({ bufferSize: config.wire?.bufferSize ?? 0 });

    this._state = {
      systemPrompt: typeof config.systemPrompt === "string" ? config.systemPrompt : "",
      model: config.model,
      thinkingLevel: config.thinkingLevel ?? "off",
      tools: config.tools,
      messages: [],
      isRunning: false,
    };

    // Session
    if (config.session) {
      this._sessionManager = new SessionManager(config.session);
    }

    // Checkpoint (requires session)
    if (config.checkpoint?.enabled !== false && this._sessionManager) {
      this._checkpointManager = new CheckpointManager(this._sessionManager);
    }

    // Injection
    if (config.injection?.length) {
      this._injectionManager = new InjectionManager(config.injection);
    }

    // MCP
    if (config.mcp?.servers.length) {
      this._mcpAdapter = new MCPAdapter(config.mcp.servers, config.mcp.clientFactory);
    }

    // Multi-agent
    if (config.subagents && Object.keys(config.subagents).length > 0) {
      this._laborMarket = new LaborMarket();
      this._taskExecutor = new TaskExecutor(this._laborMarket, (name, event) => {
        this._emit({ ...event, type: event.type } as AgentEvent);
      });
    }

    // Background tasks
    if (config.backgroundTasks) {
      this._backgroundTaskManager = new BackgroundTaskManager((taskEvent) => {
        const { task } = taskEvent;
        if (taskEvent.type === "task_started") {
          this._emit({ type: "task_started", taskId: task.id, taskName: task.name });
          this._extensionRunner?.emitSimple("task_started", { taskId: task.id, taskName: task.name });
        } else if (taskEvent.type === "task_completed") {
          this._emit({ type: "task_completed", taskId: task.id, taskName: task.name });
          this._extensionRunner?.emitSimple("task_completed", { taskId: task.id, taskName: task.name, result: taskEvent.result });
        } else if (taskEvent.type === "task_failed") {
          this._emit({ type: "task_failed", taskId: task.id, taskName: task.name, error: taskEvent.error });
          this._extensionRunner?.emitSimple("task_failed", { taskId: task.id, taskName: task.name, error: taskEvent.error });
        }
      });
    }

    // Planning
    if (config.planning) {
      this._planningManager = new PlanningManager(config.planning);
    }

    // Task graph
    this._taskGraph = new TaskGraph(config.taskGraph ?? {});
  }

  // --- Public API ---

  async prompt(input: string | AgentMessage | AgentMessage[]): Promise<AgentMessage[]> {
    if (this._state.isRunning) {
      throw new Error("Agent is already running. Use steer() or followUp() to inject messages.");
    }

    await this._ensureInitialized();

    // Resolve system prompt if dynamic
    if (typeof this._config.systemPrompt === "function") {
      this._state.systemPrompt = await this._config.systemPrompt();
    }

    // Normalize input to messages
    const inputMessages = this._normalizeInput(input);
    this._state.messages.push(...inputMessages);

    // Persist input to session
    for (const msg of inputMessages) {
      await this._sessionManager?.appendMessage(msg);
    }

    return this._runLoop();
  }

  async continue(): Promise<AgentMessage[]> {
    if (this._state.isRunning) {
      throw new Error("Agent is already running.");
    }
    await this._ensureInitialized();
    return this._runLoop();
  }

  steer(message: AgentMessage): void {
    this._steeringQueue.push(message);
  }

  followUp(message: AgentMessage): void {
    this._followUpQueue.push(message);
  }

  abort(): void {
    this._abortController?.abort();
  }

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  get state(): AgentState {
    return this._state;
  }

  get approval(): Approval {
    return this._approval;
  }

  get session(): SessionManager | undefined {
    return this._sessionManager;
  }

  get checkpoints(): CheckpointManager | undefined {
    return this._checkpointManager;
  }

  get extensions(): ExtensionRunner | undefined {
    return this._extensionRunner;
  }

  get injections(): InjectionManager | undefined {
    return this._injectionManager;
  }

  get laborMarket(): LaborMarket | undefined {
    return this._laborMarket;
  }

  get mcpAdapter(): MCPAdapter | undefined {
    return this._mcpAdapter;
  }

  get wire(): Wire {
    return this._wire;
  }

  get backgroundTasks(): BackgroundTaskManager | undefined {
    return this._backgroundTaskManager;
  }

  get planning(): PlanningManager | undefined {
    return this._planningManager;
  }

  get taskGraph(): TaskGraph {
    return this._taskGraph;
  }

  setSystemPrompt(prompt: string): void {
    this._state.systemPrompt = prompt;
  }

  setModel(model: ModelConfig): void {
    this._state.model = model;
  }

  setTools(tools: AgentTool[]): void {
    if (this._state.isRunning) {
      throw new Error("Cannot change tools while agent is running.");
    }
    this._state.tools = tools;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    if (this._state.isRunning) {
      throw new Error("Cannot change thinking level while agent is running.");
    }
    this._state.thinkingLevel = level;
  }

  async dispose(): Promise<void> {
    this.abort();
    this._listeners.clear();
    this._steeringQueue = [];
    this._followUpQueue = [];
    await Promise.allSettled(this._createdSubagents.map((sub) => sub.dispose()));
    this._createdSubagents = [];
    this._approval.dispose();
    await this._mcpAdapter?.dispose();
    this._backgroundTaskManager?.dispose();
    this._taskGraph.dispose();
    this._wire.dispose();
  }

  // --- Internal ---

  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;

    // Init session and restore messages
    if (this._sessionManager) {
      await this._sessionManager.init();
      const ctx = this._sessionManager.buildSessionContext();
      if (ctx.messages.length > 0) {
        this._state.messages = ctx.messages;
      }
    }

    // Load extensions
    if (this._config.extensions?.length) {
      this._extensionRunner = new ExtensionRunner();
      await this._extensionRunner.loadExtensions(this._config.extensions);

      // Re-resolve provider if extensions registered one for the configured provider
      const extProviders = this._extensionRunner.getRegisteredProviders();
      const extFactory = extProviders.get(this._config.model.provider);
      if (extFactory) {
        try {
          this._provider = extFactory({
            apiKey: this._config.model.apiKey,
            baseUrl: this._config.model.baseUrl,
          });
        } catch {
          // Extension provider factory failed, keep the original provider
        }
      }
    }

    // Notify extensions of session start
    if (this._sessionManager && this._extensionRunner) {
      await this._extensionRunner.emitSimple("session_start", {
        sessionId: this._sessionManager.getSessionId(),
      });
    }

    // Load MCP tools in background
    if (this._mcpAdapter) {
      this._mcpAdapter.startLoading();
      await this._mcpAdapter.waitForReady();
    }

    // Discover skills and register skill tool
    if (this._config.skills?.length) {
      const skills = await discoverSkills(this._config.skills);
      if (skills.length > 0) {
        // Add skill list to system prompt for awareness
        const skillList = skills.map((s) => `- /${s.name}: ${s.description}`).join("\n");
        this._state.systemPrompt += `\n\nAvailable skills (use invoke_skill tool to invoke):\n${skillList}`;
        // Add built-in InvokeSkillTool so LLM can actually invoke skills
        this._state.tools = [...this._state.tools, createInvokeSkillTool(skills)];
      }
    }

    // Init fixed subagents and create TaskTool
    if (this._config.subagents && this._laborMarket && this._taskExecutor) {
      for (const [name, subConfig] of Object.entries(this._config.subagents)) {
        const subModel = subConfig.model ?? this._config.model;
        const subProvider = subConfig.model ? resolveProvider(subConfig.model) : this._provider;
        const subAgent = new Agent({
          model: subModel,
          systemPrompt: subConfig.systemPrompt,
          tools: subConfig.tools ?? [],
          provider: subProvider,
          approval: this._approval.share(),
          name,
        });
        this._createdSubagents.push(subAgent);
        this._laborMarket.addFixed(name, subAgent, subConfig.description);
      }
      // Add built-in TaskTool so LLM can delegate to subagents
      this._state.tools = [...this._state.tools, createTaskTool(this._laborMarket, this._taskExecutor)];
    }

    // Background task tools
    if (this._backgroundTaskManager) {
      const bgTools = createBackgroundTaskTools(this._backgroundTaskManager, this._config.backgroundTasks?.factories);
      this._state.tools = [...this._state.tools, ...bgTools];
    }

    // Planning tools + nag injection
    if (this._planningManager) {
      this._state.tools = [...this._state.tools, ...createPlanningTools(this._planningManager)];

      // Register nag provider into injection manager (create one if needed)
      this._addInjectionProvider(new PlanningNagProvider(this._planningManager));
    }

    // Task graph tools + result auto-injection
    this._state.tools = [...this._state.tools, ...createTaskGraphTools(this._taskGraph)];
    if (this._config.taskGraph?.autoInjectResults !== false) {
      this._addInjectionProvider(new TaskResultInjectionProvider(this._taskGraph));
    }

    this._initialized = true;
  }

  private _addInjectionProvider(provider: DynamicInjectionProvider): void {
    if (this._injectionManager) {
      this._injectionManager.addProvider(provider);
    } else {
      this._injectionManager = new InjectionManager([provider]);
    }
  }

  private _normalizeInput(input: string | AgentMessage | AgentMessage[]): AgentMessage[] {
    if (typeof input === "string") {
      const msg: UserMessage = { role: "user", content: input };
      return [msg];
    }
    if (Array.isArray(input)) return input;
    return [input];
  }

  private _emit(event: AgentEvent): void {
    for (const fn of this._listeners) {
      try {
        fn(event);
      } catch {
        // Listener errors should not break the loop
      }
    }
    this._wire.publish(event.type, event);
  }

  private async _runLoop(): Promise<AgentMessage[]> {
    this._state.isRunning = true;
    this._state.error = undefined;
    this._abortController = new AbortController();

    // Collect all tools: config tools + MCP tools + extension tools
    const mcpTools = this._mcpAdapter?.getAllTools() ?? [];
    const allConfigTools = [...this._state.tools, ...mcpTools];

    // Build compaction config with summarizer
    const compactionWithSummarizer = this._config.compaction ? {
      ...this._config.compaction,
      maxContextTokens: this._config.compaction.maxContextTokens ?? this._config.model.maxContextTokens,
      summarize: this._config.compaction.customSummarizer
        ? (msgs: AgentMessage[]) => this._config.compaction!.customSummarizer!.summarize(
            agentMessagesToCompactionInput(msgs),
          )
        : (msgs: AgentMessage[]) => {
            const summarizer = new LLMSummarizer(this._provider, this._state.model.model);
            return summarizer.summarize(agentMessagesToCompactionInput(msgs));
          },
    } : undefined;

    try {
      const result = await runAgentLoop(this._state.messages, {
        provider: this._provider,
        modelId: this._state.model.model,
        systemPrompt: this._state.systemPrompt,
        tools: allConfigTools,
        approval: this._approval,
        agentName: this._name,
        toolExecution: this._config.toolExecution ?? "parallel",
        maxStepsPerTurn: this._config.maxStepsPerTurn ?? 50,
        hooks: this._config.hooks,
        thinkingLevel: this._state.thinkingLevel,
        capabilities: this._state.model.capabilities,
        modelCost: this._state.model.cost,
        signal: this._abortController.signal,
        getSteeringMessages: () => {
          const msgs = [...this._steeringQueue];
          this._steeringQueue = [];
          return msgs;
        },
        getFollowUpMessages: () => {
          const msgs = [...this._followUpQueue];
          this._followUpQueue = [];
          return msgs;
        },
        onEvent: (event) => this._emit(event),

        // Integrated modules
        sessionManager: this._sessionManager,
        checkpointManager: this._checkpointManager,
        injectionManager: this._injectionManager,
        extensionRunner: this._extensionRunner,
        compaction: compactionWithSummarizer,
        planningManager: this._planningManager,
        maxContextTokens: this._config.model.maxContextTokens,
      });

      this._state.messages = result;
      return result;
    } catch (err) {
      this._state.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this._state.isRunning = false;
      this._abortController = null;
    }
  }
}
