// Tool execution engine — sequential and parallel modes

import type { AgentTool, AgentToolResult, ToolExecutionContext, BeforeToolCallContext, BeforeToolCallResult, AfterToolCallContext, AfterToolCallResult } from "./types.js";
import type { ToolCallBlock, TextContent } from "../llm/types.js";
import type { Approval } from "../approval/types.js";
import { Value } from "@sinclair/typebox/value";

export interface ToolExecutorConfig {
  tools: AgentTool[];
  mode: "sequential" | "parallel";
  approval: Approval;
  agentName: string;
  signal: AbortSignal;
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | void>;
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | void>;
  onEvent: (event: ToolExecutorEvent) => void;
}

export type ToolExecutorEvent =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  result: AgentToolResult;
  isError: boolean;
}

export async function executeToolCalls(
  toolCalls: ToolCallBlock[],
  config: ToolExecutorConfig,
): Promise<ToolCallResult[]> {
  if (config.mode === "sequential") {
    return executeSequential(toolCalls, config);
  }
  return executeParallel(toolCalls, config);
}

async function executeSequential(
  toolCalls: ToolCallBlock[],
  config: ToolExecutorConfig,
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];
  for (const tc of toolCalls) {
    if (config.signal.aborted) break;
    const result = await executeSingleTool(tc, config);
    results.push(result);
  }
  return results;
}

async function executeParallel(
  toolCalls: ToolCallBlock[],
  config: ToolExecutorConfig,
): Promise<ToolCallResult[]> {
  // Preflight sequentially (approval, beforeToolCall), then execute concurrently
  const prepared: { tc: ToolCallBlock; tool: AgentTool | null; args: unknown; rejectReason?: string }[] = [];

  for (const tc of toolCalls) {
    if (config.signal.aborted) break;

    const tool = config.tools.find((t) => t.name === tc.name);
    if (!tool) {
      prepared.push({ tc, tool: null, args: tc.input, rejectReason: `Unknown tool: ${tc.name}` });
      continue;
    }

    // Before hook
    if (config.beforeToolCall) {
      const hookResult = await config.beforeToolCall({ toolName: tc.name, toolCallId: tc.id, args: tc.input });
      if (hookResult?.block) {
        prepared.push({ tc, tool: null, args: tc.input, rejectReason: hookResult.reason ?? "Tool call blocked" });
        continue;
      }
    }

    // Approval
    if (tool.approvalAction && !config.approval.isYolo()) {
      const approved = await config.approval.request(tool.name, tool.approvalAction, `Execute ${tool.label}`, tc.id);
      if (!approved) {
        prepared.push({ tc, tool: null, args: tc.input, rejectReason: "Tool call rejected by user" });
        continue;
      }
    }

    prepared.push({ tc, tool, args: tc.input });
  }

  // Execute concurrently
  const promises = prepared.map(({ tc, tool, args, rejectReason }) =>
    rejectReason
      ? Promise.resolve(makeErrorResult(tc, rejectReason, config.onEvent))
      : executeSingleToolInner(tc, tool!, args, config),
  );
  return Promise.all(promises);
}

async function executeSingleTool(
  tc: ToolCallBlock,
  config: ToolExecutorConfig,
): Promise<ToolCallResult> {
  const tool = config.tools.find((t) => t.name === tc.name);

  if (!tool) {
    return makeErrorResult(tc, `Unknown tool: ${tc.name}`, config.onEvent);
  }

  // Before hook
  if (config.beforeToolCall) {
    const hookResult = await config.beforeToolCall({ toolName: tc.name, toolCallId: tc.id, args: tc.input });
    if (hookResult?.block) {
      return makeErrorResult(tc, hookResult.reason ?? "Tool call blocked", config.onEvent);
    }
  }

  // Approval
  if (tool.approvalAction && !config.approval.isYolo()) {
    const approved = await config.approval.request(tool.name, tool.approvalAction, `Execute ${tool.label}`, tc.id);
    if (!approved) {
      return makeErrorResult(tc, "Tool call rejected by user", config.onEvent);
    }
  }

  return executeSingleToolInner(tc, tool, tc.input, config);
}

function makeErrorResult(
  tc: ToolCallBlock,
  reason: string,
  onEvent: (event: ToolExecutorEvent) => void,
): ToolCallResult {
  const errorResult: AgentToolResult = {
    content: [{ type: "text", text: reason }],
  };
  onEvent({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: errorResult, isError: true });
  return { toolCallId: tc.id, toolName: tc.name, result: errorResult, isError: true };
}

async function executeSingleToolInner(
  tc: ToolCallBlock,
  tool: AgentTool,
  args: unknown,
  config: ToolExecutorConfig,
): Promise<ToolCallResult> {

  // Validate tool input against schema
  if (tool.parameters) {
    const valid = Value.Check(tool.parameters, args);
    if (!valid) {
      const errors = [...Value.Errors(tool.parameters, args)];
      const errorMsg = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
      const errorResult: AgentToolResult = {
        content: [{ type: "text", text: `Invalid tool input: ${errorMsg}` }],
      };
      config.onEvent({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: errorResult, isError: true });
      return { toolCallId: tc.id, toolName: tc.name, result: errorResult, isError: true };
    }
  }

  config.onEvent({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args });

  let result: AgentToolResult;
  let isError = false;

  try {
    const ctx: ToolExecutionContext = {
      signal: config.signal,
      onUpdate: (partial) => {
        config.onEvent({ type: "tool_execution_update", toolCallId: tc.id, toolName: tc.name, partialResult: partial });
      },
      approval: config.approval,
      agentName: config.agentName,
    };
    result = await tool.execute(tc.id, args as any, ctx);
  } catch (err) {
    result = {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
    isError = true;
  }

  // After hook
  if (config.afterToolCall) {
    const hookResult = await config.afterToolCall({ toolName: tc.name, toolCallId: tc.id, args, result, isError });
    if (hookResult) {
      if (hookResult.content) result = { ...result, content: hookResult.content };
      if (hookResult.details !== undefined) result = { ...result, details: hookResult.details };
      if (hookResult.isError !== undefined) isError = hookResult.isError;
    }
  }

  config.onEvent({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
  return { toolCallId: tc.id, toolName: tc.name, result, isError };
}
