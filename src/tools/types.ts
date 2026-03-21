import type { TSchema, Static } from "@sinclair/typebox";
import type { ContentBlock, TextContent, ImageContent } from "../llm/types.js";
import type { Approval } from "../approval/types.js";

// --- Tool result ---

export interface AgentToolResult<T = any> {
  content: (TextContent | ImageContent)[];
  details?: T;
}

export type AgentToolUpdateCallback<T = any> = (partial: AgentToolResult<T>) => void;

// --- Tool execution context ---

export interface ToolExecutionContext {
  signal: AbortSignal;
  onUpdate: AgentToolUpdateCallback;
  approval: Approval;
  agentName: string;
}

// --- Tool definition ---

export interface AgentTool<TParams extends TSchema = TSchema, TDetails = any> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  approvalAction?: string;

  execute(
    toolCallId: string,
    params: Static<TParams>,
    context: ToolExecutionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

// --- Before/after hooks ---

export interface BeforeToolCallContext {
  toolName: string;
  toolCallId: string;
  args: unknown;
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallContext {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
}

export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}
