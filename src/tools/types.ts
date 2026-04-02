// Tool system types — fully aligned with claude-code's Tool.ts
//
// Uses SDK-appropriate type substitutions where direct imports aren't available:
//   React.ReactNode  → unknown
//   ThemeName        → string
//   keyof Theme      → string
//   Command          → unknown
//   AppState         → Record<string, unknown>
//   ToolResultBlockParam/ToolUseBlockParam → local equivalents

import type { z } from "zod/v4";
import type { ContentBlock, TextContent, ImageContent, Message, UserMessage, AssistantMessage, AttachmentMessage, SystemMessage, ProgressMessage, HookProgress } from "../llm/types.js";

// Hook-related types (TelemetrySafeError, PermissionRequestResult,
// BeforeToolCallContext, etc.) are in ./hook-types.ts
export type {
  TelemetrySafeError,
  PermissionRequestResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  PostToolUseFailureContext,
  PostToolUseFailureResult,
} from "./hook-types.js";

/**
 * Base constraint for tool input schemas — any Zod type that produces an object.
 * Aligned with claude-code's AnyObject = z.ZodType<{ [key: string]: unknown }>.
 */
export type AnyObject = z.ZodType<{ [key: string]: unknown }>;

// --- CanUseToolFn (permission check callback from hook system) ---

/**
 * Callback that determines whether a tool can be used with the given input.
 * Aligned with claude-code's CanUseToolFn from hooks/useCanUseTool.
 * Returns a PermissionDecision with the full tool/context information.
 */
export type CanUseToolFn = (
  tool: AgentTool,
  input: Record<string, unknown>,
  toolUseContext: ToolExecutionContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision,
) => Promise<PermissionDecision>;

// --- Validation ---

export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number };

// --- Permission types ---

export type PermissionBehavior = "allow" | "deny" | "ask";

/**
 * Permission mode controls how tool permissions are resolved.
 * - 'default': standard interactive approval
 * - 'bypassPermissions': all tools auto-approved (YOLO mode)
 * - 'acceptEdits': auto-approve file edits, ask for others
 * - 'plan': read-only tools only
 * - 'auto': automated approval via classifier
 * - 'bubble': bubble up to parent agent
 * - 'dontAsk': deny rather than ask
 */
export type PermissionMode =
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bubble"
  | "dontAsk";

// --- Permission rule types (aligned with claude-code's permissions.ts) ---

/**
 * Where a permission rule originated from.
 */
export type PermissionRuleSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings"
  | "cliArg"
  | "command"
  | "session";

/**
 * The value of a permission rule - specifies which tool and optional content.
 */
export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

/**
 * A permission rule with its source and behavior.
 */
export type PermissionRule = {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
};

/**
 * Where a permission update should be persisted.
 */
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

/**
 * Update operations for permission configuration.
 * Aligned with claude-code: 6-variant discriminated union.
 */
export type PermissionUpdate =
  | {
      type: "addRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "replaceRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "removeRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "setMode";
      destination: PermissionUpdateDestination;
      mode: PermissionMode;
    }
  | {
      type: "addDirectories";
      destination: PermissionUpdateDestination;
      directories: string[];
    }
  | {
      type: "removeDirectories";
      destination: PermissionUpdateDestination;
      directories: string[];
    };

/**
 * Explanation of why a permission decision was made.
 * Aligned with claude-code: 12-variant discriminated union.
 */
export type PermissionDecisionReason =
  | {
      type: "rule";
      rule: PermissionRule;
    }
  | {
      type: "mode";
      mode: PermissionMode;
    }
  | {
      type: "subcommandResults";
      reasons: Map<string, PermissionResult>;
    }
  | {
      type: "permissionPromptTool";
      permissionPromptToolName: string;
      toolResult: unknown;
    }
  | {
      type: "hook";
      hookName: string;
      hookSource?: string;
      reason?: string;
    }
  | {
      type: "asyncAgent";
      reason: string;
    }
  | {
      type: "sandboxOverride";
      reason: "excludedCommand" | "dangerouslyDisableSandbox";
    }
  | {
      type: "classifier";
      classifier: string;
      reason: string;
    }
  | {
      type: "workingDir";
      reason: string;
    }
  | {
      type: "safetyCheck";
      reason: string;
      classifierApprovable: boolean;
    }
  | {
      type: "other";
      reason: string;
    };

