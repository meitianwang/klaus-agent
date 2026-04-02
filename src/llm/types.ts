// LLM abstraction types

/** Per-token pricing in $/million tokens. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Calculated cost in actual dollars for a single request. */
export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxContextTokens: number;
  capabilities?: {
    vision?: boolean;
    thinking?: boolean;
  };
  cost?: ModelCost;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// --- Content types ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: { type: "base64"; mediaType: string; data: string } | { type: "url"; url: string };
}

/** Tool result content block — embedded inside UserMessage, aligned with claude-code. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextContent | ImageContent;

// --- Tool definition for LLM ---

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// --- Messages (LLM-level) ---

export interface UserMessage {
  role: "user";
  content: string | (ContentBlock | ToolResultBlock)[];
  // Metadata fields — aligned with claude-code's UserMessage:
  /** Links this result to the assistant message that triggered the tool call. */
  sourceToolAssistantId?: string;
  /** UUID of the source assistant message. Aligned with claude-code's sourceToolAssistantUUID. */
  sourceToolAssistantUUID?: string;
  /** Plain-text summary for SDK consumers / REPL history (not sent to API). */
  toolUseResult?: string;
  /**
   * MCP protocol metadata (structuredContent, _meta) passed through to SDK consumers.
   * Never sent to the model — only for external consumption.
   * Aligned with claude-code's mcpMeta on UserMessage.
   */
  mcpMeta?: {
    _meta?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
  };
  /** Image paste IDs for images included in the tool result. Aligned with claude-code. */
  imagePasteIds?: number[];
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** @deprecated Use ToolUseBlock. */
export type ToolCallBlock = ToolUseBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Opaque signature returned by the provider; must be echoed back in subsequent requests. */
  signature?: string;
}

export type AssistantContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  /** Stable message ID from the API provider. Used for deduplication in
   *  tool result budget grouping (streaming can yield same-ID fragments). */
  id?: string;
  stopReason?: StopReason;
  /** Set on synthetic error messages (413, rate-limit, etc.). */
  isApiErrorMessage?: boolean;
  /** Specific API error type (e.g. "prompt_too_long", "max_output_tokens"). */
  apiError?: string;
  /** Raw error details string from the API. Used by media size error detection. */
  errorDetails?: string;
}

/**
 * Tool results are now UserMessage instances with tool_result content blocks,
 * aligned with claude-code. This alias is kept for backward compatibility.
 * @deprecated Use UserMessage with ToolResultBlock content blocks instead.
 */
export type ToolResultMessage = UserMessage;

export type Message = UserMessage | AssistantMessage;

/**
 * System message — injected by the system (e.g., slash commands, local commands).
 * Aligned with claude-code's SystemMessage type from types/message.ts.
 * Not sent directly to the model — processed by the agent loop.
 */
export interface SystemMessage {
  type: "system";
  content: string;
  /** Optional subtype for categorization. */
  subtype?: string;
  /** UUID for message identity. */
  uuid?: string;
}

/**
 * Attachment message — used by the hook system for structured hook results.
 * Aligned with claude-code's AttachmentMessage type.
 * Not sent to the model — only for internal consumption and UI display.
 */
export interface AttachmentMessage {
  type: "attachment";
  attachment: HookAttachment;
  /** UUID for message identity. */
  uuid?: string;
}

/**
 * Hook attachment types — discriminated union matching claude-code's hook attachment types.
 */
export type HookAttachment =
  | { type: "hook_cancelled"; hookName: string; toolUseID: string; hookEvent: string }
  | { type: "hook_blocking_error"; hookName: string; toolUseID: string; hookEvent: string; blockingError: HookBlockingError }
  | { type: "hook_additional_context"; content: string[]; hookName: string; toolUseID: string; hookEvent: string }
  | { type: "hook_error_during_execution"; content: string; hookName: string; toolUseID: string; hookEvent: string }
  | { type: "hook_stopped_continuation"; message: string; hookName: string; toolUseID: string; hookEvent: string }
  | { type: "hook_permission_decision"; decision: string; toolUseID: string; hookEvent: string }
  | { type: "structured_output"; data: unknown };

