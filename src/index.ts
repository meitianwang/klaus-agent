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
import type { TaskGraphConfig } from "./task-graph/types.js";
import type { PromptSection } from "./core/system-prompt-builder.js";
import type { DeferredToolsConfig } from "./tools/deferred-tools.js";

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
  taskGraph?: TaskGraphConfig;

  // System prompt sections for structured assembly
  promptSections?: PromptSection[];
  // Deferred tools for progressive disclosure
  deferredTools?: DeferredToolsConfig;

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
    taskGraph: config.taskGraph,
    promptSections: config.promptSections,
    deferredTools: config.deferredTools,
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
export { runToolUse, createChildAbortController, classifyToolError } from "./tools/executor.js";
export type { MessageUpdateLazy, McpServerType } from "./tools/executor.js";
export { runPreToolUseHooks, runPostToolUseHooks, runPostToolUseFailureHooks, resolveHookPermissionDecision } from "./tools/tool-hooks.js";
export type { PreToolHookYield, PostToolHookYield, PostToolUseHooksResult } from "./tools/tool-hooks.js";
export type { HookExecutor, AggregatedHookResult, ExtensionRunnerHookExecutor } from "./hooks/hook-executor.js";
export { runTools, runToolsOrchestrated, partitionToolCalls } from "./tools/orchestration.js";
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
export { MCPAdapter, McpSessionExpiredError, McpAuthError, McpToolCallError, buildMcpToolName, normalizeNameForMCP } from "./tools/mcp-adapter.js";
export { estimateTokens, shouldCompact, findCutPoint, microCompact } from "./compaction/compaction.js";
export { calculateCost } from "./providers/shared.js";
export { LLMSummarizer } from "./compaction/summarizer.js";
export { Wire } from "./wire/wire.js";
export { BackgroundTaskManager } from "./background/task-manager.js";
export { createBackgroundTaskTools } from "./background/tools.js";
export { PlanningManager } from "./planning/planning-manager.js";
export { createPlanningTools } from "./planning/tools.js";
export { PlanningNagProvider } from "./planning/nag-injection.js";
export { TaskGraph } from "./task-graph/task-graph.js";
export { createTaskGraphTools } from "./task-graph/tools.js";
export { TaskResultInjectionProvider } from "./task-graph/result-injection.js";
export { SystemPromptBuilder } from "./core/system-prompt-builder.js";
export { DeferredToolRegistry } from "./tools/deferred-tools.js";
export { enforceBudget, estimateToolTokens } from "./core/context-budget.js";
export {
  ToolUsageReminderProvider,
  PeriodicReminderProvider,
  OneShotReminderProvider,
  ConditionalReminderProvider,
} from "./injection/system-reminders.js";

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
} from "./types.js";

// Tool types
export type {
  AgentToolResult,
  AgentToolDef,
  AgentTools,
  ToolExecutionContext,
  CanUseToolFn,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  PostToolUseFailureContext,
  PostToolUseFailureResult,
  ValidationResult,
  PermissionResult,
  PermissionMode,
  PermissionBehavior,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionUpdate,
  PermissionDecisionReason,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
  AdditionalWorkingDirectory,
  ToolProgressData,
  ToolProgress,
  ToolCallProgress,
  ToolInputJSONSchema,
  SpinnerMode,
  SDKStatus,
  CompactProgressEvent,
  QueryChainTracking,
  PromptRequest,
  PromptResponse,
  AgentId,
  FileStateCache,
  FileHistoryState,
  AttributionState,
  DenialTrackingState,
  ThinkingConfig,
  SystemPrompt,
  MCPServerConnection,
  ServerResource,
  AgentDefinition,
  AgentDefinitionsResult,
  AgentToolUpdateCallback,
} from "./tools/types.js";
export { buildTool, toolMatchesName, findToolByName, DEFAULT_MAX_RESULT_SIZE_CHARS, getEmptyToolPermissionContext, filterToolProgressMessages } from "./tools/types.js";