/**
 * Metadata for a pending classifier check that will run asynchronously.
 * Used to enable non-blocking allow classifier evaluation.
 * Aligned with claude-code's PendingClassifierCheck.
 */
export type PendingClassifierCheck = {
  command: string;
  cwd: string;
  descriptions: string[];
};

/**
 * Minimal command shape for permission metadata.
 * Aligned with claude-code's PermissionCommandMetadata.
 */
export type PermissionCommandMetadata = {
  name: string;
  description?: string;
  [key: string]: unknown;
};

/**
 * Metadata attached to permission decisions.
 * Aligned with claude-code's PermissionMetadata.
 */
export type PermissionMetadata =
  | { command: PermissionCommandMetadata }
  | undefined;

/**
 * Content block parameter type for permission decision content.
 * Simplified from Anthropic SDK's ContentBlockParam — we only need the shape.
 */
export type ContentBlockParam = {
  type: string;
  [key: string]: unknown;
};

export type PermissionAllowDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  behavior: "allow";
  updatedInput?: Input;
  userModified?: boolean;
  decisionReason?: PermissionDecisionReason;
  toolUseID?: string;
  acceptFeedback?: string;
  /** Content blocks (e.g., images) to include alongside the tool result. */
  contentBlocks?: ContentBlockParam[];
};

export type PermissionAskDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  behavior: "ask";
  message: string;
  updatedInput?: Input;
  decisionReason?: PermissionDecisionReason;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  metadata?: PermissionMetadata;
  /**
   * If true, this ask decision was triggered by a security check for patterns
   * that the command parser could misparse.
   */
  isBashSecurityCheckForMisparsing?: boolean;
  /**
   * If set, an allow classifier check should be run asynchronously.
   */
  pendingClassifierCheck?: PendingClassifierCheck;
  /** Content blocks (e.g., images) to include alongside the rejection message. */
  contentBlocks?: ContentBlockParam[];
};

export type PermissionDenyDecision = {
  behavior: "deny";
  message: string;
  decisionReason: PermissionDecisionReason;
  toolUseID?: string;
};

/**
 * A permission decision - allow, ask, or deny.
 */
export type PermissionDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision;

/**
 * Permission result with additional passthrough option.
 * Aligned with claude-code's PermissionResult.
 */
export type PermissionResult<
  Input extends Record<string, unknown> = Record<string, unknown>,
> =
  | PermissionDecision<Input>
  | {
      behavior: "passthrough";
      message: string;
      decisionReason?: PermissionDecision<Input>["decisionReason"];
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      pendingClassifierCheck?: PendingClassifierCheck;
    };

/**
 * Source of an additional working directory permission.
 */
export type WorkingDirectorySource = PermissionRuleSource;

/**
 * An additional directory included in permission scope.
 * Aligned with claude-code's AdditionalWorkingDirectory (has `source`, not `description`).
 */
export type AdditionalWorkingDirectory = {
  path: string;
  source: WorkingDirectorySource;
};

/**
 * Tool permission rules organized by source.
 * Aligned with claude-code: keys are PermissionRuleSource, not arbitrary strings.
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[];
};

/**
 * Tool permission context — immutable snapshot of the permission environment.
 * Aligned with claude-code's ToolPermissionContext (readonly, non-optional fields).
 */
export type ToolPermissionContext = {
  readonly mode: PermissionMode;
  /** Additional working directories beyond the primary cwd. */
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>;
  /** Rules that always allow tool execution, organized by source. */
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  /** Rules that always deny tool execution, organized by source. */
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  /** Rules that always ask for user confirmation, organized by source. */
  readonly alwaysAskRules: ToolPermissionRulesBySource;
  /** Whether bypass permissions mode is available. */
  readonly isBypassPermissionsModeAvailable: boolean;
  /** Whether auto mode is available. */
  readonly isAutoModeAvailable?: boolean;
  /** Rules that were stripped because they were dangerous. */
  readonly strippedDangerousRules?: ToolPermissionRulesBySource;
  /** When true, permission prompts are auto-denied (e.g., background agents). */
  readonly shouldAvoidPermissionPrompts?: boolean;
  /** When true, automated checks are awaited before showing the permission dialog. */
  readonly awaitAutomatedChecksBeforeDialog?: boolean;
  /** Stores the permission mode before model-initiated plan mode entry. */
  readonly prePlanMode?: PermissionMode;
};