/**
 * Progress message — aligned with claude-code's ProgressMessage from types/message.ts.
 * Generic over the progress data type (e.g. HookProgress, ToolProgressData).
 */
export interface ProgressMessage<T = unknown> {
  type: "progress";
  data: T;
  toolUseID: string;
  parentToolUseID?: string;
  uuid: string;
  timestamp: string;
}

/**
 * Hook progress data — aligned with claude-code's HookProgress from types/hooks.ts.
 */
export type HookProgress = {
  type: "hook_progress";
  hookEvent: string;
  hookName: string;
  command: string;
  promptText?: string;
  statusMessage?: string;
};

/**
 * Blocking error from a hook (exit code 2 or JSON {decision:"block"}).
 * Aligned with claude-code's HookBlockingError from types/hooks.ts.
 */
export type HookBlockingError = {
  blockingError: string;
  command: string;
};

/** Tool use summary — generated asynchronously after tool execution, yielded next turn. */
export interface ToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  precedingToolUseIds: string[];
  /** Unique ID for this summary message. Aligned with claude-code. */
  uuid: string;
  /** ISO timestamp of summary generation. Aligned with claude-code. */
  timestamp: string;
}

// --- Token usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: UsageCost;
}

// --- Streaming events ---

export interface StreamTextEvent {
  type: "text";
  text: string;
}

export interface StreamToolUseStartEvent {
  type: "tool_use_start";
  id: string;
  name: string;
}

/** @deprecated Use StreamToolUseStartEvent. */
export type StreamToolCallStartEvent = StreamToolUseStartEvent;

export interface StreamToolUseDeltaEvent {
  type: "tool_use_delta";
  id: string;
  input: string; // partial JSON
}

/** @deprecated Use StreamToolUseDeltaEvent. */
export type StreamToolCallDeltaEvent = StreamToolUseDeltaEvent;

export interface StreamThinkingEvent {
  type: "thinking";
  thinking: string;
}

export interface StreamToolUseEndEvent {
  type: "tool_use_end";
  /** Completed tool use block with fully parsed input. */
  block: ToolUseBlock;
}

/** @deprecated Use StreamToolUseEndEvent. */
export type StreamToolCallEndEvent = StreamToolUseEndEvent;

export interface StreamDoneEvent {
  type: "done";
  message: AssistantMessage;
  usage: TokenUsage;
  stopReason?: StopReason;
}

export interface StreamErrorEvent {
  type: "error";
  error: Error;
}

export type AssistantMessageEvent =
  | StreamTextEvent
  | StreamToolUseStartEvent
  | StreamToolUseDeltaEvent
  | StreamToolUseEndEvent
  | StreamThinkingEvent
  | StreamDoneEvent
  | StreamErrorEvent;

// --- Provider interface ---

export interface LLMProvider {
  stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent>;
}

export interface LLMRequestOptions {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Optional structured system prompt blocks with cache_control hints.
   * When provided, providers that support structured system prompts (e.g., Anthropic)
   * will use these blocks instead of the flat `systemPrompt` string for optimal caching.
   * Providers that don't support this will fall back to `systemPrompt`.
   */
  systemPromptBlocks?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  /**
   * Override for max output tokens. When set, takes precedence over maxTokens.
   * Used by the max_output_tokens escalation path (8k → 64k).
   */
  maxOutputTokensOverride?: number;
  /**
   * Enable prompt caching for this request (provider-dependent).
   * Aligned with claude-code's enablePromptCaching option.
   */
  enablePromptCaching?: boolean;
  /**
   * Whether the session is non-interactive (e.g., headless/CI).
   * Passed through to provider for potential behavioral differences.
   */
  isNonInteractiveSession?: boolean;
}

export type LLMProviderFactory = (config: { apiKey?: string; baseUrl?: string }) => LLMProvider;
