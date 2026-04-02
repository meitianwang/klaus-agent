// Shared types for the agent framework

import type {
  Message,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  ToolResultBlock,
  AssistantMessageEvent,
  TokenUsage,
  ModelCost,
  UsageCost,
  ThinkingLevel,
  ModelConfig,
  ContentBlock,
  TextContent,
  ImageContent,
  ToolUseBlock,
  ToolCallBlock,
  ToolUseSummaryMessage,
} from "./llm/types.js";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolDef,
  CanUseToolFn,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  ValidationResult,
  PermissionResult,
  PermissionMode,
  PermissionBehavior,
  ToolPermissionContext,
  ToolProgressData,
  ToolProgress,
  ToolCallProgress,
  ToolInputJSONSchema,
  AgentTools,
  AgentDefinition,
  AgentDefinitionsResult,
} from "./tools/types.js";
import type { ApprovalRequest, ApprovalResponse, ApprovalConfig } from "./approval/types.js";

// AgentMessage is Message. No custom extension — that was dead code (empty
// interface, keyof {} = never, so the union was always just Message).
export type AgentMessage = Message;

// --- Agent state ---

export interface AgentState {
  systemPrompt: string;
  model: ModelConfig;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  isRunning: boolean;
  error?: string;
}

// --- Agent events ---

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: UserMessage[] }
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_update"; message: AssistantMessage; event: AssistantMessageEvent }
  | { type: "message_end"; message: AssistantMessage; usage?: TokenUsage }
  | { type: "tool_execution_start"; toolUseId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolUseId: string; toolName: string; partialResult: AgentToolResult }
  | { type: "tool_execution_end"; toolUseId: string; toolName: string; result: AgentToolResult; isError: boolean }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_response"; requestId: string; response: ApprovalResponse }
  | { type: "compaction_start" }
  | { type: "compaction_end"; summary: string }
  | { type: "checkpoint"; id: number }
  | { type: "dmail_received"; checkpoint: number; content: string }
  | { type: "task_started"; taskId: string; taskName: string }
  | { type: "task_completed"; taskId: string; taskName: string }
  | { type: "task_failed"; taskId: string; taskName: string; error: string }
  | { type: "error"; error: Error };

// --- After-turn hook ---
// Called after every no-tool-call turn (the `!needsFollowUp` path).
// Return `blockingMessages` to inject them as user messages and force the model
// to continue. Return `preventContinuation: true` to stop the loop immediately.

export interface AfterTurnContext {
  messages: AgentMessage[];
  assistantMessage: AssistantMessage;
  usage?: TokenUsage;
}

export type AfterTurnResult =
  | { blockingMessages: AgentMessage[]; preventContinuation?: false }
  | { preventContinuation: true };

// --- Agent hooks ---

export interface AgentHooks {
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
  convertToLlm?: (messages: AgentMessage[]) => Message[];
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | void>;
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | void>;
  // Stop-hook equivalent: runs after every no-tool turn.
  afterTurn?: (ctx: AfterTurnContext) => Promise<AfterTurnResult | void>;
}

// --- Re-exports for convenience ---

export type {
  Message,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  ToolResultBlock,
  AssistantMessageEvent,
  TokenUsage,
  ModelCost,
  UsageCost,
  ThinkingLevel,
  ModelConfig,
  ContentBlock,
  TextContent,
  ImageContent,
  ToolUseBlock,
  ToolCallBlock,
  ToolUseSummaryMessage,
  AgentTool,
  AgentToolResult,
  AgentToolDef,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  ValidationResult,
  PermissionResult,
  PermissionMode,
  PermissionBehavior,
  ToolPermissionContext,
  ToolProgressData,
  ToolProgress,
  ToolCallProgress,
  ToolInputJSONSchema,
  AgentTools,
  CanUseToolFn,
  AgentDefinition,
  AgentDefinitionsResult,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalConfig,
};