export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  });

// --- Classifier types (aligned with claude-code's permissions.ts) ---

export type ClassifierResult = {
  matches: boolean;
  matchedDescription?: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type ClassifierBehavior = "deny" | "ask" | "allow";

export type ClassifierUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type YoloClassifierResult = {
  thinking?: string;
  shouldBlock: boolean;
  reason: string;
  unavailable?: boolean;
  transcriptTooLong?: boolean;
  model: string;
  usage?: ClassifierUsage;
  durationMs?: number;
  promptLengths?: {
    systemPrompt: number;
    toolCalls: number;
    userPrompts: number;
  };
  errorDumpPath?: string;
  stage?: "fast" | "thinking";
  stage1Usage?: ClassifierUsage;
  stage1DurationMs?: number;
  stage1RequestId?: string;
  stage1MsgId?: string;
  stage2Usage?: ClassifierUsage;
  stage2DurationMs?: number;
  stage2RequestId?: string;
  stage2MsgId?: string;
};

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type PermissionExplanation = {
  riskLevel: RiskLevel;
  explanation: string;
  reasoning: string;
  risk: string;
};

// --- Tool result ---
// Aligned with claude-code's ToolResult<T>: typed `data` field, not content blocks.
// The tool's `mapToolResultToToolResultBlockParam()` converts `data` to API format.

export type AgentToolResult<T = unknown> = {
  /** Typed output data from the tool. */
  data: T;
  /**
   * Additional messages to inject after the tool result.
   * Allows tools to inject follow-up user/assistant/system messages.
   */
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[];
  /**
   * Context modifier applied after tool execution. Only honored for
   * tools that are NOT concurrency-safe.
   */
  contextModifier?: (context: ToolExecutionContext) => ToolExecutionContext;
  /**
   * MCP protocol metadata (structuredContent, _meta) to pass through to SDK consumers.
   */
  mcpMeta?: {
    _meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  };
};

export type AgentToolUpdateCallback<T = unknown> = (partial: AgentToolResult<T>) => void;

// --- Spinner mode (UI state for spinner display) ---

export type SpinnerMode =
  | "tool-input"
  | "tool-use"
  | "responding"
  | "thinking"
  | "requesting";

// --- SDK status ---

export type SDKStatus = "compacting" | null;

// --- Compact progress events ---

export type CompactProgressEvent =
  | { type: "hooks_start"; hookType: "pre_compact" | "post_compact" | "session_start" }
  | { type: "compact_start" }
  | { type: "compact_end" };

// --- Query chain tracking ---

export type QueryChainTracking = {
  chainId: string;
  depth: number;
};

// --- Prompt request/response for interactive prompts ---

export type PromptRequest = {
  prompt: string;
  message: string;
  options: Array<{
    key: string;
    label: string;
    description?: string;
  }>;
};

export type PromptResponse = {
  prompt_response: string;
  selected: string;
};

// --- Agent ID (branded string) ---

export type AgentId = string & { readonly __brand: "AgentId" };

// --- File state cache ---

export interface FileStateCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): this;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

// --- File history state ---

export type FileHistoryState = {
  snapshots: Array<{ files: Map<string, string>; sequence: number }>;
  trackedFiles: Set<string>;
  snapshotSequence: number;
};

// --- Attribution state ---

export type AttributionState = {
  fileStates: Map<string, unknown>;
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>;
  surface: string;
  startingHeadSha: string | null;
  promptCount: number;
  promptCountAtLastCommit: number;
  permissionPromptCount: number;
  permissionPromptCountAtLastCommit: number;
  escapeCount: number;
  escapeCountAtLastCommit: number;
};

// --- Denial tracking state ---

export type DenialTrackingState = {
  consecutiveDenials: number;
  totalDenials: number;
};

// --- Thinking config ---

export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

// --- System prompt type (branded readonly string array) ---

export type SystemPrompt = readonly string[] & {
  readonly __brand: "SystemPrompt";
};

// --- MCP connection types ---

export type MCPServerConnection = {
  name: string;
  status: "pending" | "connecting" | "connected" | "failed" | "disabled" | "needs_auth";
  error?: string;
  tools?: AgentTool[];
};

