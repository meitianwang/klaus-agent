// Hook executor — abstraction over hook dispatch for tool execution pipeline.
//
// Aligned with claude-code's utils/hooks.ts execution engine:
//   - AggregatedHookResult type matches claude-code's aggregated hook output
//   - HookExecutor interface abstracts over command/callback/extension hook dispatch
//   - ExtensionRunnerHookExecutor adapts the existing ExtensionRunner
//   - checkRuleBasedPermissions implements rule-based permission filtering
//
// claude-code's utils/hooks.ts is ~4000 lines of command spawning, HTTP calls,
// prompt hooks, agent hooks, etc. We abstract this behind HookExecutor so the
// orchestration layer (tool-hooks.ts) stays identical to claude-code while the
// execution engine can be swapped.

import type {
  PermissionResult,
  PermissionDecisionReason,
  ToolPermissionContext,
  PermissionRuleSource,
  AgentTool,
  ToolExecutionContext,
  PromptRequest,
  PromptResponse,
} from "../tools/types.js";
import type { AttachmentMessage, HookBlockingError } from "../llm/types.js";

// =============================================================================
// AggregatedHookResult — aligned with claude-code's types/hooks.ts
// =============================================================================

/**
 * Aggregated result from hook execution.
 * Aligned with claude-code's AggregatedHookResult type.
 *
 * Each field corresponds to a specific hook output capability:
 * - message: progress/attachment message to display
 * - blockingError: exit-code-2 or {decision:"block"} — stops tool execution
 * - preventContinuation: hook wants to stop the agent loop after this tool
 * - stopReason: human-readable reason for stopping
 * - permissionBehavior: hook's permission decision (allow/deny/ask/passthrough)
 * - hookPermissionDecisionReason: reason string for the permission decision
 * - hookSource: source identifier for the hook (e.g. plugin root, skill root)
 * - additionalContexts: extra context strings injected into conversation
 * - updatedInput: modified tool input from hook
 * - updatedMCPToolOutput: modified MCP tool output from PostToolUse hook
 * - retry: PermissionDenied hook says command is now approved
 */
export type AggregatedHookResult = {
  message?: AttachmentMessage;
  blockingError?: HookBlockingError;
  preventContinuation?: boolean;
  stopReason?: string;
  hookPermissionDecisionReason?: string;
  hookSource?: string;
  permissionBehavior?: PermissionResult["behavior"];
  additionalContexts?: string[];
  initialUserMessage?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  permissionRequestResult?: {
    behavior: 'allow' | 'deny';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown;
    interrupt?: boolean;
  };
  retry?: boolean;
};

// =============================================================================
// Hook input types — aligned with claude-code's SDK hook input types
// =============================================================================

export type PreToolUseHookInput = {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};

export type PostToolUseHookInput = {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
};

export type PostToolUseFailureHookInput = {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;
};

// =============================================================================
// HookExecutor interface — abstraction over hook dispatch
// =============================================================================

/**
 * Abstraction over hook execution.
 * Aligned with claude-code's executePreToolHooks/executePostToolHooks/executePostToolUseFailureHooks
 * from utils/hooks.ts.
 *
 * Implementations:
 * - ExtensionRunnerHookExecutor: delegates to ExtensionRunner (existing)
 * - SDK consumers can provide custom implementations for command/callback hooks
 */
export interface HookExecutor {
  executePreToolHooks(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    context: ToolExecutionContext,
    permissionMode?: string,
    signal?: AbortSignal,
    timeoutMs?: number,
    requestPrompt?: (
      sourceName: string,
      toolInputSummary?: string | null,
    ) => (request: PromptRequest) => Promise<PromptResponse>,
    toolInputSummary?: string | null,
  ): AsyncIterable<AggregatedHookResult>;

  executePostToolHooks(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    toolResponse: unknown,
    context: ToolExecutionContext,
    permissionMode?: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): AsyncIterable<AggregatedHookResult>;

  executePostToolUseFailureHooks(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    error: string,
    context: ToolExecutionContext,
    isInterrupt?: boolean,
    permissionMode?: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): AsyncIterable<AggregatedHookResult>;

