// Public API surface

import { Agent, type AgentConfig as InternalAgentConfig } from "./core/agent.js";
import { ApprovalImpl } from "./approval/approval.js";
import { resolveProvider, registerProvider } from "./llm/provider.js";
import type { AgentTool } from "./tools/types.js";
import type { AgentMessage, AgentEvent, AgentState, AgentHooks, ModelConfig, ThinkingLevel, ApprovalConfig } from "./types.js";
import type { LLMProvider } from "./llm/types.js";
import type { SessionConfig } from "./session/types.js";
import type { CompactionConfig } from "./compaction/types.js";
import type { CheckpointConfig } from "./checkpoint/types.js";
import type { DynamicInjectionProvider } from "./injection/types.js";
import type { ExtensionFactory } from "./extensions/types.js";
import type { SubagentConfig } from "./multi-agent/types.js";
import type { SkillSource } from "./skills/types.js";
import type { MCPServerConfig, MCPClient } from "./tools/mcp-adapter.js";
import type { TaskFactory } from "./background/types.js";
import type { PlanningConfig } from "./planning/types.js";

export interface CreateAgentConfig {
  // Required
  model: ModelConfig;
  systemPrompt: string | (() => string | Promise<string>);
  tools: AgentTool[];

  // Optional
  name?: string;
  approval?: ApprovalConfig;
  thinkingLevel?: ThinkingLevel;
  toolExecution?: "sequential" | "parallel";
  maxStepsPerTurn?: number;
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
  planning?: PlanningConfig;

  // Advanced: provide your own LLM provider
  provider?: LLMProvider;
}

export function createAgent(config: CreateAgentConfig): Agent {
  const provider = config.provider ?? resolveProvider(config.model);
  const approval = new ApprovalImpl(config.approval);

  return new Agent({
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    provider,
    approval,
    name: config.name,
    toolExecution: config.toolExecution,
    maxStepsPerTurn: config.maxStepsPerTurn,
    thinkingLevel: config.thinkingLevel,
    hooks: config.hooks,
    session: config.session,
    compaction: config.compaction,
    checkpoint: config.checkpoint,
    injection: config.injection,
    extensions: config.extensions,
    subagents: config.subagents,
    skills: config.skills,
    mcp: config.mcp,
    wire: config.wire,
    backgroundTasks: config.backgroundTasks,
    planning: config.planning,
  });
}

// Re-export classes
export { Agent } from "./core/agent.js";
export { ApprovalImpl } from "./approval/approval.js";
export { registerProvider, resolveProvider } from "./llm/provider.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenAIProvider } from "./providers/openai.js";
export { OpenAIResponsesProvider } from "./providers/openai-responses.js";
export { GeminiProvider } from "./providers/google.js";
export { executeToolCalls } from "./tools/executor.js";
export { SessionManager } from "./session/session-manager.js";
export { buildSessionContext } from "./session/session-context-builder.js";
export { CheckpointManager } from "./checkpoint/checkpoint-manager.js";
export { DenwaRenji } from "./checkpoint/dmail.js";
export { InjectionManager } from "./injection/injection-manager.js";
export { normalizeHistory } from "./injection/history-normalizer.js";
export { LaborMarket } from "./multi-agent/labor-market.js";
export { TaskExecutor } from "./multi-agent/task-executor.js";
export { ExtensionRunner } from "./extensions/runner.js";
export { discoverSkills } from "./skills/discovery.js";
export { loadSkill, renderSkillTemplate } from "./skills/loader.js";
export { MCPAdapter } from "./tools/mcp-adapter.js";
export { estimateTokens, shouldCompact, findCutPoint } from "./compaction/compaction.js";
export { calculateCost } from "./providers/shared.js";
export { LLMSummarizer } from "./compaction/summarizer.js";
export { Wire } from "./wire/wire.js";
export { BackgroundTaskManager } from "./background/task-manager.js";
export { createBackgroundTaskTools } from "./background/tools.js";
export { PlanningManager } from "./planning/planning-manager.js";
export { createPlanningTools } from "./planning/tools.js";
export { PlanningNagProvider } from "./planning/nag-injection.js";

// Core types
export type {
  AgentMessage,
  AgentEvent,
  AgentState,
  AgentHooks,
  ModelConfig,
  ThinkingLevel,
  AgentTool,
  ApprovalConfig,
  CustomAgentMessages,
} from "./types.js";

// Tool types
export type {
  AgentToolResult,
  ToolExecutionContext,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "./tools/types.js";

// Approval types
export type {
  Approval,
  ApprovalRequest,
  ApprovalResponse,
} from "./approval/types.js";

// LLM types
export type {
  LLMProvider,
  LLMProviderFactory,
  LLMRequestOptions,
  AssistantMessage,
  AssistantMessageEvent,
  UserMessage,
  ToolResultMessage,
  Message,
  TokenUsage,
  ModelCost,
  UsageCost,
  ContentBlock,
  TextContent,
  ImageContent,
  ToolCallBlock,
  ToolDefinition,
} from "./llm/types.js";

// Session types
export type {
  SessionEntry,
  SessionMessageEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CheckpointEntry,
  SessionTreeNode,
  SessionContext,
  SessionConfig,
} from "./session/types.js";

// Compaction types
export type {
  CompactionConfig,
  CompactionSummarizer,
  CompactionResult,
} from "./compaction/types.js";

// Checkpoint types
export type {
  CheckpointConfig,
  DMail,
  CheckpointInfo,
} from "./checkpoint/types.js";

// Injection types
export type {
  DynamicInjection,
  DynamicInjectionProvider,
} from "./injection/types.js";

// Multi-agent types
export type { SubagentConfig } from "./multi-agent/types.js";

// Extension types
export type {
  ExtensionFactory,
  ExtensionAPI,
  ExtensionEventType,
  ExtensionEventMap,
  ExtensionHandler,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeProviderRequestEvent,
  BeforeProviderRequestResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  ContextEvent,
  ContextEventResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  AfterCompactEvent,
  SessionEvent,
} from "./extensions/types.js";

// Skill types
export type { Skill, SkillSource } from "./skills/types.js";

// MCP types
export type { MCPServerConfig, MCPTransport, MCPServerStatus, MCPClient } from "./tools/mcp-adapter.js";

// Wire types
export type { WireMessage, WireSubscriber, WireSubscription } from "./wire/types.js";

// Background task types
export type {
  BackgroundTaskStatus,
  BackgroundTaskInfo,
  BackgroundTaskHandle,
  BackgroundTaskEvent,
  TaskFactory,
} from "./background/types.js";

// Planning types
export type {
  PlanningConfig,
  PlanPhase,
  TodoItem,
  TodoStatus,
} from "./planning/types.js";

export { PLANNING_TOOL_NAMES } from "./planning/types.js";