export type ServerResource = {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

// --- Agent definition types ---

export type AgentDefinition = {
  name: string;
  description: string;
  type?: string;
  /** Whether this agent is built-in, custom, or from a plugin. */
  source?: "builtin" | "custom" | "plugin";
};

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[];
  allAgents: AgentDefinition[];
  failedFiles?: Array<{ path: string; error: string }>;
  allowedAgentTypes?: string[];
};

// --- Content replacement state (for tool result budget) ---

import type { ContentReplacementState } from "./tool-result-storage.js";

// --- ToolResultBlockParam / ToolUseBlockParam ---
// Local equivalents of Anthropic SDK types (SDK can't depend on @anthropic-ai/sdk)

export type ToolResultBlockParam = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
};

export type ToolUseBlockParam = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// --- Tool execution context ---
// Aligned with claude-code's ToolUseContext — every field present.

export interface ToolExecutionContext {
  // --- Core options ---
  options: {
    commands: unknown[];
    debug: boolean;
    mainLoopModel: string;
    tools: AgentTools;
    verbose: boolean;
    thinkingConfig: ThinkingConfig;
    mcpClients: MCPServerConnection[];
    mcpResources: Record<string, ServerResource[]>;
    isNonInteractiveSession: boolean;
    agentDefinitions: AgentDefinitionsResult;
    maxBudgetUsd?: number;
    /** Custom system prompt that replaces the default system prompt. */
    customSystemPrompt?: string;
    /** Additional system prompt appended after the main system prompt. */
    appendSystemPrompt?: string;
    /** Override querySource for analytics tracking. */
    querySource?: string;
    /** Optional callback to get the latest tools (e.g., after MCP servers connect mid-query). */
    refreshTools?: () => AgentTools;
  };

  // --- Abort control ---
  abortController: AbortController;

  // --- File state ---
  readFileState: FileStateCache;

  // --- App state ---
  getAppState(): Record<string, unknown>;
  setAppState(f: (prev: Record<string, unknown>) => Record<string, unknown>): void;
  /**
   * Always-shared setAppState for session-scoped infrastructure (background
   * tasks, session hooks). Unlike setAppState, which is no-op for async agents,
   * this always reaches the root store.
   */
  setAppStateForTasks?: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => void;