  /**
   * Execute PermissionDenied hooks when a tool is denied by the classifier.
   * Aligned with claude-code's executePermissionDeniedHooks.
   * Returns { retry: boolean } per hook result.
   *
   * In claude-code this is gated on `feature('TRANSCRIPT_CLASSIFIER')`.
   * Since klaus-agent doesn't have feature flags, callers should gate on
   * whether a classifier-based denial triggered the call (i.e. only invoke
   * when the denial `decisionReason.type === 'classifier'`).
   */
  executePermissionDeniedHooks?(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    reason: string,
    context: ToolExecutionContext,
    permissionMode: string | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<{ retry?: boolean }>;
}

// =============================================================================
// ExtensionRunnerHookExecutor — adapts ExtensionRunner to HookExecutor
// =============================================================================

import type { ExtensionRunner } from "../extensions/runner.js";

/**
 * Adapts the existing ExtensionRunner (tool_call/tool_result events) to the
 * HookExecutor interface. This bridges klaus-agent's extension system with
 * the claude-code-aligned hook orchestration layer.
 */
export class ExtensionRunnerHookExecutor implements HookExecutor {
  constructor(private readonly runner: ExtensionRunner) {}

  async *executePreToolHooks(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    context: ToolExecutionContext,
    permissionMode?: string,
    signal?: AbortSignal,
    _timeoutMs?: number,
    _requestPrompt?: (
      sourceName: string,
      toolInputSummary?: string | null,
    ) => (request: PromptRequest) => Promise<PromptResponse>,
    _toolInputSummary?: string | null,
  ): AsyncGenerator<AggregatedHookResult> {
    // Delegate to ExtensionRunner's tool_call event
    const result = await this.runner.emitToolCall({
      toolName,
      toolUseId: toolUseID,
      args: toolInput,
    });

    if (!result) return;

    // Map ExtensionRunner's ToolCallEventResult to AggregatedHookResult
    if (result.block) {
      yield {
        blockingError: {
          blockingError: result.reason ?? "Blocked by extension",
          command: `extension:${toolName}`,
        },
      };
    }
  }

  async *executePostToolHooks(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    toolResponse: unknown,
    context: ToolExecutionContext,
    permissionMode?: string,
    signal?: AbortSignal,
    _timeoutMs?: number,
  ): AsyncGenerator<AggregatedHookResult> {
    // Delegate to ExtensionRunner's tool_result event
    const result = await this.runner.emitToolResult({
      toolName,
      toolUseId: toolUseID,
      args: toolInput,
      result: { data: toolResponse },
      isError: false,
    });

    if (!result) return;

    // Map ToolResultEventResult to AggregatedHookResult
    if (result.content !== undefined || result.isError !== undefined) {
      yield {
        updatedMCPToolOutput: result.content,
      };
    }
  }

