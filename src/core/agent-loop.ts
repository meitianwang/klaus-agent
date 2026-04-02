// Agent loop — while (true) with State object, state = next; continue at every iteration site.
//
// Per-iteration order:
//   messagesForQuery ← microCompact(convertToLlm(allMessages))
//   → context collapse (applyCollapsesIfNeeded — before autocompact)
//   → autocompact check (uses post-collapse/micro token count, compacts inline, no continue)
//   → add injections to get contextForLlm
//   → rebuild system prompt
//   → hoist mediaRecoveryEnabled gate
//   → stream LLM (withhold: prompt_too_long, max_output_tokens, media_size)
//     → streaming tool executor: addTool() + getCompletedResults() during stream
//   → yield pendingToolUseSummary from previous turn
//   → if !needsFollowUp:
//       → prompt_too_long recovery:
//           1. context collapse drain (recoverFromOverflow — lighter, preserves granular context)
//           2. reactive compact (full summarization — fallback)
//       → max_output_tokens escalation (8k → 64k silent retry)
//       → max_output_tokens multi-turn recovery (up to 3 attempts)
//       → media size recovery (strip images + retry via reactive compact)
//       → skip afterTurn if API error
//       → afterTurn hooks (stop hooks) with stopHookActive
//       → token budget continuation
//       → D-Mail / steering / follow-up (klaus extensions)
//       → break (completed)
//   → tool execution (streaming executor getRemainingResults or batch)
//   → generate pendingToolUseSummary (async, resolved during next turn's model stream)
//   → abort check (after tools, before continue)
//   → D-Mail check (after tools)
//   → max turns check (at bottom, not top)
//   → state = { messagesForQuery + assistantMessages + toolResults }; continue

import type {
  AgentMessage,
  AgentEvent,
  AgentHooks,
  AfterTurnContext,
  Message,
  AssistantMessage,
  ToolResultMessage,
  ToolUseBlock,
  TokenUsage,
  UserMessage,
  ThinkingLevel,
  ModelCost,
} from "../types.js";
import type { AgentTool, CanUseToolFn } from "../tools/types.js";
import type { LLMProvider, LLMRequestOptions, ToolDefinition, AssistantMessageEvent, ContentBlock } from "../llm/types.js";
import type { Approval } from "../approval/types.js";
import type { SessionManager } from "../session/session-manager.js";
import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import type { InjectionManager } from "../injection/injection-manager.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { CompactionConfig } from "../compaction/types.js";
import type { PlanningManager } from "../planning/planning-manager.js";
import { PLANNING_TOOL_NAMES } from "../planning/types.js";
import type { MessageUpdateLazy } from "../tools/executor.js";
import { runToolsOrchestrated } from "../tools/orchestration.js";
import { StreamingToolExecutor, type MessageUpdate } from "../tools/streaming-executor.js";
import { estimateTokens, shouldCompact, findCutPoint, microCompact } from "../compaction/compaction.js";
import { ContextCollapseManager, type ContextCollapseConfig } from "../compaction/context-collapse.js";
import { isWithheldMediaSizeError, isMediaSizeError, stripImagesFromMessages } from "../compaction/media-recovery.js";
import { generateToolUseSummary, type ToolUseSummaryConfig, type ToolInfo } from "../services/tool-use-summary.js";
import { normalizeHistory } from "../injection/history-normalizer.js";
import { calculateCost } from "../providers/shared.js";
import { zodToJsonSchema } from "../utils/zodToJsonSchema.js";
import { createToolResultMessage, isToolResultMessage, getToolUseId } from "../utils/messages.js";
import type { SystemPromptBuilder } from "./system-prompt-builder.js";
import type { DeferredToolRegistry } from "../tools/deferred-tools.js";
import { enforceBudget } from "./context-budget.js";
import { applyToolResultBudget, provisionContentReplacementState, type ContentReplacementState } from "../tools/tool-result-storage.js";

export interface AgentLoopConfig {
  provider: LLMProvider;
  modelId: string;
  systemPrompt: string;
  tools: AgentTool[];
  approval: Approval;
  agentName: string;
  toolExecution: "sequential" | "parallel";
  maxStepsPerTurn: number;
  thinkingLevel?: ThinkingLevel;
  capabilities?: { vision?: boolean; thinking?: boolean };
  hooks?: AgentHooks;
  getSteeringMessages?: () => AgentMessage[];
  getFollowUpMessages?: () => AgentMessage[];
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;

  // Integrated modules (all optional)
  sessionManager?: SessionManager;
  checkpointManager?: CheckpointManager;
  injectionManager?: InjectionManager;
  extensionRunner?: ExtensionRunner;
  compaction?: CompactionConfig & { summarize?: (messages: AgentMessage[]) => Promise<string> };
  planningManager?: PlanningManager;
  modelCost?: ModelCost;
  maxContextTokens?: number;
  systemPromptBuilder?: SystemPromptBuilder;
  deferredToolRegistry?: DeferredToolRegistry;
  // Token budget continuation.
  outputTokenBudget?: number;

  /** Enable streaming tool execution during LLM streaming. */
  streamingToolExecution?: boolean;
  /** Context collapse configuration. When set, enables staged context collapse. */
  contextCollapse?: Omit<ContextCollapseConfig, "summarize"> & { summarize?: (messages: AgentMessage[]) => Promise<string> };
  /** Enable media size error recovery (strip images + retry). */
  mediaRecovery?: boolean;
  /** Tool use summary configuration. When set, generates summaries after tool execution. */
  toolUseSummary?: ToolUseSummaryConfig;
}