  // --- MCP elicitation ---
  handleElicitation?: (
    serverName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;

  // --- Notifications ---
  addNotification?: (notif: { type: string; message: string; [key: string]: unknown }) => void;
  appendSystemMessage?: (msg: SystemMessage) => void;
  sendOSNotification?: (opts: { message: string; notificationType: string }) => void;

  // --- Memory and skills ---
  nestedMemoryAttachmentTriggers?: Set<string>;
  loadedNestedMemoryPaths?: Set<string>;
  dynamicSkillDirTriggers?: Set<string>;
  discoveredSkillNames?: Set<string>;

  // --- User modification tracking ---
  userModified?: boolean;

  // --- Tool use tracking ---
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void;
  setHasInterruptibleToolInProgress?: (v: boolean) => void;

  // --- Response tracking ---
  setResponseLength: (f: (prev: number) => number) => void;
  pushApiMetricsEntry?: (ttftMs: number) => void;

  // --- UI mode ---
  setStreamMode?: (mode: SpinnerMode) => void;
  onCompactProgress?: (event: CompactProgressEvent) => void;
  setSDKStatus?: (status: SDKStatus) => void;
  openMessageSelector?: () => void;

  // --- File and attribution state ---
  updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => void;
  updateAttributionState: (updater: (prev: AttributionState) => AttributionState) => void;

  // --- Session ---
  setConversationId?: (id: string) => void;
  agentId?: AgentId;
  agentType?: string;

  // --- Permission ---
  requireCanUseTool?: boolean;

  // --- Messages ---
  messages: Message[];

  // --- Limits ---
  fileReadingLimits?: {
    maxTokens?: number;
    maxSizeBytes?: number;
  };
  globLimits?: {
    maxResults?: number;
  };

  // --- Tool decisions (accept/reject tracking) ---
  toolDecisions?: Map<string, {
    source: string;
    decision: "accept" | "reject";
    timestamp: number;
  }>;

  // --- Query tracking ---
  queryTracking?: QueryChainTracking;

  // --- Interactive prompts ---
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>;

  // --- Tool use ID ---
  toolUseId?: string;

  // --- Experimental ---
  criticalSystemReminder_EXPERIMENTAL?: string;
  preserveToolUseResults?: boolean;

  // --- Hook executor ---
  /** Hook executor for PreToolUse/PostToolUse/PostToolUseFailure hooks.
   *  When provided, the tool execution pipeline delegates to this executor
   *  for hook dispatch. Aligned with claude-code's hook system. */
  hookExecutor?: import("../hooks/hook-executor.js").HookExecutor;

  // --- Speculative classifier check ---
  /** Callback to start a speculative classifier check for Bash commands.
   *  Aligned with claude-code's startSpeculativeClassifierCheck — fires early
   *  so the classifier runs in parallel with pre-tool hooks and permission dialog. */
  startSpeculativeClassifierCheck?: (
    command: string,
    toolPermissionContext: unknown,
    signal: AbortSignal,
    isNonInteractiveSession?: boolean,
  ) => void;

  // --- Tracing (OTel span tracing) ---
  /** Tool span tracing callbacks. Aligned with claude-code's sessionTracing.ts.
   *  When provided, the executor calls these at the same points as claude-code:
   *  startToolSpan → startToolBlockedOnUserSpan → endToolBlockedOnUserSpan →
   *  startToolExecutionSpan → endToolExecutionSpan → endToolSpan */
  tracing?: {
    startToolSpan(name: string, attributes: Record<string, unknown>, input?: string): void;
    startToolBlockedOnUserSpan(): void;
    endToolBlockedOnUserSpan(decision: string, source: string): void;
    startToolExecutionSpan(): void;
    endToolExecutionSpan(result: { success: boolean; error?: string }): void;
    endToolSpan(result?: string): void;
    addToolContentEvent(name: string, attributes: Record<string, unknown>): void;
    isBetaTracingEnabled(): boolean;
  };

  // --- Analytics ---
  /** Analytics/telemetry callbacks. Aligned with claude-code's logEvent/logOTelEvent.
   *  When provided, the executor emits all ~15 event types matching claude-code. */
  analytics?: {
    logEvent(name: string, metadata: Record<string, unknown>): void;
    logOTelEvent(name: string, attributes: Record<string, string | number | boolean>): void;
    sanitizeToolName(name: string): string;
    extractToolInputForTelemetry(input: unknown): string | undefined;
    isToolDetailsLoggingEnabled(): boolean;
    extractMcpToolDetails?(toolName: string): { serverName: string; mcpToolName: string } | null;
    extractSkillName?(toolName: string, input: unknown): string | null;
    getFileExtensionForAnalytics?(filePath: string): string | undefined;
    getFileExtensionsFromBashCommand?(command: string, sedFilePath?: string): string | undefined;
    /** Accumulate tool execution time. Aligned with claude-code's addToToolDuration. */
    addToToolDuration?(durationMs: number): void;
  };

  // --- Session activity ---
  /** Session activity tracking. Aligned with claude-code's sessionActivity.ts. */
  sessionActivity?: {
    start(activity: string): void;
    stop(activity: string): void;
  };

  // --- Debug logging ---
  /** Debug logging callback. Aligned with claude-code's logForDebugging. */
  logForDebugging?: (message: string, options?: { level?: string }) => void;

  /** Error logging callback. Aligned with claude-code's logError. */
  logError?: (error: unknown) => void;

  // --- Stats store ---
  /** Stats store for observing hook/phase durations. Aligned with claude-code's getStatsStore. */
  statsStore?: {
    observe(metric: string, value: number): void;
  };

  // --- Code-edit tool metrics ---
  /** Code-edit tool decision counter callbacks.
   *  Aligned with claude-code's isCodeEditingTool + buildCodeEditToolAttributes + getCodeEditToolDecisionCounter.
   *  When provided, the executor increments an OTel counter for code-editing tool decisions
   *  in headless mode (where the interactive permission path doesn't log). */
  codeEditMetrics?: {
    isCodeEditingTool(toolName: string): boolean;
    buildCodeEditToolAttributes(
      tool: AgentTool,
      input: unknown,
      decision: string,
      source: string,
    ): Promise<Record<string, string | number | boolean>>;
    getCodeEditToolDecisionCounter(): { add(value: number, attributes: Record<string, string | number | boolean>): void } | undefined;
  };

  // --- Denial tracking ---
  localDenialTracking?: DenialTrackingState;

  // --- Content replacement state ---
  contentReplacementState?: ContentReplacementState;

  // --- Rendered system prompt ---
  renderedSystemPrompt?: SystemPrompt;

}

// --- Tool progress ---

export type ToolProgressData = Record<string, unknown>;

export type Progress = ToolProgressData | HookProgress;

export type ToolProgress<P extends ToolProgressData = ToolProgressData> = {
  toolUseID: string;
  data: P;
};

export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      (msg as ProgressMessage<ToolProgressData>).data?.type !== "hook_progress",
  );
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void;

