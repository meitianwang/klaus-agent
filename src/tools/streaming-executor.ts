// StreamingToolExecutor — executes tools as they stream in from the model.
//   - Tools are added via addTool() as they arrive during streaming
//   - Concurrent-safe tools execute in parallel; non-concurrent tools run exclusively
//   - Results are yielded in order via getCompletedResults() (sync) and getRemainingResults() (async)
//   - discard() cleans up on streaming fallback

import type { AgentTool, AgentToolResult, ToolExecutionContext } from "./types.js";
import type { ToolCallBlock, TextContent } from "../llm/types.js";
import type { Approval } from "../approval/types.js";
import type { ToolCallResult } from "./executor.js";
import { Value } from "@sinclair/typebox/value";

type ToolStatus = "queued" | "executing" | "completed" | "yielded";

interface TrackedTool {
  id: string;
  block: ToolCallBlock;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  promise?: Promise<void>;
  result?: ToolCallResult;
}

export interface StreamingToolExecutorConfig {
  tools: AgentTool[];
  approval: Approval;
  agentName: string;
  signal: AbortSignal;
  maxToolResultChars?: number;
  beforeToolCall?: (ctx: { toolName: string; toolCallId: string; args: unknown }) => Promise<{ block?: boolean; reason?: string } | void>;
  afterToolCall?: (ctx: { toolName: string; toolCallId: string; args: unknown; result: AgentToolResult; isError: boolean }) => Promise<{ content?: AgentToolResult["content"]; isError?: boolean } | void>;
  onEvent: (event: { type: string; toolCallId: string; toolName: string; [key: string]: unknown }) => void;
}

/** Maximum characters for a single tool result content. */
const MAX_TOOL_RESULT_CHARS = 100_000;