// New permission/classifier types (aligned with claude-code)
export type {
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionRule,
  PermissionUpdateDestination,
  PermissionDecision,
  PendingClassifierCheck,
  PermissionCommandMetadata,
  PermissionMetadata,
  ContentBlockParam,
  ClassifierResult,
  ClassifierBehavior,
  ClassifierUsage,
  YoloClassifierResult,
  RiskLevel,
  PermissionExplanation,
  WorkingDirectorySource,
} from "./tools/types.js";

// Tool result storage types
export type {
  PersistedToolResult,
  PersistToolResultError,
  ContentReplacementState,
  ContentReplacementRecord,
  ToolResultReplacementRecord,
} from "./tools/tool-result-storage.js";
export type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "./tools/types.js";
export {
  configureToolResultStorage,
  persistToolResult,
  buildLargeToolResultMessage,
  enforceToolResultBudget,
  applyToolResultBudget,
  createContentReplacementState,
  cloneContentReplacementState,
  reconstructContentReplacementState,
  reconstructForSubagentResume,
  provisionContentReplacementState,
  configurePerToolThresholdOverrides,
  configurePerMessageBudgetLimit,
  getPerMessageBudgetLimit,
  getFileSystemErrorMessage,
  generatePreview,
  isToolResultContentEmpty,
  getPersistenceThreshold,
  processToolResultBlock,
  processPreMappedToolResultBlock,
} from "./tools/tool-result-storage.js";

// Orchestration types
export type { OrchestratedToolConfig, OrchestratedUpdate, MessageUpdate } from "./tools/orchestration.js";

// Deferred tool utilities
export { isDeferredTool, buildSchemaNotSentHint, formatDeferredToolLine } from "./tools/deferred-tools.js";
export type { DeferredToolsDelta } from "./tools/deferred-tools.js";
export { parseGitCommitId } from "./utils/gitOperationTracking.js";
export type { AttachmentMessage, HookAttachment, HookBlockingError } from "./llm/types.js";
export { generateToolUseSummary, createToolUseSummaryMessage } from "./services/tool-use-summary.js";
export type { ToolUseSummaryConfig, ToolInfo, GenerateToolUseSummaryParams } from "./services/tool-use-summary.js";

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
  ToolResultBlock,
  Message,
  TokenUsage,
  ModelCost,
  UsageCost,
  ContentBlock,
  TextContent,
  ImageContent,
  ToolUseBlock,
  ToolCallBlock,
  ToolDefinition,
  StopReason,
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
export type {
  MCPServerConfig,
  MCPTransport,
  MCPServerStatus,
  MCPClient,
  MCPAdapterOptions,
  MCPElicitationHandler,
  MCPToolCollapseClassifier,
  MCPToolFilter,
} from "./tools/mcp-adapter.js";
export { defaultMCPToolFilter } from "./tools/mcp-adapter.js";

// Message constants and utilities
export {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  PLAN_REJECTION_PREFIX,
  DENIAL_WORKAROUND_GUIDANCE,
  AUTO_REJECT_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  SYNTHETIC_MODEL,
  SYNTHETIC_MESSAGES,
  isClassifierDenial,
  buildYoloRejectionMessage,
  buildClassifierUnavailableMessage,
  isSyntheticMessage,
  deriveShortMessageId,
  wrapToolUseError,
  withMemoryCorrectionHint,
  configureAutoMemory,
  ensureToolResultPairing,
  createToolResultMessage,
  isToolResultMessage,
  getToolResultBlocks,
  getToolUseId,
  getToolResultContent,
  isToolResultError,
} from "./utils/messages.js";

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
export { TASK_GRAPH_TOOL_NAMES } from "./task-graph/types.js";

// Task graph types
export type {
  TaskGraphConfig,
  TaskNode,
  TaskStatus,
  CompletedTaskResult,
} from "./task-graph/types.js";

// System prompt builder types
export type { PromptSection, Stability, SectionCollector } from "./core/system-prompt-builder.js";

// Deferred tools types
export type { DeferredToolsConfig } from "./tools/deferred-tools.js";

// Context budget types
export type { ContextBudget, BudgetResult } from "./core/context-budget.js";

// System reminder types
export type {
  ToolUsageReminderConfig,
  PeriodicReminderConfig,
  ConditionalReminderConfig,
} from "./injection/system-reminders.js";
