// Extension system types

import type { TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, BeforeToolCallContext, BeforeToolCallResult, AfterToolCallContext, AfterToolCallResult } from "../tools/types.js";
import type { AgentMessage, AgentEvent } from "../types.js";
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
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_end"
  | "tool_call"
  | "tool_result"
  | "before_compact"
  | "context";

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

export interface ContextEvent {
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}

export interface BeforeCompactEvent {
  messages: AgentMessage[];
}

export interface BeforeCompactResult {
  summary?: string;
  skip?: boolean;
}

// --- Event map ---

export interface ExtensionEventMap {
  agent_start: { payload: void; result: void };
  agent_end: { payload: { messages: AgentMessage[] }; result: void };
  turn_start: { payload: void; result: void };
  turn_end: { payload: { message: AgentMessage }; result: void };
  message_start: { payload: { message: AgentMessage }; result: void };
  message_end: { payload: { message: AgentMessage }; result: void };
  tool_call: { payload: ToolCallEvent; result: ToolCallEventResult | void };
  tool_result: { payload: ToolResultEvent; result: ToolResultEventResult | void };
  before_compact: { payload: BeforeCompactEvent; result: BeforeCompactResult | void };
  context: { payload: ContextEvent; result: ContextEventResult | void };
}

export type ExtensionHandler<E extends ExtensionEventType> =
  (event: ExtensionEventMap[E]["payload"]) => ExtensionEventMap[E]["result"] | Promise<ExtensionEventMap[E]["result"]>;

export type CommandHandler = (args: string) => Promise<void>;