export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private discarded = false;
  private hasErrored = false;
  private progressResolve: (() => void) | null = null;

  constructor(private readonly config: StreamingToolExecutorConfig) {}

  /**
   * Add a tool to the execution queue. Execution starts immediately if
   * concurrency conditions allow.
   */
  addTool(block: ToolCallBlock): void {
    if (this.discarded) return;

    const toolDef = this.config.tools.find((t) => t.name === block.name);
    if (!toolDef) {
      // Unknown tool — immediately complete with error
      this.tools.push({
        id: block.id,
        block,
        status: "completed",
        isConcurrencySafe: false,
        result: {
          toolCallId: block.id,
          toolName: block.name,
          result: { content: [{ type: "text", text: `Unknown tool: ${block.name}` }] },
          isError: true,
        },
      });
      this.notifyProgress();
      return;
    }

    // Validate input
    if (toolDef.parameters) {
      const valid = Value.Check(toolDef.parameters, block.input);
      if (!valid) {
        const errors = [...Value.Errors(toolDef.parameters, block.input)];
        const errorMsg = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
        this.tools.push({
          id: block.id,
          block,
          status: "completed",
          isConcurrencySafe: false,
          result: {
            toolCallId: block.id,
            toolName: block.name,
            result: { content: [{ type: "text", text: `Invalid tool input: ${errorMsg}` }] },
            isError: true,
          },
        });
        this.notifyProgress();
        return;
      }
    }

    // Determine concurrency safety
    let isConcurrencySafe = false;
    if (typeof toolDef.isConcurrencySafe === "function") {
      try {
        isConcurrencySafe = toolDef.isConcurrencySafe(block.input);
      } catch {
        isConcurrencySafe = false;
      }
    } else if (typeof toolDef.isConcurrencySafe === "boolean") {
      isConcurrencySafe = toolDef.isConcurrencySafe;
    }

    this.tools.push({
      id: block.id,
      block,
      status: "queued",
      isConcurrencySafe,
    });

    this.processQueue();
  }

  /**
   * Non-blocking generator that yields completed results in order.
   */
  *getCompletedResults(): Generator<ToolCallResult, void> {
    if (this.discarded) return;

    for (const tool of this.tools) {
      if (tool.status === "yielded") continue;

      if (tool.status === "completed" && tool.result) {
        tool.status = "yielded";
        yield tool.result;
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        // Non-concurrent tool still executing — maintain order, stop here
        break;
      } else if (tool.status === "queued") {
        break;
      }
    }
  }

  /**
   * Async generator that waits for and yields all remaining results.
   */
  async *getRemainingResults(): AsyncGenerator<ToolCallResult, void> {
    while (this.hasUnfinishedTools()) {
      if (this.discarded) return;

      this.processQueue();

      // Yield any completed results
      for (const result of this.getCompletedResults()) {
        yield result;
      }

      // If still unfinished, wait for progress
      if (this.hasUnfinishedTools()) {
        const executing = this.tools.filter((t) => t.status === "executing" && t.promise);
        if (executing.length > 0) {
          const progressPromise = new Promise<void>((resolve) => {
            this.progressResolve = resolve;
          });
          await Promise.race([
            ...executing.map((t) => t.promise!),
            progressPromise,
          ]);
        }
      }
    }

    // Final yield of any remaining completed results
    for (const result of this.getCompletedResults()) {
      yield result;
    }
  }

  /**
   * Discard all pending and in-progress tools. Used on streaming fallback.
   */
  discard(): void {
    this.discarded = true;
    this.notifyProgress();
  }

  private hasUnfinishedTools(): boolean {
    return this.tools.some((t) => t.status !== "yielded");
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter((t) => t.status === "executing");
    if (executing.length === 0) return true;
    if (isConcurrencySafe && executing.every((t) => t.isConcurrencySafe)) return true;
    return false;
  }

  private processQueue(): void {
    for (const tool of this.tools) {
      if (tool.status !== "queued") continue;

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        this.executeTool(tool);
      } else if (!tool.isConcurrencySafe) {
        // Non-concurrent tool can't run yet — don't skip to later tools
        break;
      }
    }
  }

  private executeTool(tracked: TrackedTool): void {
    tracked.status = "executing";
    const toolDef = this.config.tools.find((t) => t.name === tracked.block.name);

    tracked.promise = (async () => {
      try {
        if (this.discarded || this.config.signal.aborted) {
          tracked.result = this.makeSyntheticError(tracked, this.discarded ? "streaming_fallback" : "user_interrupted");
          tracked.status = "completed";
          this.notifyProgress();
          return;
        }

        // Before hook
        if (this.config.beforeToolCall) {
          const hookResult = await this.config.beforeToolCall({
            toolName: tracked.block.name,
            toolCallId: tracked.block.id,
            args: tracked.block.input,
          });
          if (hookResult?.block) {
            tracked.result = {
              toolCallId: tracked.block.id,
              toolName: tracked.block.name,
              result: { content: [{ type: "text", text: hookResult.reason ?? "Tool call blocked" }] },
              isError: true,
            };
            tracked.status = "completed";
            this.notifyProgress();
            return;
          }
        }

        // Approval
        if (toolDef?.approvalAction && !this.config.approval.isYolo()) {
          const approved = await this.config.approval.request(
            toolDef.name,
            toolDef.approvalAction,
            `Execute ${toolDef.label}`,
            tracked.block.id,
          );
          if (!approved) {
            tracked.result = {
              toolCallId: tracked.block.id,
              toolName: tracked.block.name,
              result: { content: [{ type: "text", text: "Tool call rejected by user" }] },
              isError: true,
            };
            tracked.status = "completed";
            this.notifyProgress();
            return;
          }
        }

        this.config.onEvent({
          type: "tool_execution_start",
          toolCallId: tracked.block.id,
          toolName: tracked.block.name,
          args: tracked.block.input,
        });

        let result: AgentToolResult;
        let isError = false;

        try {
          const ctx: ToolExecutionContext = {
            signal: this.config.signal,
            onUpdate: (partial) => {
              this.config.onEvent({
                type: "tool_execution_update",
                toolCallId: tracked.block.id,
                toolName: tracked.block.name,
                partialResult: partial,
              });
            },
            approval: this.config.approval,
            agentName: this.config.agentName,
          };
          result = await toolDef!.execute(tracked.block.id, tracked.block.input as any, ctx);
        } catch (err) {
          result = {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          };
          isError = true;
          // Cascade Bash errors to siblings
          if (tracked.block.name === "Bash" || tracked.block.name === "bash") {
            this.hasErrored = true;
          }
        }

        // Truncate oversized results
        result = this.truncateResult(result, this.config.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS);

        // After hook
        if (this.config.afterToolCall) {
          const hookResult = await this.config.afterToolCall({
            toolName: tracked.block.name,
            toolCallId: tracked.block.id,
            args: tracked.block.input,
            result,
            isError,
          });
          if (hookResult) {
            if (hookResult.content) result = { ...result, content: hookResult.content };
            if (hookResult.isError !== undefined) isError = hookResult.isError;
          }
        }

        this.config.onEvent({
          type: "tool_execution_end",
          toolCallId: tracked.block.id,
          toolName: tracked.block.name,
          result,
          isError,
        });

        tracked.result = {
          toolCallId: tracked.block.id,
          toolName: tracked.block.name,
          result,
          isError,
        };
        tracked.status = "completed";
      } catch (err) {
        tracked.result = this.makeSyntheticError(tracked, "execution_error");
        tracked.status = "completed";
      }

      this.notifyProgress();
      // Process next queued tools now that this one is done
      this.processQueue();
    })();
  }

  private makeSyntheticError(tracked: TrackedTool, reason: string): ToolCallResult {
    const reasonText =
      reason === "streaming_fallback"
        ? "Tool execution cancelled — streaming fallback occurred"
        : reason === "sibling_error"
        ? "Tool execution cancelled — sibling tool errored"
        : reason === "user_interrupted"
        ? "Tool execution cancelled — user interrupted"
        : `Tool execution failed: ${reason}`;

    return {
      toolCallId: tracked.block.id,
      toolName: tracked.block.name,
      result: { content: [{ type: "text", text: reasonText }] },
      isError: true,
    };
  }

  private notifyProgress(): void {
    if (this.progressResolve) {
      this.progressResolve();
      this.progressResolve = null;
    }
  }

  private truncateResult(result: AgentToolResult, maxChars: number): AgentToolResult {
    let totalChars = 0;
    for (const block of result.content) {
      if (block.type === "text") totalChars += block.text.length;
    }
    if (totalChars <= maxChars) return result;

    const truncatedContent: AgentToolResult["content"] = [];
    let remaining = maxChars;
    const suffix = `\n\n[Truncated: result exceeded ${maxChars} characters. Original size: ${totalChars} characters]`;
    remaining -= suffix.length;

    for (const block of result.content) {
      if (block.type !== "text") {
        truncatedContent.push(block);
        continue;
      }
      if (remaining <= 0) break;
      if (block.text.length <= remaining) {
        truncatedContent.push(block);
        remaining -= block.text.length;
      } else {
        truncatedContent.push({ type: "text", text: block.text.slice(0, remaining) + suffix });
        remaining = 0;
      }
    }

    if (truncatedContent.length === 0) {
      truncatedContent.push({ type: "text", text: suffix.trimStart() } as TextContent);
    }

    return { ...result, content: truncatedContent };
  }
}