// Mutable cross-iteration state.
type LoopState = {
  allMessages: AgentMessage[];
  turnCount: number;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  maxOutputTokensOverride: number | undefined;
  stopHookActive: boolean | undefined;
  totalOutputTokens: number;
  lastApiInputTokens?: number;
  lastEstimatedInputTokens?: number;
  pendingToolUseSummary: Promise<string | null> | undefined;
  transition: { reason: string; [key: string]: unknown } | undefined;
};

// Maximum recovery attempts for max_output_tokens.
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

// Escalated output token limit for max_output_tokens recovery.
const ESCALATED_MAX_TOKENS = 64_000;

// Token budget continuation thresholds.
const BUDGET_COMPLETION_THRESHOLD = 0.9;
const BUDGET_DIMINISHING_MIN_DELTA = 500;

type BudgetTracker = {
  continuationCount: number;
  totalOutputTokens: number;
  lastTurnOutputTokens: number;
};

function createBudgetTracker(): BudgetTracker {
  return { continuationCount: 0, totalOutputTokens: 0, lastTurnOutputTokens: 0 };
}

function checkTokenBudget(
  tracker: BudgetTracker,
  budget: number,
  thisTurnOutputTokens: number,
): { action: "continue"; nudge: string } | { action: "stop" } {
  const delta = thisTurnOutputTokens - tracker.lastTurnOutputTokens;
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    delta < BUDGET_DIMINISHING_MIN_DELTA &&
    tracker.lastTurnOutputTokens < BUDGET_DIMINISHING_MIN_DELTA;

  if (!isDiminishing && thisTurnOutputTokens < budget * BUDGET_COMPLETION_THRESHOLD) {
    const pct = Math.round((thisTurnOutputTokens / budget) * 100);
    return {
      action: "continue",
      nudge: `Output token budget: ${pct}% used (${thisTurnOutputTokens.toLocaleString()} / ${budget.toLocaleString()}). Keep going — you have remaining budget to complete the task.`,
    };
  }
  return { action: "stop" };
}

// --- helpers ---

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m): m is Message =>
    typeof m === "object" && m !== null && "role" in m &&
    (m.role === "user" || m.role === "assistant"),
  );
}

function stripImages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role === "user" && Array.isArray(m.content)) {
      const filtered = m.content.filter((b) => b.type !== "image");
      return { ...m, content: filtered.length > 0 ? filtered : "[image removed — model does not support vision]" };
    }
    return m;
  });
}

async function toolsToDefinitions(tools: AgentTool[]): Promise<ToolDefinition[]> {
  return Promise.all(tools.map(async (t) => ({
    name: t.name,
    description: await t.description({}, { isNonInteractiveSession: false, toolPermissionContext: { mode: "default", additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }, tools }),
    inputSchema: (
      t.inputJSONSchema
        ? t.inputJSONSchema
        : zodToJsonSchema(t.inputSchema)
    ) as Record<string, unknown>,
  })));
}

function toolResultsToMessages(results: UserMessage[], assistantMessages: AssistantMessage[]): UserMessage[] {
  // With the new architecture, runToolUse yields UserMessage directly.
  // This function is now a pass-through for backward compatibility.
  return results;
}

/** Detect context length / token budget exceeded errors from any provider. */
function isContextOverflowError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("context window") ||
    msg.includes("maximum context length") ||
    msg.includes("token limit") ||
    msg.includes("too many tokens") ||
    msg.includes("request too large")
  );
}

/** Check if an assistant message is a withheld prompt-too-long error. */
function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  return msg.isApiErrorMessage === true && msg.apiError === "prompt_too_long";
}

/** Check if an assistant message is a withheld max_output_tokens error. */
function isWithheldMaxOutputTokens(msg: AssistantMessage | undefined): msg is AssistantMessage {
  return msg?.isApiErrorMessage === true && msg.apiError === "max_output_tokens";
}

/** Extract last assistant text for tool use summary context. */
function extractLastAssistantText(messages: AssistantMessage[]): string | undefined {
  const last = messages.at(-1);
  if (!last) return undefined;
  const textBlocks = last.content.filter((b) => b.type === "text");
  const lastText = textBlocks.at(-1);
  return lastText && "text" in lastText ? lastText.text : undefined;
}