// --- Input JSON schema (for MCP tools that provide JSON Schema directly) ---

export type ToolInputJSONSchema = {
  [x: string]: unknown;
  type: "object";
  properties?: {
    [x: string]: unknown;
  };
};

// --- Tool definition ---

/**
 * AgentTool — fully aligned with claude-code's Tool<Input, Output, P> interface.
 *
 * All behavioral methods have defaults via buildTool(). Tools only need to
 * implement the methods that differ from defaults.
 *
 * SDK substitutions:
 *   React.ReactNode → unknown (no React dependency)
 *   ThemeName / keyof Theme → string
 *   Command → unknown
 */
export interface AgentTool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> {
  /**
   * Optional aliases for backwards compatibility when a tool is renamed.
   * The tool can be looked up by any of these names in addition to its primary name.
   */
  aliases?: string[];
  /**
   * One-line capability phrase used by ToolSearch for keyword matching.
   * Helps the model find this tool via keyword search when it's deferred.
   * 3–10 words, no trailing period.
   * Prefer terms not already in the tool name (e.g. 'jupyter' for NotebookEdit).
   */
  searchHint?: string;

  call(
    args: z.infer<Input>,
    context: ToolExecutionContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<AgentToolResult<Output>>;

  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean;
      toolPermissionContext: ToolPermissionContext;
      tools: AgentTools;
    },
  ): Promise<string>;

  readonly inputSchema: Input;
  // Type for MCP tools that can specify their input schema directly in JSON Schema format
  // rather than converting from Zod schema
  readonly inputJSONSchema?: ToolInputJSONSchema;
  // Optional because not all tools define this. TODO: Make it required.
  outputSchema?: z.ZodType<unknown>;
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean;
  isConcurrencySafe(input: z.infer<Input>): boolean;
  isEnabled(): boolean;
  isReadOnly(input: z.infer<Input>): boolean;
  /** Defaults to false. Only set when the tool performs irreversible operations (delete, overwrite, send). */
  isDestructive?(input: z.infer<Input>): boolean;
  /**
   * What should happen when the user submits a new message while this tool
   * is running.
   *
   * - `'cancel'` — stop the tool and discard its result
   * - `'block'`  — keep running; the new message waits
   *
   * Defaults to `'block'` when not implemented.
   */
  interruptBehavior?(): "cancel" | "block";
  /**
   * Returns information about whether this tool use is a search or read operation
   * that should be collapsed into a condensed display in the UI.
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean;
    isRead: boolean;
    isList?: boolean;
  };
  isOpenWorld?(input: z.infer<Input>): boolean;
  requiresUserInteraction?(): boolean;
  isMcp?: boolean;
  isLsp?: boolean;
  /**
   * When true, this tool is deferred (sent with defer_loading: true) and requires
   * ToolSearch to be used before it can be called.
   */
  readonly shouldDefer?: boolean;
  /**
   * When true, this tool is never deferred — its full schema appears in the
   * initial prompt even when ToolSearch is enabled. For MCP tools, set via
   * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
   * turn 1 without a ToolSearch round-trip.
   */
  readonly alwaysLoad?: boolean;
  /**
   * For MCP tools: the server and tool names as received from the MCP server (unnormalized).
   * Present on all MCP tools regardless of whether `name` is prefixed (mcp__server__tool)
   * or unprefixed (CLAUDE_AGENT_SDK_MCP_NO_PREFIX mode).
   */
  mcpInfo?: { serverName: string; toolName: string };
  readonly name: string;
  /**
   * Maximum size in characters for tool result before it gets persisted to disk.
   * When exceeded, the result is saved to a file and Claude receives a preview
   * with the file path instead of the full content.
   *
   * Set to Infinity for tools whose output must never be persisted (e.g. Read,
   * where persisting creates a circular Read→file→Read loop and the tool
   * already self-bounds via its own limits).
   */
  maxResultSizeChars: number;
  /**
   * When true, enables strict mode for this tool, which causes the API to
   * more strictly adhere to tool instructions and parameter schemas.
   */
  readonly strict?: boolean;

  /**
   * Called on copies of tool_use input before observers see it (SDK stream,
   * transcript, canUseTool, PreToolUse/PostToolUse hooks). Mutate in place
   * to add legacy/derived fields. Must be idempotent. The original API-bound
   * input is never mutated (preserves prompt cache). Not re-applied when a
   * hook/permission returns a fresh updatedInput — those own their shape.
   */
  backfillObservableInput?(input: Record<string, unknown>): void;

  /**
   * Determines if this tool is allowed to run with this input in the current context.
   * It informs the model of why the tool use failed, and does not directly display any UI.
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolExecutionContext,
  ): Promise<ValidationResult>;

  /**
   * Determines if the user is asked for permission. Only called after validateInput() passes.
   * General permission logic is in permissions.ts. This method contains tool-specific logic.
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolExecutionContext,
  ): Promise<PermissionResult>;

  // Optional method for tools that operate on a file path
  getPath?(input: z.infer<Input>): string;

  /**
   * Prepare a matcher for hook `if` conditions (permission-rule patterns like
   * "git *" from "Bash(git *)"). Called once per hook-input pair; any
   * expensive parsing happens here. Returns a closure that is called per
   * hook pattern. If not implemented, only tool-name-level matching works.
   */
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>;

  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>;
    tools: AgentTools;
    agents: AgentDefinition[];
    allowedAgentTypes?: string[];
  }): Promise<string>;

  userFacingName(input: Partial<z.infer<Input>> | undefined): string;
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | undefined;
  /**
   * Transparent wrappers (e.g. REPL) delegate all rendering to their progress
   * handler, which emits native-looking blocks for each inner tool call.
   * The wrapper itself shows nothing.
   */
  isTransparentWrapper?(): boolean;
  /**
   * Returns a short string summary of this tool use for display in compact views.
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null;
  /**
   * Returns a human-readable present-tense activity description for spinner display.
   * Example: "Reading src/foo.ts", "Running bun test", "Searching for pattern"
   */
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null;
  /**
   * Returns a compact representation of this tool use for the auto-mode
   * security classifier. Examples: `ls -la` for Bash, `/tmp/x: new content`
   * for Edit. Return '' to skip this tool in the classifier transcript
   * (e.g. tools with no security relevance). May return an object to avoid
   * double-encoding when the caller JSON-wraps the value.
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown;
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam;
  /**
   * Optional. When omitted, the tool result renders nothing (same as returning
   * null). Omit for tools whose results are surfaced elsewhere.
   */
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: "condensed";
      theme: string;
      tools: AgentTools;
      verbose: boolean;
      isTranscriptMode?: boolean;
      isBriefOnly?: boolean;
      /** Original tool_use input, when available. */
      input?: unknown;
    },
  ): unknown;
  /**
   * Flattened text of what renderToolResultMessage shows IN TRANSCRIPT
   * MODE. For transcript search indexing.
   */
  extractSearchText?(out: Output): string;
  /**
   * Render the tool use message. Note that `input` is partial because we render
   * the message as soon as possible, possibly before tool parameters have fully
   * streamed in.
   */
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: string; verbose: boolean; commands?: unknown[] },
  ): unknown;
  /**
   * Returns true when the non-verbose rendering of this output is truncated.
   */
  isResultTruncated?(output: Output): boolean;
  /**
   * Renders an optional tag to display after the tool use message.
   */
  renderToolUseTag?(input: Partial<z.infer<Input>>): unknown;
  /**
   * Optional. When omitted, no progress UI is shown while the tool runs.
   */
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: AgentTools;
      verbose: boolean;
      terminalSize?: { columns: number; rows: number };
      inProgressToolCallCount?: number;
      isTranscriptMode?: boolean;
    },
  ): unknown;
  renderToolUseQueuedMessage?(): unknown;
  /**
   * Optional. When omitted, falls back to default rejection UI.
   */
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number;
      messages: Message[];
      style?: "condensed";
      theme: string;
      tools: AgentTools;
      verbose: boolean;
      progressMessagesForMessage: ProgressMessage<P>[];
      isTranscriptMode?: boolean;
    },
  ): unknown;
  /**
   * Optional. When omitted, falls back to default error UI.
   */
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam["content"],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[];
      tools: AgentTools;
      verbose: boolean;
      isTranscriptMode?: boolean;
    },
  ): unknown;
  /**
   * Renders multiple tool uses as a group (non-verbose mode only).
   * In verbose mode, individual tool uses render at their original positions.
   * @returns Rendered content, or null to fall back to individual rendering
   */
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam;
      isResolved: boolean;
      isError: boolean;
      isInProgress: boolean;
      progressMessages: ProgressMessage<P>[];
      result?: {
        param: ToolResultBlockParam;
        output: unknown;
      };
    }>,
    options: {
      shouldAnimate: boolean;
      tools: AgentTools;
    },
  ): unknown | null;
}

