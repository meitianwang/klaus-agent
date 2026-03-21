// Extension system types

import type { TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, BeforeToolCallContext, BeforeToolCallResult, AfterToolCallContext, AfterToolCallResult } from "../tools/types.js";
import type { AgentMessage, AgentEvent, ThinkingLevel } from "../types.js";
import type { Message, ToolDefinition } from "../llm/types.js";
import type { SessionManager } from "../session/session-manager.js";

// --- Extension factory ---

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

// --- Extension API ---

export interface ExtensionAPI {
  on<E extends ExtensionEventType>(event: E, handler: ExtensionHandler<E>): void;
  registerTool<TParams extends TSchema>(tool: AgentTool<TParams>): void;
  registerCommand(name: string, handler: CommandHandler): void;
  sendMessage(message: AgentMessage): void;
}

// --- Event types ---

export type ExtensionEventType =
  // Agent lifecycle
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  // Turn lifecycle
  | "turn_start"
  | "turn_end"
  // Message streaming
  | "message_start"
  | "message_end"
  // Tool execution
  | "tool_call"
  | "tool_result"
  // LLM request
  | "before_provider_request"
  // Context & compaction
  | "context"
  | "before_compact"
  | "after_compact"
  // Session
  | "session_start"
  | "session_switch"
  | "session_fork";

// --- Event payloads & results ---

// before_agent_start: modify agent config before loop starts
export interface BeforeAgentStartEvent {
  systemPrompt: string;
  tools: AgentTool[];
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  tools?: AgentTool[];
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

// before_provider_request: modify LLM request before sending
export interface BeforeProviderRequestEvent {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
}

export interface BeforeProviderRequestResult {
  systemPrompt?: string;
  messages?: Message[];
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
}

// tool_call / tool_result
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  args: unknown;
}

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
}

export interface ToolResultEventResult {
  content?: AgentToolResult["content"];
  details?: unknown;
  isError?: boolean;
}

// context
export interface ContextEvent {
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}

// compaction
export interface BeforeCompactEvent {
  messages: AgentMessage[];
}

export interface BeforeCompactResult {
  summary?: string;
  skip?: boolean;
}

export interface AfterCompactEvent {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

// session
export interface SessionEvent {
  sessionId: string;
  previousSessionId?: string;
}

// --- Event map ---

export interface ExtensionEventMap {
  // Agent lifecycle
  before_agent_start: { payload: BeforeAgentStartEvent; result: BeforeAgentStartResult | void };
  agent_start: { payload: void; result: void };
  agent_end: { payload: { messages: AgentMessage[] }; result: void };
  // Turn lifecycle
  turn_start: { payload: void; result: void };
  turn_end: { payload: { message: AgentMessage }; result: void };
  // Message streaming
  message_start: { payload: { message: AgentMessage }; result: void };
  message_end: { payload: { message: AgentMessage }; result: void };
  // Tool execution
  tool_call: { payload: ToolCallEvent; result: ToolCallEventResult | void };
  tool_result: { payload: ToolResultEvent; result: ToolResultEventResult | void };
  // LLM request
  before_provider_request: { payload: BeforeProviderRequestEvent; result: BeforeProviderRequestResult | void };
  // Context & compaction
  context: { payload: ContextEvent; result: ContextEventResult | void };
  before_compact: { payload: BeforeCompactEvent; result: BeforeCompactResult | void };
  after_compact: { payload: AfterCompactEvent; result: void };
  // Session
  session_start: { payload: SessionEvent; result: void };
  session_switch: { payload: SessionEvent; result: void };
  session_fork: { payload: SessionEvent; result: void };
}

export type ExtensionHandler<E extends ExtensionEventType> =
  (event: ExtensionEventMap[E]["payload"]) => ExtensionEventMap[E]["result"] | Promise<ExtensionEventMap[E]["result"]>;

export type CommandHandler = (args: string) => Promise<void>;
