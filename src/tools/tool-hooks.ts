// Tool hook orchestration — async generators for PreToolUse/PostToolUse/PostToolUseFailure.
//
// Delegates to HookExecutor (from hooks/hook-executor.ts) for actual hook dispatch.

import type {
  AgentTool,
  ToolExecutionContext,
  CanUseToolFn,
  PermissionResult,
  PermissionDecision,
  PermissionDecisionReason,
} from "./types.js";
import type { AssistantMessage, AttachmentMessage, HookBlockingError, ProgressMessage, HookProgress } from "../llm/types.js";
import type { AggregatedHookResult } from "../hooks/hook-executor.js";
import { checkRuleBasedPermissions } from "../hooks/hook-executor.js";

function isMcpTool(tool: AgentTool): boolean {
  return tool.name?.startsWith('mcp__') || tool.isMcp === true;
}

function createAttachmentMessage(attachment: AttachmentMessage["attachment"]): AttachmentMessage {
  return { type: "attachment", attachment };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getRuleBehaviorDescription(behavior: string): string {
  switch (behavior) {
    case "deny": return "denied";
    case "allow": return "allowed";
    default: return "asked for confirmation for";
  }
}

function getPreToolHookBlockingMessage(
  hookName: string,
  blockingError: HookBlockingError,
): string {
  return blockingError.blockingError
    ? `Hook ${hookName} blocked execution: ${blockingError.blockingError}`
    : `Hook ${hookName} blocked execution`;
}

type MessageUpdateLazy<M = any> = {
  message: M;
  contextModifier?: {
    toolUseID: string;
    modifyContext: (context: ToolExecutionContext) => ToolExecutionContext;
  };
};

export type PostToolUseHooksResult<Output = unknown> =
  | MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>
  | { updatedMCPToolOutput: Output };

/** @deprecated Use PostToolUseHooksResult instead */
export type PostToolHookYield<Output = unknown> = PostToolUseHooksResult<Output>;

export type PreToolHookYield =
  | { type: "message"; message: MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>> }
  | { type: "hookPermissionResult"; hookPermissionResult: PermissionResult }
  | { type: "hookUpdatedInput"; updatedInput: Record<string, unknown> }
  | { type: "preventContinuation"; shouldPreventContinuation: boolean }
  | { type: "stopReason"; stopReason: string }
  | { type: "additionalContext"; message: MessageUpdateLazy<AttachmentMessage> }
  | { type: "stop" };

/**
 * Run PostToolUse hooks and yield results.
 *
 * Yields either:
 * - MessageUpdateLazy<AttachmentMessage> for hook messages
 * - { updatedMCPToolOutput } for MCP tool output modifications
 */
export async function* runPostToolUseHooks<Output>(
  toolUseContext: ToolExecutionContext,
  tool: AgentTool,
  toolUseID: string,
  messageId: string,
  toolInput: Record<string, unknown>,
  toolResponse: Output,
  requestId: string | undefined,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): AsyncGenerator<PostToolUseHooksResult<Output>> {
  const hookExecutor = toolUseContext.hookExecutor;
  if (!hookExecutor) return;

  // Track accumulated toolOutput so subsequent hooks see prior modifications
  let toolOutput = toolResponse;
  const postToolStartTime = Date.now();

  try {
    const permissionMode = (toolUseContext.getAppState() as any)?.toolPermissionContext?.mode;

    for await (const result of hookExecutor.executePostToolHooks(
      tool.name,
      toolUseID,
      toolInput,
      toolOutput,
      toolUseContext,
      permissionMode,
      toolUseContext.abortController.signal,
    )) {
      try {
        // Cancelled
        if (
          (result.message as any)?.type === "attachment" &&
          (result.message as any)?.attachment?.type === "hook_cancelled"
        ) {
          toolUseContext.analytics?.logEvent("tengu_post_tool_hooks_cancelled", {
            toolName: toolUseContext.analytics?.sanitizeToolName(tool.name) ?? tool.name,
            queryChainId: toolUseContext.queryTracking?.chainId,
            queryDepth: toolUseContext.queryTracking?.depth,
          });
          yield {
            message: createAttachmentMessage({
              type: "hook_cancelled",
              hookName: `PostToolUse:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUse",
            }),
          };
          continue;
        }

        // Hook message — skip hook_blocking_error duplicates (#31301)
        if (
          result.message &&
          !(
            (result.message as any).type === "attachment" &&
            (result.message as any).attachment?.type === "hook_blocking_error"
          )
        ) {
          yield { message: result.message };
        }

        // Blocking error
        if (result.blockingError) {
          yield {
            message: createAttachmentMessage({
              type: "hook_blocking_error",
              hookName: `PostToolUse:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUse",
              blockingError: result.blockingError,
            }),
          };
        }

        // Prevent continuation
        if (result.preventContinuation) {
          yield {
            message: createAttachmentMessage({
              type: "hook_stopped_continuation",
              message: result.stopReason || "Execution stopped by PostToolUse hook",
              hookName: `PostToolUse:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUse",
            }),
          };
          return;
        }

        // Additional context
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            message: createAttachmentMessage({
              type: "hook_additional_context",
              content: result.additionalContexts,
              hookName: `PostToolUse:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUse",
            }),
          };
        }

        // Updated MCP tool output — accumulate so subsequent hooks see prior modifications
        if (result.updatedMCPToolOutput && isMcpTool(tool)) {
          toolOutput = result.updatedMCPToolOutput as Output;
          yield {
            updatedMCPToolOutput: toolOutput,
          };
        }
      } catch (error) {
        const postToolDurationMs = Date.now() - postToolStartTime;
        toolUseContext.analytics?.logEvent("tengu_post_tool_hook_error", {
          messageID: messageId,
          toolName: toolUseContext.analytics?.sanitizeToolName(tool.name) ?? tool.name,
          isMcp: tool.isMcp ?? false,
          duration: postToolDurationMs,
          queryChainId: toolUseContext.queryTracking?.chainId,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType ? { mcpServerType } : {}),
          ...(requestId ? { requestId } : {}),
        });
        yield {
          message: createAttachmentMessage({
            type: "hook_error_during_execution",
            content: formatError(error),
            hookName: `PostToolUse:${tool.name}`,
            toolUseID,
            hookEvent: "PostToolUse",
          }),
        };
      }
    }
  } catch (error) {
    toolUseContext.logForDebugging?.(`Post-tool hook outer error: ${formatError(error)}`, { level: "error" });
  }
}