// --- Tool collection type ---

/**
 * A collection of tools. Use this type instead of `AgentTool[]` to make it easier
 * to track where tool sets are assembled, passed, and filtered across the codebase.
 */
export type AgentTools = readonly AgentTool[];

// --- Defaultable keys (filled by buildTool) ---

/**
 * Methods that `buildTool` supplies a default for. A `ToolDef` may omit these;
 * the resulting `Tool` always has them.
 */
type DefaultableToolKeys =
  | "isEnabled"
  | "isConcurrencySafe"
  | "isReadOnly"
  | "isDestructive"
  | "checkPermissions"
  | "toAutoClassifierInput"
  | "userFacingName";

/** Default max result size in chars (~12.5k tokens). */
const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/**
 * Build a complete `Tool` from a partial definition, filling in safe defaults
 * for the commonly-stubbed methods. All tool exports should go through this so
 * that defaults live in one place and callers never need `?.() ?? default`.
 *
 * Defaults (fail-closed where it matters):
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false` (assume not safe)
 * - `isReadOnly` → `false` (assume writes)
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }` (defer to general permission system)
 * - `toAutoClassifierInput` → `''` (skip classifier — security-relevant tools must override)
 * - `userFacingName` → `name`
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolExecutionContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: "allow" as const, updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => "",
  userFacingName: (_input?: unknown) => "",
};

// The defaults type is the ACTUAL shape of TOOL_DEFAULTS (optional params so
// both 0-arg and full-arg call sites type-check — stubs varied in arity and
// tests relied on that), not the interface's strict signatures.
type ToolDefaults = typeof TOOL_DEFAULTS;

/**
 * Tool definition accepted by `buildTool`. Same shape as `Tool` but with the
 * defaultable methods optional — `buildTool` fills them in so callers always
 * see a complete `Tool`.
 */
