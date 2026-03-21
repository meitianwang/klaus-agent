// LLM abstraction types

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxContextTokens?: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// --- Content types ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

export type ContentBlock = TextContent | ImageContent;

// --- Tool definition for LLM ---

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// --- Messages (LLM-level) ---

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface ToolCallBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type AssistantContentBlock = TextBlock | ToolCallBlock | ThinkingBlock;

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
}

export interface ToolResultMessage {
  role: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// --- Token usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// --- Streaming events ---

export interface StreamTextEvent {
  type: "text";
  text: string;
}

export interface StreamToolCallStartEvent {
  type: "tool_call_start";
  id: string;
  name: string;
}

export interface StreamToolCallDeltaEvent {
  type: "tool_call_delta";
  id: string;
  input: string; // partial JSON
}

export interface StreamThinkingEvent {
  type: "thinking";
  thinking: string;
}

export interface StreamDoneEvent {
  type: "done";
  message: AssistantMessage;
  usage: TokenUsage;
}

export interface StreamErrorEvent {
  type: "error";
  error: Error;
}

export type AssistantMessageEvent =
  | StreamTextEvent
  | StreamToolCallStartEvent
  | StreamToolCallDeltaEvent
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
}