export async function runAgentLoop(
  initialMessages: AgentMessage[],
  config: AgentLoopConfig,
): Promise<AgentMessage[]> {
  const { onEvent, sessionManager, checkpointManager, injectionManager, extensionRunner, compaction } = config;

  // Merge extension-registered tools with config tools.
  let allTools = extensionRunner
    ? [...config.tools, ...extensionRunner.getRegisteredTools()]
    : config.tools;

  // before_agent_start: extensions may override model, tools, system prompt.
  let { modelId, systemPrompt, thinkingLevel } = config;
  const keepRecentToolResults = compaction?.keepRecentToolResults ?? 3;

  if (extensionRunner) {
    const result = await extensionRunner.emitBeforeAgentStart({ systemPrompt, tools: allTools, modelId, thinkingLevel });
    if (result) {
      if (result.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      if (result.tools !== undefined) allTools = result.tools;
      if (result.modelId !== undefined) modelId = result.modelId;
      if (result.thinkingLevel !== undefined) thinkingLevel = result.thinkingLevel;
    }
  }

  onEvent({ type: "agent_start" });
  await extensionRunner?.emitSimple("agent_start");

  // Token budget tracker — loop-local, not per-iteration.
  const budgetTracker = config.outputTokenBudget != null ? createBudgetTracker() : null;

  // Context collapse manager — loop-local.
  const contextCollapse = config.contextCollapse && compaction?.summarize
    ? new ContextCollapseManager({
        maxContextTokens: config.contextCollapse.maxContextTokens ?? compaction?.maxContextTokens ?? 200_000,
        stageThreshold: config.contextCollapse.stageThreshold,
        commitThreshold: config.contextCollapse.commitThreshold,
        summarize: config.contextCollapse.summarize ?? compaction.summarize,
        minSpanSize: config.contextCollapse.minSpanSize,
      })
    : null;

  // Media recovery gate — hoisted once at entry, not per-turn.
  const mediaRecoveryEnabled = config.mediaRecovery ?? false;

  // Content replacement state for tool result budget enforcement.
  const contentReplacementState = provisionContentReplacementState(true);

  let state: LoopState = {
    allMessages: [...initialMessages],
    turnCount: 1,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    stopHookActive: undefined,
    totalOutputTokens: 0,
    pendingToolUseSummary: undefined,
    transition: undefined,
  };

  try {
    while (true) {
      let {
        allMessages,
        turnCount,
        maxOutputTokensRecoveryCount,
        hasAttemptedReactiveCompact,
        maxOutputTokensOverride,
        stopHookActive,
        totalOutputTokens,
        lastApiInputTokens,
        lastEstimatedInputTokens,
        pendingToolUseSummary,
      } = state;

      // --- Checkpoint ---
      if (checkpointManager) {
        const cp = await checkpointManager.checkpoint();
        onEvent({ type: "checkpoint", id: cp.checkpointId });
      }

      // ── Build messagesForQuery ────────────────────────────────────────────────
      let messagesForQuery: Message[] = defaultConvertToLlm([...allMessages]);

      // ── microCompact (BEFORE context collapse and autocompact) ────────────────
      messagesForQuery = microCompact(messagesForQuery, keepRecentToolResults);

      // ── Context collapse (BEFORE autocompact) ─────────────────────────────────
      // Context collapse runs after microcompact but before autocompact threshold checks.
      if (contextCollapse) {
        const collapseResult = await contextCollapse.applyCollapsesIfNeeded(messagesForQuery, allMessages);
        messagesForQuery = collapseResult.messages;
      }

      // ── Autocompact (inline — no continue) ────────────────────────────────────
      if (compaction?.enabled !== false && compaction?.maxContextTokens) {
        const tokens = estimateTokens(messagesForQuery);
        const reserve = compaction.reserveTokens ?? 16384;
        if (shouldCompact(tokens, compaction.maxContextTokens, reserve)) {
          onEvent({ type: "compaction_start" });

          const extResult = await extensionRunner?.emitBeforeCompact({ messages: allMessages });
          if (!extResult?.skip) {
            const keepTokens = compaction.keepRecentTokens ?? 20000;
            const cutPoint = findCutPoint(allMessages, keepTokens);

            if (cutPoint.firstKeptIndex > 0) {
              const toDiscard = allMessages.slice(0, cutPoint.firstKeptIndex);
              const toKeep = allMessages.slice(cutPoint.firstKeptIndex);

              let summary = extResult?.summary ?? "";
              if (!summary && compaction.summarize) {
                summary = await compaction.summarize(toDiscard);
              }

              const compactedMessages: AgentMessage[] = [];
              if (summary) {
                compactedMessages.push({ role: "user", content: `<compaction-summary>${summary}</compaction-summary>` } as UserMessage);
              }
              compactedMessages.push(...toKeep);
              allMessages = compactedMessages;

              if (sessionManager) {
                await sessionManager.appendCompaction(summary, sessionManager.getLeafId() ?? "", tokens);
              }

              onEvent({ type: "compaction_end", summary });
              await extensionRunner?.emitSimple("after_compact", {
                summary,
                tokensBefore: tokens,
                tokensAfter: estimateTokens(allMessages),
              });

              messagesForQuery = microCompact(defaultConvertToLlm([...allMessages]), keepRecentToolResults);
            }
          }
        }
      }

      // ── Build contextForLlm ───────────────────────────────────────────────────
      // Tool result budget enforcement — after microCompact/context collapse, before LLM request.
      messagesForQuery = await applyToolResultBudget(messagesForQuery, contentReplacementState);

      let contextForLlm: Message[] = [...messagesForQuery];

      if (injectionManager) {
        const injections = await injectionManager.collectInjections(allMessages);
        if (injections.length > 0) {
          const injectionMessages = defaultConvertToLlm(injections);
          contextForLlm = [...messagesForQuery, ...injectionMessages];
        }
      }

      contextForLlm = normalizeHistory(contextForLlm);

      if (extensionRunner) {
        const ctxResult = await extensionRunner.emitContext({ messages: contextForLlm });
        if (ctxResult?.messages) contextForLlm = ctxResult.messages as Message[];
      }

      if (extensionRunner) {
        const extMsgs = extensionRunner.drainPendingMessages();
        if (extMsgs.length > 0) {
          allMessages = [...allMessages, ...extMsgs];
          contextForLlm = [...contextForLlm, ...defaultConvertToLlm(extMsgs)];
        }
      }

      onEvent({ type: "turn_start" });
      await extensionRunner?.emitSimple("turn_start");

      if (config.hooks?.transformContext) {
        contextForLlm = (await config.hooks.transformContext(contextForLlm)) as Message[];
      }
      if (config.hooks?.convertToLlm) {
        contextForLlm = config.hooks.convertToLlm(contextForLlm);
      }
      if (config.capabilities?.vision === false) {
        contextForLlm = stripImages(contextForLlm);
      }

      // ── Phase-aware tool filtering ────────────────────────────────────────────
      let visibleTools = allTools;
      if (config.planningManager?.phase === "planning" && config.planningManager.hasConfiguredReadOnlyTools) {
        visibleTools = allTools.filter((t) => config.planningManager!.allowedInPlanning.has(t.name));
      }

      // ── Budget enforcement + deferred tools ───────────────────────────────────
      let deferredToolNames: string[] = [];
      let maxTokens: number | undefined;
      if (config.maxContextTokens) {
        let calibrationRatio = 1.0;
        if (lastApiInputTokens && lastEstimatedInputTokens && lastEstimatedInputTokens > 0) {
          calibrationRatio = Math.max(0.5, Math.min(2.0, lastApiInputTokens / lastEstimatedInputTokens));
        }
        lastEstimatedInputTokens = estimateTokens(contextForLlm);

        const budgetResult = await enforceBudget(
          systemPrompt,
          visibleTools,
          contextForLlm,
          { maxContextTokens: config.maxContextTokens, reserveOutputTokens: 8192 },
          config.deferredToolRegistry,
          calibrationRatio,
        );
        visibleTools = budgetResult.activeTools;
        deferredToolNames = budgetResult.deferredNames;
        maxTokens = Math.max(4096, Math.min(16384, budgetResult.availableForOutput));
      } else if (config.deferredToolRegistry) {
        config.deferredToolRegistry.setTools(visibleTools);
        const partition = config.deferredToolRegistry.partition();
        visibleTools = partition.activeTools;
        deferredToolNames = partition.deferredNames;
      }

      // ── Rebuild system prompt ─────────────────────────────────────────────────
      let effectiveSystemPrompt = systemPrompt;
      if (config.systemPromptBuilder) {
        if (deferredToolNames.length > 0 && config.deferredToolRegistry) {
          config.systemPromptBuilder.set({
            key: "deferred-tools",
            content: config.deferredToolRegistry.formatDeferredSection(deferredToolNames),
            stability: "dynamic",
            priority: 90,
          });
        } else {
          config.systemPromptBuilder.remove("deferred-tools");
        }
        effectiveSystemPrompt = await config.systemPromptBuilder.rebuild();
      }

      // ── Build LLM request ─────────────────────────────────────────────────────
      const toolDefs = await toolsToDefinitions(visibleTools);
      let requestOptions: LLMRequestOptions = {
        model: modelId,
        systemPrompt: effectiveSystemPrompt,
        messages: contextForLlm,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        thinkingLevel: config.capabilities?.thinking !== false ? thinkingLevel : undefined,
        maxTokens,
        maxOutputTokensOverride,
        signal: config.signal,
        ...(config.systemPromptBuilder ? {
          systemPromptBlocks: config.systemPromptBuilder.buildCacheBlocks(),
        } : {}),
      };

      if (extensionRunner) {
        const reqResult = await extensionRunner.emitBeforeProviderRequest({
          model: requestOptions.model,
          systemPrompt: requestOptions.systemPrompt,
          messages: requestOptions.messages,
          tools: requestOptions.tools,
          thinkingLevel: requestOptions.thinkingLevel,
        });
        if (reqResult) {
          requestOptions = {
            ...requestOptions,
            ...(reqResult.systemPrompt !== undefined && { systemPrompt: reqResult.systemPrompt }),
            ...(reqResult.messages !== undefined && { messages: reqResult.messages }),
            ...(reqResult.tools !== undefined && { tools: reqResult.tools }),
            ...(reqResult.thinkingLevel !== undefined && { thinkingLevel: reqResult.thinkingLevel }),
          };
        }
      }

      // ── Create streaming tool executor if enabled ─────────────────────────────
      // Created once per turn, discarded on fallback.
      let streamingToolExecutor: StreamingToolExecutor | null = null;
      if (config.streamingToolExecution) {
        const loopAbortController = new AbortController();
        // Forward parent signal to loop-scoped controller
        if (config.signal.aborted) {
          loopAbortController.abort(config.signal.reason);
        } else {
          config.signal.addEventListener("abort", () => loopAbortController.abort(config.signal.reason), { once: true });
        }
        // Aligned with claude-code: constructor takes (toolDefinitions, canUseTool, toolUseContext)
        const defaultCanUseTool: CanUseToolFn = async (_tool, _input, _ctx, _msg, _id) => ({ behavior: "allow" as const });
        streamingToolExecutor = new StreamingToolExecutor(
          visibleTools,
          defaultCanUseTool,
          {
            options: {
              commands: [],
              debug: false,
              mainLoopModel: config.modelId,
              tools: visibleTools,
              verbose: false,
              thinkingConfig: { type: "disabled" },
              mcpClients: [],
              mcpResources: {},
              isNonInteractiveSession: true,
              agentDefinitions: { activeAgents: [], allAgents: [] },
            },
            abortController: loopAbortController,
            readFileState: { get: () => undefined, set() { return this; }, has: () => false, delete: () => false, clear: () => {}, get size() { return 0; } },
            getAppState: () => ({}),
            setAppState: () => {},
            setInProgressToolUseIDs: () => {},
            setResponseLength: () => {},
            updateFileHistoryState: () => {},
            updateAttributionState: () => {},
            messages: allMessages as any[],
          },
        );
      }

      // ── Stream LLM ────────────────────────────────────────────────────────────
      const assistantMessages: AssistantMessage[] = [];
      const toolUseBlocks: ToolUseBlock[] = [];
      const streamingToolResults: UserMessage[] = [];
      let needsFollowUp = false;
      let usage: TokenUsage | undefined;
      let messageStartEmitted = false;

      try {
        for await (const event of config.provider.stream(requestOptions)) {
          if (event.type === "done") {
            const msg = event.message;
            usage = event.usage;
            const cost = calculateCost(config.modelCost, event.usage);
            if (cost) usage.cost = cost;

            // ── Withhold check ──────────────────────────────────────────────
            // Per-message withholding: prompt_too_long, max_output_tokens, media_size
            // errors are suppressed from consumers until recovery is attempted.
            let withheld = false;

            if (msg.stopReason === "max_tokens") {
              msg.isApiErrorMessage = true;
              msg.apiError = "max_output_tokens";
              withheld = true;
            }
            if (mediaRecoveryEnabled && msg.isApiErrorMessage && msg.errorDetails && isMediaSizeError(msg.errorDetails)) {
              withheld = true;
            }

            assistantMessages.push(msg);

            if (!withheld) {
              onEvent({ type: "message_end", message: msg, usage });
              await extensionRunner?.emitSimple("message_end", { message: msg });
            }

            // Tool blocks already fed to streaming executor via tool_use_end
            // events during streaming. No need to re-feed from done message.
          } else if (event.type === "error") {
            onEvent({ type: "error", error: event.error });
            throw event.error;
          } else {
            if (!messageStartEmitted && (event.type === "text" || event.type === "tool_use_start" || event.type === "thinking")) {
              const partial: AssistantMessage = { role: "assistant", content: [] };
              onEvent({ type: "message_start", message: partial });
              await extensionRunner?.emitSimple("message_start", { message: partial });
              messageStartEmitted = true;
            }
            if (event.type === "tool_use_start") {
              needsFollowUp = true;
            }
            // Feed completed tool blocks to streaming executor immediately.
            // Feed completed tool blocks to streaming executor immediately;
            // tools start executing during streaming before the full response completes.
            if (event.type === "tool_use_end" && streamingToolExecutor && !config.signal.aborted) {
              const lastAssistant = assistantMessages[assistantMessages.length - 1] ?? { role: "assistant" as const, content: [] };
              streamingToolExecutor.addTool(event.block, lastAssistant);
            }
            onEvent({ type: "message_update", message: { role: "assistant", content: [] }, event });
          }

          // ── Yield completed streaming tool results during streaming ────────
          // Yield completed streaming tool results during the stream loop.
          if (streamingToolExecutor && !config.signal.aborted) {
            for (const update of streamingToolExecutor.getCompletedResults()) {
              if (update.message) streamingToolResults.push(update.message as UserMessage);
            }
          }
        }
      } catch (streamErr) {
        // ── Prompt-too-long (413) → synthesize withheld message ──────────────
        if (isContextOverflowError(streamErr) && !messageStartEmitted) {
          const syntheticMsg: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "Prompt is too long" }],
            stopReason: "end_turn",
            isApiErrorMessage: true,
            apiError: "prompt_too_long",
            errorDetails: (streamErr instanceof Error ? streamErr.message : String(streamErr)),
          };
          assistantMessages.push(syntheticMsg);
          needsFollowUp = false;
          // Discard streaming executor on error
          streamingToolExecutor?.discard();
          streamingToolExecutor = null;
        } else {
          streamingToolExecutor?.discard();
          throw streamErr;
        }
      }

      // Capture API-reported input tokens for calibration.
      if (usage?.inputTokens) lastApiInputTokens = usage.inputTokens;
      if (usage?.outputTokens) totalOutputTokens += usage.outputTokens;

      const lastAssistant = assistantMessages.at(-1);

      // ── Abort check (after streaming, before tool execution) ──────────────────
      // If aborted during streaming, consume remaining streaming executor results
      // (generates synthetic tool_results for queued/in-progress tools) and break.
      if (config.signal.aborted) {
        if (streamingToolExecutor) {
          for await (const update of streamingToolExecutor.getRemainingResults()) {
            // Consume synthetic results — tool_use blocks need matching tool_result blocks
            if (update.message) streamingToolResults.push(update.message as UserMessage);
          }
        }
        // Persist whatever we have
        for (const am of assistantMessages) {
          allMessages = [...allMessages, am];
          await sessionManager?.appendMessage(am);
        }
        const abortToolResults = toolResultsToMessages(streamingToolResults, assistantMessages);
        for (const rm of abortToolResults) {
          allMessages = [...allMessages, rm];
          await sessionManager?.appendMessage(rm);
        }
        state = { ...state, allMessages, totalOutputTokens };
        break;
      }

      // Extract tool calls from all assistant messages this turn.
      for (const am of assistantMessages) {
        if (!am.isApiErrorMessage) {
          for (const block of am.content) {
            if (block.type === "tool_use") {
              toolUseBlocks.push(block);
            }
          }
        }
      }
      needsFollowUp = toolUseBlocks.length > 0;

      // ── Yield pendingToolUseSummary from previous turn ────────────────────────
      // Summary (~1s) resolved during model streaming (5-30s).
      if (pendingToolUseSummary) {
        const summaryText = await pendingToolUseSummary;
        if (summaryText) {
          onEvent({ type: "tool_execution_end", toolUseId: "", toolName: "__summary", result: { data: [{ type: "text", text: summaryText }] }, isError: false });
        }
      }

      // ── No tool calls path ────────────────────────────────────────────────────
      if (!needsFollowUp) {
        // Persist assistant messages.
        for (const am of assistantMessages) {
          allMessages = [...allMessages, am];
          await sessionManager?.appendMessage(am);
        }

        // ── Prompt-too-long (413) recovery ──────────────────────────────────
        const isWithheld413 = lastAssistant && isPromptTooLongMessage(lastAssistant);
        const isWithheldMedia = mediaRecoveryEnabled && isWithheldMediaSizeError(lastAssistant);

        // Phase 1: Context collapse drain (lighter, preserves granular context).
        // Collapse drain fires BEFORE reactive compact,
        // gated on transition !== 'collapse_drain_retry'.
        if (isWithheld413 && contextCollapse && state.transition?.reason !== "collapse_drain_retry") {
          const drained = await contextCollapse.recoverFromOverflow(messagesForQuery, allMessages);
          if (drained.committed > 0) {
            state = {
              allMessages,
              turnCount,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              stopHookActive: undefined,
              totalOutputTokens,
              lastApiInputTokens,
              lastEstimatedInputTokens,
              pendingToolUseSummary: undefined,
              transition: { reason: "collapse_drain_retry", committed: drained.committed },
            };
            continue;
          }
        }

        // Phase 2: Reactive compact (full summarization — fallback for both 413 and media).
        if ((isWithheld413 || isWithheldMedia) && compaction?.summarize && !hasAttemptedReactiveCompact) {
          onEvent({ type: "compaction_start" });

          // For media errors, strip images before compacting.
          let compactionMessages = allMessages;
          if (isWithheldMedia) {
            compactionMessages = stripImagesFromMessages(defaultConvertToLlm(allMessages)) as AgentMessage[];
          }

          const emergencyKeepTokens = Math.floor((compaction.keepRecentTokens ?? 20000) / 2);
          const cutPoint = findCutPoint(compactionMessages, emergencyKeepTokens);

          if (cutPoint.firstKeptIndex > 0) {
            const toDiscard = compactionMessages.slice(0, cutPoint.firstKeptIndex);
            const toKeep = compactionMessages.slice(cutPoint.firstKeptIndex);
            const summary = await compaction.summarize(toDiscard);

            const compactedMessages: AgentMessage[] = [];
            if (summary) {
              compactedMessages.push({ role: "user", content: `<compaction-summary>${summary}</compaction-summary>` } as UserMessage);
            }
            compactedMessages.push(...toKeep);

            if (sessionManager) {
              await sessionManager.appendCompaction(summary, sessionManager.getLeafId() ?? "", estimateTokens(compactedMessages));
            }
            onEvent({ type: "compaction_end", summary });

            state = {
              allMessages: compactedMessages,
              turnCount,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact: true,
              maxOutputTokensOverride: undefined,
              stopHookActive: undefined,
              totalOutputTokens,
              lastApiInputTokens,
              lastEstimatedInputTokens,
              pendingToolUseSummary: undefined,
              transition: { reason: "reactive_compact_retry" },
            };
            continue;
          }
        }

        // 413/media recovery exhausted — surface and exit.
        if (isWithheld413 || isWithheldMedia) {
          onEvent({ type: "turn_end", message: lastAssistant!, toolResults: [] });
          await extensionRunner?.emitSimple("turn_end", { message: lastAssistant! });
          state = { ...state, allMessages, totalOutputTokens };
          break;
        }

        // Emit turn_end for non-error messages.
        if (!lastAssistant?.isApiErrorMessage) {
          onEvent({ type: "turn_end", message: lastAssistant ?? assistantMessages[0]!, toolResults: [] });
          await extensionRunner?.emitSimple("turn_end", { message: lastAssistant ?? assistantMessages[0]! });
        }

        // ── max_output_tokens escalation (8k → 64k) ────────────────────────
        if (isWithheldMaxOutputTokens(lastAssistant)) {
          if (maxOutputTokensOverride === undefined) {
            state = {
              allMessages,
              turnCount,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
              stopHookActive: undefined,
              totalOutputTokens,
              lastApiInputTokens,
              lastEstimatedInputTokens,
              pendingToolUseSummary: undefined,
              transition: { reason: "max_output_tokens_escalate" },
            };
            continue;
          }

          // ── max_output_tokens multi-turn recovery ─────────────────────────
          if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
            onEvent({ type: "message_end", message: lastAssistant, usage });
            await extensionRunner?.emitSimple("message_end", { message: lastAssistant });
            onEvent({ type: "turn_end", message: lastAssistant, toolResults: [] });
            await extensionRunner?.emitSimple("turn_end", { message: lastAssistant });

            const recoveryMsg: UserMessage = {
              role: "user",
              content:
                "Output token limit hit. Resume directly — no apology, no recap of what you were doing. " +
                "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
            };
            allMessages = [...allMessages, recoveryMsg];
            await sessionManager?.appendMessage(recoveryMsg);

            state = {
              allMessages,
              turnCount,
              maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              stopHookActive: undefined,
              totalOutputTokens,
              lastApiInputTokens,
              lastEstimatedInputTokens,
              pendingToolUseSummary: undefined,
              transition: { reason: "max_output_tokens_recovery" },
            };
            continue;
          }

          // Recovery exhausted — surface.
          onEvent({ type: "message_end", message: lastAssistant, usage });
          await extensionRunner?.emitSimple("message_end", { message: lastAssistant });
          onEvent({ type: "turn_end", message: lastAssistant, toolResults: [] });
          await extensionRunner?.emitSimple("turn_end", { message: lastAssistant });
        }

        // ── Skip afterTurn if API error ─────────────────────────────────────
        if (lastAssistant?.isApiErrorMessage) {
          state = { ...state, allMessages, totalOutputTokens };
          break;
        }

        // ── afterTurn hook (stop hooks) ─────────────────────────────────────
        if (config.hooks?.afterTurn && lastAssistant) {
          const afterTurnCtx: AfterTurnContext = { messages: allMessages, assistantMessage: lastAssistant, usage };
          const hookResult = await config.hooks.afterTurn(afterTurnCtx);
          if (hookResult) {
            if (hookResult.preventContinuation) {
              state = { ...state, allMessages, totalOutputTokens };
              break;
            }
            if ("blockingMessages" in hookResult && hookResult.blockingMessages.length > 0) {
              allMessages = [...allMessages, ...hookResult.blockingMessages];
              for (const bm of hookResult.blockingMessages) await sessionManager?.appendMessage(bm);
              state = {
                allMessages,
                turnCount,
                maxOutputTokensRecoveryCount: 0,
                hasAttemptedReactiveCompact,
                maxOutputTokensOverride: undefined,
                stopHookActive: true,
                totalOutputTokens,
                lastApiInputTokens,
                lastEstimatedInputTokens,
                pendingToolUseSummary: undefined,
                transition: { reason: "stop_hook_blocking" },
              };
              continue;
            }
          }
        }

        // ── Token budget continuation ───────────────────────────────────────
        if (budgetTracker && config.outputTokenBudget != null) {
          const decision = checkTokenBudget(budgetTracker, config.outputTokenBudget, totalOutputTokens);
          if (decision.action === "continue") {
            budgetTracker.continuationCount++;
            budgetTracker.lastTurnOutputTokens = totalOutputTokens;
            budgetTracker.totalOutputTokens = totalOutputTokens;
            const nudgeMsg: UserMessage = { role: "user", content: decision.nudge };
            allMessages = [...allMessages, nudgeMsg];
            await sessionManager?.appendMessage(nudgeMsg);
            state = {
              allMessages,
              turnCount,
              maxOutputTokensRecoveryCount: 0,
              hasAttemptedReactiveCompact: false,
              maxOutputTokensOverride: undefined,
              stopHookActive: undefined,
              totalOutputTokens,
              lastApiInputTokens,
              lastEstimatedInputTokens,
              pendingToolUseSummary: undefined,
              transition: { reason: "token_budget_continuation" },
            };
            continue;
          }
        }

        // ── D-Mail check (klaus extension) ──────────────────────────────────
        if (checkpointManager) {
          const dmailContent = await checkpointManager.handleDMail();
          if (dmailContent) {
            const checkpoints = checkpointManager.getAllCheckpoints();
            const targetCp = checkpoints.at(-1)?.checkpointId ?? 0;
            onEvent({ type: "dmail_received", checkpoint: targetCp, content: dmailContent });
            if (sessionManager) {
              allMessages = [...sessionManager.buildSessionContext().messages];
            }
            const dmailMsg: UserMessage = { role: "user", content: `<dmail>${dmailContent}</dmail>` };
            allMessages = [...allMessages, dmailMsg];
            await sessionManager?.appendMessage(dmailMsg);
            state = {
              allMessages,
              turnCount,
              maxOutputTokensRecoveryCount: 0,
              hasAttemptedReactiveCompact: false,
              maxOutputTokensOverride: undefined,
              stopHookActive: undefined,
              totalOutputTokens,
              lastApiInputTokens,
              lastEstimatedInputTokens,
              pendingToolUseSummary: undefined,
              transition: { reason: "dmail_received" },
            };
            continue;
          }
        }

        // ── Steering messages (klaus extension) ─────────────────────────────
        const steering = config.getSteeringMessages?.() ?? [];
        if (steering.length > 0) {
          allMessages = [...allMessages, ...steering];
          for (const sm of steering) await sessionManager?.appendMessage(sm);
          state = {
            allMessages,
            turnCount,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            stopHookActive: undefined,
            totalOutputTokens,
            lastApiInputTokens,
            lastEstimatedInputTokens,
            pendingToolUseSummary: undefined,
            transition: { reason: "steering_messages" },
          };
          continue;
        }

        // ── Follow-up messages (klaus extension) ────────────────────────────
        const followUps = config.getFollowUpMessages?.() ?? [];
        if (followUps.length > 0) {
          allMessages = [...allMessages, ...followUps];
          for (const fm of followUps) await sessionManager?.appendMessage(fm);
          state = {
            allMessages,
            turnCount,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            stopHookActive: undefined,
            totalOutputTokens,
            lastApiInputTokens,
            lastEstimatedInputTokens,
            pendingToolUseSummary: undefined,
            transition: { reason: "follow_up_messages" },
          };
          continue;
        }

        // Nothing more to do — exit.
        state = { ...state, allMessages, totalOutputTokens };
        break;
      }

      // ── Tool execution ────────────────────────────────────────────────────────
      // Persist assistant messages before executing tools.
      for (const am of assistantMessages) {
        allMessages = [...allMessages, am];
        await sessionManager?.appendMessage(am);
      }

      // Execute tools — streaming executor (remaining) or batch.
      let toolCallResults: UserMessage[];

      if (streamingToolExecutor) {
        // Consume remaining results from streaming executor.
        // Results already obtained during streaming are in streamingToolResults.
        const remaining: UserMessage[] = [];
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) remaining.push(update.message as UserMessage);
        }
        toolCallResults = [...streamingToolResults, ...remaining];
      } else {
        // Batch execution with orchestrated partitioning.
        // Aligned with claude-code's toolOrchestration.ts: consecutive concurrent-safe
        // tools run in parallel batches (with concurrency limit), non-concurrent tools
        // run serially one at a time.
        const toolCallResultsBatch: UserMessage[] = [];
        for await (const update of runToolsOrchestrated(toolUseBlocks, {
          tools: visibleTools,
          canUseTool: (async (_tool, _input, _ctx, _msg, _id) => ({ behavior: "allow" as const })) as CanUseToolFn,
          toolUseContext: {
            options: {
              commands: [],
              debug: false,
              mainLoopModel: config.modelId,
              tools: visibleTools,
              verbose: false,
              thinkingConfig: { type: "disabled" },
              mcpClients: [],
              mcpResources: {},
              isNonInteractiveSession: true,
              agentDefinitions: { activeAgents: [], allAgents: [] },
            },
            abortController: new AbortController(),
            readFileState: { get: () => undefined, set() { return this; }, has: () => false, delete: () => false, clear: () => {}, get size() { return 0; } },
            getAppState: () => ({}),
            setAppState: () => {},
            setInProgressToolUseIDs: () => {},
            setResponseLength: () => {},
            updateFileHistoryState: () => {},
            updateAttributionState: () => {},
            messages: allMessages as any[],
          },
          assistantMessage: assistantMessages[assistantMessages.length - 1] ?? { role: "assistant" as const, content: [] },
        })) {
          if (update.message) toolCallResultsBatch.push(update.message as UserMessage);
        }
        toolCallResults = toolCallResultsBatch;
      }

      const toolResultMessages = toolResultsToMessages(toolCallResults, assistantMessages);
      for (const rm of toolResultMessages) {
        allMessages = [...allMessages, rm];
        await sessionManager?.appendMessage(rm);
      }

      // Planning: tick round counter.
      if (config.planningManager) {
        const calledTodo = toolUseBlocks.some((tc) => tc.name === PLANNING_TOOL_NAMES.todo);
        if (!calledTodo) config.planningManager.tickRound();
      }

      onEvent({ type: "turn_end", message: lastAssistant ?? assistantMessages[0]!, toolResults: toolResultMessages });
      await extensionRunner?.emitSimple("turn_end", { message: lastAssistant ?? assistantMessages[0]! });

      // ── Generate tool use summary (async, for next turn) ──────────────────────
      // Promise created here, awaited in next iteration during model streaming.
      let nextPendingToolUseSummary: Promise<string | null> | undefined;
      if (config.toolUseSummary?.enabled && toolUseBlocks.length > 0 && !config.signal.aborted) {
        const lastText = extractLastAssistantText(assistantMessages);
        // Build ToolInfo[] from toolUseBlocks + toolCallResults (matching by tool_use_id)
        const tools: ToolInfo[] = toolUseBlocks.map((block) => {
          const resultMsg = toolCallResults.find((msg) => {
            if (typeof msg.content === "string") return false;
            return Array.isArray(msg.content) && msg.content.some(
              (b: any) => b.type === "tool_result" && b.tool_use_id === block.id,
            );
          });
          return {
            name: block.name,
            input: block.input,
            output: resultMsg ? (resultMsg.toolUseResult ?? resultMsg.content) : undefined,
          };
        });
        nextPendingToolUseSummary = generateToolUseSummary(
          {
            tools,
            signal: config.signal,
            isNonInteractiveSession: config.toolUseSummary.isNonInteractiveSession ?? false,
            lastAssistantText: lastText,
          },
          config.toolUseSummary,
        );
      }

      // ── Abort check (after tool execution, before continue) ───────────────────
      // Check maxTurns before returning on abort.
      if (config.signal.aborted) {
        const nextTurnCountOnAbort = turnCount + 1;
        if (nextTurnCountOnAbort > config.maxStepsPerTurn) {
          const limitMsg: UserMessage = {
            role: "user",
            content: `<system-reminder>Step limit reached (${config.maxStepsPerTurn} steps). The agent loop will stop after this turn.</system-reminder>`,
          };
          allMessages = [...allMessages, limitMsg];
          await sessionManager?.appendMessage(limitMsg);
        }
        state = { ...state, allMessages, totalOutputTokens };
        break;
      }

      // ── D-Mail check (after tool execution) ───────────────────────────────────
      if (checkpointManager) {
        const dmailContent = await checkpointManager.handleDMail();
        if (dmailContent) {
          const checkpoints = checkpointManager.getAllCheckpoints();
          const targetCp = checkpoints.at(-1)?.checkpointId ?? 0;
          onEvent({ type: "dmail_received", checkpoint: targetCp, content: dmailContent });
          if (sessionManager) {
            allMessages = [...sessionManager.buildSessionContext().messages];
          }
          const dmailMsg: UserMessage = { role: "user", content: `<dmail>${dmailContent}</dmail>` };
          allMessages = [...allMessages, dmailMsg];
          await sessionManager?.appendMessage(dmailMsg);
          state = {
            allMessages,
            turnCount: turnCount + 1,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            stopHookActive,
            totalOutputTokens,
            lastApiInputTokens,
            lastEstimatedInputTokens,
            pendingToolUseSummary: nextPendingToolUseSummary,
            transition: { reason: "dmail_received" },
          };
          continue;
        }
      }

      // ── Max turns check (at bottom) ───────────────────────────────────────────
      const nextTurnCount = turnCount + 1;
      if (nextTurnCount > config.maxStepsPerTurn) {
        const limitMsg: UserMessage = {
          role: "user",
          content: `<system-reminder>Step limit reached (${config.maxStepsPerTurn} steps). The agent loop will stop after this turn. Please wrap up your current work and provide a summary of progress so far.</system-reminder>`,
        };
        allMessages = [...allMessages, limitMsg];
        await sessionManager?.appendMessage(limitMsg);
        state = { ...state, allMessages };
        break;
      }

      // ── Continue site ─────────────────────────────────────────────────────────
      // Advance state for next iteration.
      state = {
        allMessages,
        turnCount: nextTurnCount,
        maxOutputTokensRecoveryCount: 0,
        hasAttemptedReactiveCompact: false,
        maxOutputTokensOverride: undefined,
        stopHookActive,
        totalOutputTokens,
        lastApiInputTokens,
        lastEstimatedInputTokens,
        pendingToolUseSummary: nextPendingToolUseSummary,
        transition: { reason: "next_turn" },
      };
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      onEvent({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
    onEvent({ type: "agent_end", messages: state.allMessages });
    await extensionRunner?.emitSimple("agent_end", { messages: state.allMessages });
    if (!isAbort) throw err;
    return state.allMessages;
  }

  onEvent({ type: "agent_end", messages: state.allMessages });
  await extensionRunner?.emitSimple("agent_end", { messages: state.allMessages });
  return state.allMessages;
}