export type AgentToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<AgentTool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<AgentTool<Input, Output, P>, DefaultableToolKeys>>;

/**
 * Type-level spread mirroring `{ ...TOOL_DEFAULTS, ...def }`. For each
 * defaultable key: if D provides it (required), D's type wins; if D omits
 * it or has it optional (inherited from Partial<> in the constraint), the
 * default fills in. All other keys come from D verbatim — preserving arity,
 * optional presence, and literal types exactly as `satisfies Tool` did.
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K];
};

// D infers the concrete object-literal type from the call site. The
// constraint provides contextual typing for method parameters; `any` in
// constraint position is structural and never leaks into the return type.
// BuiltTool<D> mirrors runtime `{...TOOL_DEFAULTS, ...def}` at the type level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = AgentToolDef<any, any, any>;

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // The runtime spread is straightforward; the `as` bridges the gap between
  // the structural-any constraint and the precise BuiltTool<D> return. The
  // type semantics are proven by the 0-error typecheck across all tools.
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>;
}

// --- Tool lookup utilities ---

/**
 * Checks if a tool matches the given name (primary name or alias).
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

/**
 * Finds a tool by name or alias from a list of tools.
 */
export function findToolByName(tools: readonly AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => toolMatchesName(t, name));
}

/**
 * Check if a tool is from an MCP server.
 * Aligned with claude-code's isMcpTool from services/mcp/utils.ts.
 */
export function isMcpTool(tool: AgentTool | { name: string; isMcp?: boolean }): boolean {
  return tool.name?.startsWith("mcp__") || tool.isMcp === true;
}

// --- Re-export DEFAULT_MAX_RESULT_SIZE_CHARS for tool result storage ---
export { DEFAULT_MAX_RESULT_SIZE_CHARS };