/**
 * Run PostToolUseFailure hooks and yield results.
 */
export async function* runPostToolUseFailureHooks(
  toolUseContext: ToolExecutionContext,
  tool: AgentTool,
  toolUseID: string,
  messageId: string,
  processedInput: unknown,
  error: string,
  isInterrupt: boolean | undefined,
  requestId: string | undefined,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): AsyncGenerator<MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>> {
  const hookExecutor = toolUseContext.hookExecutor;
  if (!hookExecutor) return;

  const postToolStartTime = Date.now();

  try {
    const permissionMode = (toolUseContext.getAppState() as any)?.toolPermissionContext?.mode;

    for await (const result of hookExecutor.executePostToolUseFailureHooks(
      tool.name,
      toolUseID,
      processedInput,
      error,
      toolUseContext,
      isInterrupt,
      permissionMode,
      toolUseContext.abortController.signal,
    )) {
      try {
        // Cancelled
        if (
          (result.message as any)?.type === "attachment" &&
          (result.message as any)?.attachment?.type === "hook_cancelled"
        ) {
          toolUseContext.analytics?.logEvent("tengu_post_tool_failure_hooks_cancelled", {
            toolName: toolUseContext.analytics?.sanitizeToolName(tool.name) ?? tool.name,
            queryChainId: toolUseContext.queryTracking?.chainId,
            queryDepth: toolUseContext.queryTracking?.depth,
          });
          yield {
            message: createAttachmentMessage({
              type: "hook_cancelled",
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUseFailure",
            }),
          };
          continue;
        }

        // Hook message — skip hook_blocking_error duplicates
        if (
          result.message &&
          !(
            (result.message as any).type === "attachment" &&
            (result.message as any).attachment?.type === "hook_blocking_error"
          )
        ) {
          yield { message: result.message };
        }

        // Blocking error
        if (result.blockingError) {
          yield {
            message: createAttachmentMessage({
              type: "hook_blocking_error",
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUseFailure",
              blockingError: result.blockingError,
            }),
          };
        }

        // Additional context
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            message: createAttachmentMessage({
              type: "hook_additional_context",
              content: result.additionalContexts,
              hookName: `PostToolUseFailure:${tool.name}`,
              toolUseID,
              hookEvent: "PostToolUseFailure",
            }),
          };
        }
      } catch (error) {
        const postToolDurationMs = Date.now() - postToolStartTime;
        toolUseContext.analytics?.logEvent("tengu_post_tool_failure_hook_error", {
          messageID: messageId,
          toolName: toolUseContext.analytics?.sanitizeToolName(tool.name) ?? tool.name,
          isMcp: tool.isMcp ?? false,
          duration: postToolDurationMs,
          queryChainId: toolUseContext.queryTracking?.chainId,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType ? { mcpServerType } : {}),
          ...(requestId ? { requestId } : {}),
        });
        yield {
          message: createAttachmentMessage({
            type: "hook_error_during_execution",
            content: formatError(error),
            hookName: `PostToolUseFailure:${tool.name}`,
            toolUseID,
            hookEvent: "PostToolUseFailure",
          }),
        };
      }
    }
  } catch (error) {
    toolUseContext.logForDebugging?.(`Post-tool failure hook outer error: ${formatError(error)}`, { level: "error" });
  }
}