  async *executePostToolUseFailureHooks(
    toolName: string,
    toolUseID: string,
    toolInput: unknown,
    error: string,
    context: ToolExecutionContext,
    isInterrupt?: boolean,
    permissionMode?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AggregatedHookResult> {
    // Delegate to ExtensionRunner's tool_result event with isError=true
    await this.runner.emitToolResult({
      toolName,
      toolUseId: toolUseID,
      args: toolInput,
      result: { data: error },
      isError: true,
    });
    // PostToolUseFailure hooks in ExtensionRunner don't produce aggregated results
  }
}

// =============================================================================
// checkRuleBasedPermissions — rule-based permission check
// =============================================================================

/**
 * Check rule-based permissions against ToolPermissionContext.
 * Aligned with claude-code's checkRuleBasedPermissions from utils/permissions/permissions.ts.
 *
 * Returns null if no rule matches (normal permission flow continues).
 * Returns PermissionResult if a deny or ask rule matches, or if the tool's
 * own checkPermissions() returns a deny/ask/safetyCheck result.
 *
 * Used by resolveHookPermissionDecision to enforce the invariant that
 * hook 'allow' does NOT bypass settings.json deny/ask rules OR tool-specific
 * permission logic (e.g., Bash subcommand denies, path safety checks).
 *
 * Steps (aligned with claude-code):
 *   1a. Entire tool denied by rule
 *   1b. Entire tool has ask rule (with sandbox auto-allow bypass for Bash)
 *   1c. tool.checkPermissions() — tool-specific permission logic
 *   1d. Tool implementation denied (from 1c)
 *   1f. Content-specific ask rules from tool.checkPermissions (e.g. Bash(npm publish:*))
 *   1g. Safety checks (.git/, .claude/, .vscode/, shell configs) — bypass-immune
 */
export async function checkRuleBasedPermissions(
  tool: AgentTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PermissionResult | null> {
  const appState = context.getAppState();
  const permContext = (appState as any).toolPermissionContext as ToolPermissionContext | undefined;
  if (!permContext) return null;

  // Prepare tool-specific matcher for content-pattern matching (e.g., Bash
  // subcommand patterns). Falls back to generic getToolInputString() if the
  // tool doesn't implement preparePermissionMatcher.
  const toolMatcher = await prepareToolMatcher(tool, input);

  // 1a. Entire tool is denied by rule (highest priority)
  const denyMatch = matchRules(tool.name, input, permContext.alwaysDenyRules, toolMatcher);
  if (denyMatch) {
    const reason: PermissionDecisionReason = {
      type: "rule",
      rule: {
        source: denyMatch.source,
        ruleBehavior: "deny",
        ruleValue: { toolName: tool.name, ruleContent: denyMatch.pattern },
      },
    };
    return {
      behavior: "deny",
      message: `Denied by ${denyMatch.source} rule: ${denyMatch.pattern ?? tool.name}`,
      decisionReason: reason,
    };
  }

  // 1b. Entire tool has an ask rule
  const askMatch = matchRules(tool.name, input, permContext.alwaysAskRules, toolMatcher);
  if (askMatch) {
    // Sandbox auto-allow: In sandboxed environments, certain Bash commands can
    // skip the ask rule when sandboxing is enabled and the command will be
    // sandboxed. This mirrors claude-code's canSandboxAutoAllow path.
    // When a SandboxManager-like integration is available on the context,
    // it can expose isSandboxAutoAllowEnabled() to enable this bypass.
    const canSandboxAutoAllow =
      tool.name === "Bash" &&
      typeof (context as any).isSandboxAutoAllowEnabled === "function" &&
      (context as any).isSandboxAutoAllowEnabled(input);

    if (!canSandboxAutoAllow) {
      const reason: PermissionDecisionReason = {
        type: "rule",
        rule: {
          source: askMatch.source,
          ruleBehavior: "ask",
          ruleValue: { toolName: tool.name, ruleContent: askMatch.pattern },
        },
      };
      return {
        behavior: "ask",
        message: `Requires approval per ${askMatch.source} rule: ${askMatch.pattern ?? tool.name}`,
        decisionReason: reason,
      };
    }
    // Fall through to let tool.checkPermissions handle command-specific rules
  }

  // 1c. Tool-specific permission check (e.g., Bash subcommand rules, path
  // safety checks for .git/, .claude/, .vscode/, shell configs).
  // Aligned with claude-code's step 1c: call tool.checkPermissions() and
  // inspect the result for deny, content-specific ask rules, and safety checks.
  //
  // Parse input with tool's inputSchema before calling checkPermissions so
  // tools get validated/coerced input for permission decisions. If parsing
  // fails, pass the raw input (matching claude-code's passthrough on parse error).
  let parsedInput = input;
  try {
    const parseResult = tool.inputSchema?.safeParse(input);
    if (parseResult?.success) {
      parsedInput = parseResult.data as Record<string, unknown>;
    }
  } catch {
    // Parse error — use raw input (passthrough)
  }

  let toolPermissionResult: PermissionResult | undefined;
  try {
    if (tool.checkPermissions) {
      toolPermissionResult = await tool.checkPermissions(parsedInput, context);
    }
  } catch (e: unknown) {
    // Rethrow abort errors so they propagate properly
    if (e instanceof Error && (e.name === "AbortError" || e.name === "APIUserAbortError")) {
      throw e;
    }
    context.logForDebugging?.(`tool.checkPermissions error for ${tool.name}: ${e}`, { level: "error" });
  }

  if (toolPermissionResult) {
    // 1d. Tool implementation denied (e.g., Bash subcommand deny rules)
    if (toolPermissionResult.behavior === "deny") {
      return toolPermissionResult;
    }

    // 1f. Content-specific ask rules from tool.checkPermissions
    // (e.g., Bash(npm publish:*) -> {ask, type:'rule', ruleBehavior:'ask'})
    if (
      toolPermissionResult.behavior === "ask" &&
      toolPermissionResult.decisionReason?.type === "rule" &&
      toolPermissionResult.decisionReason.rule.ruleBehavior === "ask"
    ) {
      return toolPermissionResult;
    }

    // 1g. Safety checks (e.g., .git/, .claude/, .vscode/, shell configs) are
    // bypass-immune — they must prompt even when a PreToolUse hook returned
    // allow. checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these.
    if (
      toolPermissionResult.behavior === "ask" &&
      toolPermissionResult.decisionReason?.type === "safetyCheck"
    ) {
      return toolPermissionResult;
    }
  }

  // No rule-based objection
  return null;
}

/**
 * Match a tool name against permission rules organized by source.
 * Returns the first matching rule's source and pattern, or null.
 *
 * If the tool has a preparePermissionMatcher(), it is used for content-pattern
 * matching instead of the generic getToolInputString() fallback. This mirrors
 * claude-code's delegation to tool.preparePermissionMatcher().
 */
function matchRules(
  toolName: string,
  input: Record<string, unknown>,
  rulesBySource: { [T in PermissionRuleSource]?: string[] },
  toolMatcher?: (pattern: string) => boolean,
): { source: PermissionRuleSource; pattern?: string } | null {
  for (const [source, patterns] of Object.entries(rulesBySource)) {
    if (!patterns) continue;
    for (const pattern of patterns) {
      if (matchesToolPattern(toolName, input, pattern, toolMatcher)) {
        return { source: source as PermissionRuleSource, pattern };
      }
    }
  }
  return null;
}

/**
 * Prepare a tool-specific matcher if the tool supports it.
 * Returns undefined if the tool does not have preparePermissionMatcher.
 */
async function prepareToolMatcher(
  tool: AgentTool,
  input: Record<string, unknown>,
): Promise<((pattern: string) => boolean) | undefined> {
  if (typeof tool.preparePermissionMatcher !== "function") return undefined;
  try {
    return await tool.preparePermissionMatcher(input);
  } catch {
    return undefined;
  }
}

/**
 * Check if a tool name + input matches a permission rule pattern.
 * Patterns follow claude-code's permission rule syntax:
 * - "ToolName" — matches tool by name (no content filter)
 * - "ToolName(content)" — matches tool by name with content filter
 * - "Bash(git *)" — matches Bash tool with command starting with "git "
 *
 * When a toolMatcher is provided (from tool.preparePermissionMatcher), it is
 * used for content matching. Otherwise falls back to the generic
 * getToolInputString() which checks common input keys.
 */
function matchesToolPattern(
  toolName: string,
  input: Record<string, unknown>,
  pattern: string,
  toolMatcher?: (pattern: string) => boolean,
): boolean {
  // Parse "ToolName(content)" pattern
  const parenIdx = pattern.indexOf("(");
  if (parenIdx === -1) {
    // Simple tool name match (no content filter)
    return pattern === toolName;
  }

  const patternToolName = pattern.slice(0, parenIdx);
  if (patternToolName !== toolName) return false;

  // Extract content filter
  const contentFilter = pattern.slice(parenIdx + 1, -1); // strip parens
  if (!contentFilter) return true; // empty parens = match all

  // Use tool-specific matcher if available (e.g., Bash subcommand matching)
  if (toolMatcher) {
    return toolMatcher(contentFilter);
  }

  // Fallback: match against common input fields
  const inputStr = getToolInputString(input);
  if (!inputStr) return false;

  // Simple glob: trailing * means prefix match
  if (contentFilter.endsWith("*")) {
    const prefix = contentFilter.slice(0, -1);
    return inputStr.startsWith(prefix);
  }

  return inputStr === contentFilter;
}

/**
 * Extract a string representation of tool input for pattern matching.
 * Checks common input fields: command, file_path, pattern, query, url.
 * This is the generic fallback when tool.preparePermissionMatcher is not available.
 */
function getToolInputString(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "file_path", "pattern", "query", "url"]) {
    const val = input[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}