/**
 * Resolve a PreToolUse hook's permission result into a final PermissionDecision.
 *
 * Key invariant: hook 'allow' does NOT bypass settings.json deny/ask rules —
 * checkRuleBasedPermissions still applies (inc-4788 analog).
 *
 * Also handles:
 * - requiresUserInteraction guard
 * - requireCanUseTool guard
 * - 'ask' forceDecision passthrough
 *
 * Permission precedence: deny > ask > allow
 */
export async function resolveHookPermissionDecision(
  hookPermissionResult: PermissionResult | undefined,
  tool: AgentTool,
  input: Record<string, unknown>,
  toolUseContext: ToolExecutionContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{
  decision: PermissionDecision;
  input: Record<string, unknown>;
}> {
  const requiresInteraction = tool.requiresUserInteraction?.();
  const requireCanUseTool = toolUseContext.requireCanUseTool;

  if (hookPermissionResult?.behavior === "allow") {
    const hookInput = hookPermissionResult.updatedInput ?? input;

    // Hook provided updatedInput for an interactive tool — the hook IS the
    // user interaction (e.g. headless wrapper that collected AskUserQuestion
    // answers). Treat as non-interactive for the rule-check path.
    const interactionSatisfied =
      requiresInteraction && hookPermissionResult.updatedInput !== undefined;

    if ((requiresInteraction && !interactionSatisfied) || requireCanUseTool) {
      toolUseContext.logForDebugging?.(
        `Hook approved tool use for ${tool.name}, but canUseTool is required`,
      );
      return {
        decision: await canUseTool(tool, hookInput, toolUseContext, assistantMessage, toolUseID) as PermissionDecision,
        input: hookInput,
      };
    }

    // Hook allow skips the interactive prompt, but deny/ask rules still apply.
    const ruleCheck = await checkRuleBasedPermissions(tool, hookInput, toolUseContext);
    if (ruleCheck === null) {
      // No deny/ask rule — hook approval stands
      toolUseContext.logForDebugging?.(
        interactionSatisfied
          ? `Hook satisfied user interaction for ${tool.name} via updatedInput`
          : `Hook approved tool use for ${tool.name}, bypassing permission prompt`,
      );
      return { decision: hookPermissionResult as PermissionDecision, input: hookInput };
    }
    if (ruleCheck.behavior === "deny") {
      toolUseContext.logForDebugging?.(
        `Hook approved tool use for ${tool.name}, but deny rule overrides: ${ruleCheck.message}`,
      );
      return { decision: ruleCheck as PermissionDecision, input: hookInput };
    }
    // ask rule — dialog required despite hook approval
    toolUseContext.logForDebugging?.(
      `Hook approved tool use for ${tool.name}, but ask rule requires prompt`,
    );
    return {
      decision: await canUseTool(tool, hookInput, toolUseContext, assistantMessage, toolUseID) as PermissionDecision,
      input: hookInput,
    };
  }

  if (hookPermissionResult?.behavior === "deny") {
    toolUseContext.logForDebugging?.(`Hook denied tool use for ${tool.name}`);
    return { decision: hookPermissionResult as PermissionDecision, input };
  }

  // No hook decision or 'ask' — normal permission flow
  const askInput =
    hookPermissionResult?.behavior === "ask" && hookPermissionResult.updatedInput
      ? hookPermissionResult.updatedInput
      : input;

  // 'ask' case: pass forceDecision so dialog shows the hook's ask message
  const forceDecision = hookPermissionResult?.behavior === "ask" ? hookPermissionResult : undefined;
  return {
    decision: await canUseTool(tool, askInput, toolUseContext, assistantMessage, toolUseID, forceDecision) as PermissionDecision,
    input: askInput,
  };
}

/**
 * Run PreToolUse hooks and yield typed results.
 *
 * Processes AggregatedHookResult from HookExecutor and yields:
 * - message: hook progress/attachment messages
 * - hookPermissionResult: permission decisions from hooks
 * - hookUpdatedInput: modified tool input (passthrough, no permission decision)
 * - preventContinuation: hook wants to stop agent loop after this tool
 * - stopReason: human-readable reason for stopping
 * - additionalContext: extra context injected into conversation
 * - stop: abort — stop tool execution entirely
 */
export async function* runPreToolUseHooks(
  toolUseContext: ToolExecutionContext,
  tool: AgentTool,
  processedInput: Record<string, unknown>,
  toolUseID: string,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): AsyncGenerator<
  | { type: "message"; message: MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>> }
  | { type: "hookPermissionResult"; hookPermissionResult: PermissionResult }
  | { type: "hookUpdatedInput"; updatedInput: Record<string, unknown> }
  | { type: "preventContinuation"; shouldPreventContinuation: boolean }
  | { type: "stopReason"; stopReason: string }
  | { type: "additionalContext"; message: MessageUpdateLazy<AttachmentMessage> }
  | { type: "stop" }
> {
  const hookExecutor = toolUseContext.hookExecutor;
  if (!hookExecutor) return;

  const hookStartTime = Date.now();

  try {
    const permissionMode = (toolUseContext.getAppState() as any)?.toolPermissionContext?.mode;

    for await (const result of hookExecutor.executePreToolHooks(
      tool.name,
      toolUseID,
      processedInput,
      toolUseContext,
      permissionMode,
      toolUseContext.abortController.signal,
      undefined, // timeoutMs - use default
      toolUseContext.requestPrompt,
      tool.getToolUseSummary?.(processedInput as any),
    )) {
      try {
        // Hook progress/attachment message
        if (result.message) {
          yield { type: "message", message: { message: result.message } };
        }

        // Blocking error -> deny permission
        if (result.blockingError) {
          const denialMessage = getPreToolHookBlockingMessage(
            `PreToolUse:${tool.name}`,
            result.blockingError,
          );
          yield {
            type: "hookPermissionResult",
            hookPermissionResult: {
              behavior: "deny",
              message: denialMessage,
              decisionReason: {
                type: "hook",
                hookName: `PreToolUse:${tool.name}`,
                reason: denialMessage,
              },
            },
          };
        }

        // Prevent continuation
        if (result.preventContinuation) {
          yield {
            type: "preventContinuation",
            shouldPreventContinuation: true,
          };
          if (result.stopReason) {
            yield { type: "stopReason", stopReason: result.stopReason };
          }
        }

        // Permission behavior from hook
        if (result.permissionBehavior !== undefined) {
          toolUseContext.logForDebugging?.(
            `Hook result has permissionBehavior=${result.permissionBehavior}`,
          );
          const decisionReason: PermissionDecisionReason = {
            type: "hook",
            hookName: `PreToolUse:${tool.name}`,
            hookSource: result.hookSource,
            reason: result.hookPermissionDecisionReason,
          };

          if (result.permissionBehavior === "allow") {
            yield {
              type: "hookPermissionResult",
              hookPermissionResult: {
                behavior: "allow",
                updatedInput: result.updatedInput,
                decisionReason,
              },
            };
          } else if (result.permissionBehavior === "ask") {
            yield {
              type: "hookPermissionResult",
              hookPermissionResult: {
                behavior: "ask",
                updatedInput: result.updatedInput,
                message:
                  result.hookPermissionDecisionReason ||
                  `Hook PreToolUse:${tool.name} ${getRuleBehaviorDescription(result.permissionBehavior)} this tool`,
                decisionReason,
              },
            };
          } else {
            // deny — updatedInput is irrelevant since tool won't run
            yield {
              type: "hookPermissionResult",
              hookPermissionResult: {
                behavior: result.permissionBehavior,
                message:
                  result.hookPermissionDecisionReason ||
                  `Hook PreToolUse:${tool.name} ${getRuleBehaviorDescription(result.permissionBehavior)} this tool`,
                decisionReason,
              },
            };
          }
        }

        // Updated input without permission decision (passthrough)
        if (result.updatedInput && result.permissionBehavior === undefined) {
          yield {
            type: "hookUpdatedInput",
            updatedInput: result.updatedInput,
          };
        }

        // Additional context
        if (result.additionalContexts && result.additionalContexts.length > 0) {
          yield {
            type: "additionalContext",
            message: {
              message: createAttachmentMessage({
                type: "hook_additional_context",
                content: result.additionalContexts,
                hookName: `PreToolUse:${tool.name}`,
                toolUseID,
                hookEvent: "PreToolUse",
              }),
            },
          };
        }

        // Abort check
        if (toolUseContext.abortController.signal.aborted) {
          toolUseContext.analytics?.logEvent("tengu_pre_tool_hooks_cancelled", {
            toolName: toolUseContext.analytics?.sanitizeToolName(tool.name) ?? tool.name,
            queryChainId: toolUseContext.queryTracking?.chainId,
            queryDepth: toolUseContext.queryTracking?.depth,
          });
          yield {
            type: "message",
            message: {
              message: createAttachmentMessage({
                type: "hook_cancelled",
                hookName: `PreToolUse:${tool.name}`,
                toolUseID,
                hookEvent: "PreToolUse",
              }),
            },
          };
          yield { type: "stop" };
          return;
        }
      } catch (error) {
        toolUseContext.logForDebugging?.(`Pre-tool hook inner error: ${formatError(error)}`, { level: "error" });
        const durationMs = Date.now() - hookStartTime;
        toolUseContext.analytics?.logEvent("tengu_pre_tool_hook_error", {
          messageID: messageId,
          toolName: toolUseContext.analytics?.sanitizeToolName(tool.name) ?? tool.name,
          isMcp: tool.isMcp ?? false,
          duration: durationMs,
          queryChainId: toolUseContext.queryTracking?.chainId,
          queryDepth: toolUseContext.queryTracking?.depth,
          ...(mcpServerType ? { mcpServerType } : {}),
          ...(requestId ? { requestId } : {}),
        });
        yield {
          type: "message",
          message: {
            message: createAttachmentMessage({
              type: "hook_error_during_execution",
              content: formatError(error),
              hookName: `PreToolUse:${tool.name}`,
              toolUseID,
              hookEvent: "PreToolUse",
            }),
          },
        };
        yield { type: "stop" };
      }
    }
  } catch (error) {
    toolUseContext.logForDebugging?.(`Pre-tool hook outer error: ${formatError(error)}`, { level: "error" });
    yield { type: "stop" };
    return;
  }
}
