// Tool execution engine — 3-layer architecture aligned with claude-code
//
// Architecture (matching claude-code's toolExecution.ts):
//   runToolUse()                        — outer async generator (tool lookup, abort check, error boundary)
//     └─ streamedCheckPermissionsAndCallTool()  — Stream wrapper (progress events → async iterable)
//          └─ checkPermissionsAndCallTool()     — inner async function (validation, hooks, permissions, call)
//
// Consumers:
//   - StreamingToolExecutor consumes runToolUse() during LLM streaming
//   - runToolsOrchestrated() consumes runToolUse() for batch execution
//   - Legacy executeToolCalls() wraps runToolUse() for backward compat

import type {
  AgentTool,
  AgentToolResult,
  ToolExecutionContext,
  CanUseToolFn,
  ContentBlockParam,
  PermissionResult,
  PermissionDecisionReason,
} from "./types.js";
import { findToolByName, isMcpTool } from "./types.js";
import type { ToolUseBlock, UserMessage, AssistantMessage, Message, ContentBlock, TextContent, AttachmentMessage } from "../llm/types.js";
import { formatZodValidationError, formatError } from "../utils/toolErrors.js";
import { processToolResultBlock, processPreMappedToolResultBlock } from "./tool-result-storage.js";
import {
  CANCEL_MESSAGE,
  withMemoryCorrectionHint,
  createToolResultMessage,
  wrapToolUseError,
} from "../utils/messages.js";
import { buildSchemaNotSentHint } from "./deferred-tools.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  resolveHookPermissionDecision,
  type PreToolHookYield,
  type PostToolUseHooksResult,
} from "./tool-hooks.js";
import { parseGitCommitId } from "../utils/gitOperationTracking.js";
import { randomUUID } from "crypto";

/**
 * Safe JSON.stringify that handles circular references.
 * Aligned with claude-code's jsonStringify from slowOperations.
 */
function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Handle circular references by using a replacer that tracks seen objects
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum total hook duration (ms) to show inline timing summary.
 *  Aligned with claude-code's HOOK_TIMING_DISPLAY_THRESHOLD_MS. */
export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500;

/** Log a debug warning when hooks/permission-decision block for this long.
 *  Aligned with claude-code's SLOW_PHASE_LOG_THRESHOLD_MS. */
const SLOW_PHASE_LOG_THRESHOLD_MS = 2000;

// =============================================================================
// Error classification — aligned with claude-code's classifyToolError
// =============================================================================

/**
 * Classify a tool error into a telemetry-safe string.
 * Avoids leaking sensitive data into analytics.
 */
export function classifyToolError(error: unknown): string {
  // TelemetrySafeError — aligned with claude-code
  // Check for telemetryMessage property first (works even if not instanceof TelemetrySafeError)
  if (
    error &&
    typeof error === "object" &&
    "telemetryMessage" in error &&
    typeof (error as any).telemetryMessage === "string"
  ) {
    return (error as any).telemetryMessage.slice(0, 200);
  }
  if (error instanceof Error) {
    // Node.js filesystem errors have a `code` property (ENOENT, EACCES, etc.)
    const errnoCode = getErrnoCode(error);
    if (typeof errnoCode === "string") {
      return `Error:${errnoCode}`;
    }
    // Stable .name properties that survive minification
    if (error.name && error.name !== "Error" && error.name.length > 3) {
      return error.name.slice(0, 60);
    }
    return "Error";
  }
  return "UnknownError";
}

/**
 * Extract the errno code (e.g., 'ENOENT', 'EACCES') from a caught error.
 * Returns undefined if the error has no code or is not an ErrnoException.
 * Aligned with claude-code's getErrnoCode.
 */
function getErrnoCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return undefined;
}

// =============================================================================
// OTel helpers — aligned with claude-code (BEFORE runToolUse)
// =============================================================================

/**
 * Map a permission rule source to an OTel source string.
 * Aligned with claude-code's ruleSourceToOTelSource.
 */
function ruleSourceToOTelSource(source: string, behavior: 'allow' | 'deny'): string {
  switch (source) {
    case "session":
      return behavior === "deny" ? "user_reject" : "user_temporary";
    case "localSettings":
    case "userSettings":
      return behavior === "deny" ? "user_reject" : "user_permanent";
    default:
      return "config";
  }
}

/**
 * Map a PermissionDecisionReason to an OTel source string.
 * Aligned with claude-code's decisionReasonToOTelSource.
 */
function decisionReasonToOTelSource(
  reason: PermissionDecisionReason | undefined,
  behavior: 'allow' | 'deny',
): string {
  if (!reason) return "config";
  switch (reason.type) {
    case "permissionPromptTool": {
      // toolResult is typed `unknown` on PermissionDecisionReason but carries
      // the parsed Output from PermissionPromptToolResultSchema. Narrow at
      // runtime rather than widen the cross-file type.
      // Aligned with claude-code: check decisionClassification for
      // user_temporary, user_permanent, or user_reject.
      const toolResult = reason.toolResult as
        | { decisionClassification?: string }
        | undefined;
      const classified = toolResult?.decisionClassification;
      if (
        classified === "user_temporary" ||
        classified === "user_permanent" ||
        classified === "user_reject"
      ) {
        return classified;
      }
      return behavior === "allow" ? "user_temporary" : "user_reject";
    }
    case "rule":
      return ruleSourceToOTelSource(reason.rule.source, behavior);
    case "hook":
      return "hook";
    case "mode":
    case "classifier":
    case "subcommandResults":
    case "asyncAgent":
    case "sandboxOverride":
    case "workingDir":
    case "safetyCheck":
    case "other":
      return "config";
    default: {
      // Exhaustive check — if a new variant is added to the union,
      // TypeScript will flag this as an error.
      const _exhaustive: never = reason;
      return "config";
    }
  }
}

// =============================================================================
// Helper: getNextImagePasteId — aligned with claude-code
// =============================================================================

function getNextImagePasteId(messages: Message[]): number {
  let maxId = 0;
  for (const message of messages) {
    if (message.role === "user" && (message as UserMessage).imagePasteIds) {
      for (const id of (message as UserMessage).imagePasteIds!) {
        if (id > maxId) maxId = id;
      }
    }
  }
  return maxId + 1;
}

// =============================================================================
// Yield type — aligned with claude-code's MessageUpdateLazy
// =============================================================================

/**
 * Update yielded by runToolUse(). Aligned with claude-code's MessageUpdateLazy.
 * `message` is UserMessage for tool results. Hook messages (AttachmentMessage)
 * are cast to this type in the executor — consumers treat them opaquely.
 */
export type MessageUpdateLazy<M extends Message = Message> = {
  message: M;
  contextModifier?: {
    toolUseID: string;
    modifyContext: (context: ToolExecutionContext) => ToolExecutionContext;
  };
};

// =============================================================================
// MCP server types — aligned with claude-code
// =============================================================================

/**
 * MCP server transport types — aligned with claude-code.
 */
export type McpServerType = 'stdio' | 'sse' | 'http' | 'ws' | 'sdk' | 'sse-ide' | 'ws-ide' | 'claudeai-proxy' | undefined;

/**
 * Parse MCP tool name into server name and tool name components.
 * Aligned with claude-code's mcpInfoFromString + normalizeNameForMCP.
 *
 * Format: "mcp__serverName__toolName"
 * Known limitation: server names containing "__" will parse incorrectly
 * (same as claude-code).
 */
function mcpInfoFromString(toolString: string): {
  serverName: string;
  toolName: string | undefined;
} | null {
  const parts = toolString.split("__");
  const [mcpPart, serverName, ...toolNameParts] = parts;
  if (mcpPart !== "mcp" || !serverName) {
    return null;
  }
  const toolName =
    toolNameParts.length > 0 ? toolNameParts.join("__") : undefined;
  return { serverName, toolName };
}

const CLAUDEAI_SERVER_PREFIX = "claude.ai ";

/**
 * Normalize server names to be compatible with the API pattern ^[a-zA-Z0-9_-]{1,64}$
 * Aligned with claude-code's normalizeNameForMCP.
 */
function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  return normalized;
}

/**
 * Find MCP server connection by tool name.
 * Aligned with claude-code's findMcpServerConnection.
 */
function findMcpServerConnection(
  toolName: string,
  mcpClients: Array<{ name: string; [key: string]: unknown }>,
): { name: string; [key: string]: unknown } | undefined {
  if (!toolName.startsWith("mcp__")) {
    return undefined;
  }

  const mcpInfo = mcpInfoFromString(toolName);
  if (!mcpInfo) {
    return undefined;
  }

  // mcpInfo.serverName is the normalized form from the tool name.
  // client.name is the original name — normalize both for comparison.
  return mcpClients.find(
    (client) => normalizeNameForMCP(client.name) === mcpInfo.serverName,
  );
}

/**
 * Get MCP server transport type from tool name.
 * Aligned with claude-code's getMcpServerType.
 */
function getMcpServerType(
  toolName: string,
  mcpClients: Array<{ name: string; [key: string]: unknown }>,
): McpServerType {
  const connection = findMcpServerConnection(toolName, mcpClients);
  if (!connection) return undefined;
  // Only extract type for connected servers — aligned with claude-code
  if ((connection as any).type !== "connected" && (connection as any).status !== "connected") {
    return undefined;
  }
  // Handle stdio configs where type field is optional (defaults to 'stdio')
  const config = (connection as any).config;
  return (config?.type ?? "stdio") as McpServerType;
}

/**
 * Get MCP server base URL for logging.
 * Only returns URL for connected servers.
 * Aligned with claude-code's getMcpServerBaseUrlFromToolName.
 */
function getMcpServerBaseUrlFromToolName(
  toolName: string,
  mcpClients: Array<{ name: string; [key: string]: unknown }>,
): string | undefined {
  const connection = findMcpServerConnection(toolName, mcpClients);
  if (!connection) return undefined;
  // Only return URL for connected servers — aligned with claude-code
  if ((connection as any).type !== "connected" && (connection as any).status !== "connected") {
    return undefined;
  }
  // Use config for logging-safe URL extraction
  const config = (connection as any).config;
  if (!config) return undefined;
  // Return sanitized base URL (url field from config)
  const url = config.url ?? config.baseUrl;
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Get MCP server scope from tool name for OTel events.
 * Returns the normalized server name or null for non-MCP tools.
 * Aligned with claude-code's getMcpServerScopeFromToolName.
 */
function getMcpServerScopeFromToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const info = mcpInfoFromString(toolName);
  if (!info) return null;
  return info.serverName;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a child AbortController that aborts when the parent aborts.
 * Exported for use by StreamingToolExecutor.
 */
export function createChildAbortController(parent: AbortController): AbortController {
  const child = new AbortController();
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
  } else {
    const onAbort = () => {
      child.abort(parent.signal.reason);
    };
    parent.signal.addEventListener("abort", onAbort, { once: true });
    child.signal.addEventListener("abort", () => {
      parent.signal.removeEventListener("abort", onAbort);
    }, { once: true });
  }
  return child;
}

/**
 * Simple async iterable backed by a queue + done signal.
 * Used for progress event bridging in streamedCheckPermissionsAndCallTool.
 */
class SimpleStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve?: () => void;
  private _done = false;
  private _error?: unknown;

  enqueue(item: T): void {
    this.queue.push(item);
    this.resolve?.();
  }

  done(): void {
    this._done = true;
    this.resolve?.();
  }

  error(err: unknown): void {
    this._error = err;
    this.resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this._error) throw this._error;
      if (this._done) return;
      await new Promise<void>((r) => { this.resolve = r; });
    }
  }
}

/**
 * Extract MCP tool details for analytics event spreading.
 * Aligned with claude-code's mcpToolDetailsForAnalytics.
 */
function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
  analytics?: ToolExecutionContext["analytics"],
): Record<string, unknown> {
  if (!analytics?.extractMcpToolDetails) return {};
  const details = analytics.extractMcpToolDetails(toolName);
  if (!details) return {};
  return {
    mcpServerName: details.serverName,
    mcpToolName: details.mcpToolName,
  };
}

// =============================================================================
// Helper: createStopHookSummaryMessage — aligned with claude-code
// =============================================================================

/**
 * Create a system message summarizing hook execution timing.
 * Aligned with claude-code's createStopHookSummaryMessage.
 * Used when total hook duration exceeds HOOK_TIMING_DISPLAY_THRESHOLD_MS.
 */
function createStopHookSummaryMessage(
  hookCount: number,
  hookInfos: Array<{ command: string; durationMs: number }>,
  hookErrors: string[],
  preventedContinuation: boolean,
  stopReason: string | undefined,
  hasOutput: boolean,
  level: string,
  toolUseID?: string,
  hookLabel?: string,
  totalDurationMs?: number,
): any {
  return {
    type: "system",
    subtype: "stop_hook_summary",
    hookCount,
    hookInfos,
    hookErrors,
    preventedContinuation,
    stopReason,
    hasOutput,
    level,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    toolUseID,
    hookLabel,
    totalDurationMs,
  };
}

// =============================================================================
// Layer 1: runToolUse() — outer async generator
// =============================================================================
// Aligned with claude-code's runToolUse():
// - Tool lookup with alias fallback
// - Abort check (yield cancel message if already aborted)
// - Delegates to streamedCheckPermissionsAndCallTool()
// - Outer try/catch for unexpected errors

/**
 * Execute a single tool call through the full pipeline.
 * Yields MessageUpdateLazy objects (UserMessage + optional contextModifier).
 *
 * Signature aligned with claude-code:
 *   runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)
 */
export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolExecutionContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name;

  // Tool lookup with alias fallback — aligned with claude-code
  let tool = findToolByName(toolUseContext.options.tools, toolName);
  if (!tool) {
    const allBaseTools = (toolUseContext as any)._allBaseTools as readonly AgentTool[] | undefined;
    if (allBaseTools) {
      const fallback = findToolByName(allBaseTools, toolName);
      if (fallback && fallback.aliases?.includes(toolName)) {
        tool = fallback;
      }
    }
  }

  // Extract MCP metadata BEFORE tool-not-found check — aligned with claude-code
  // so the "tool not found" error event can include them.
  const messageId: string = (assistantMessage as any).messageId ?? (assistantMessage as any).id ?? "";
  const requestId = (assistantMessage as any).requestId;
  const mcpServerType = getMcpServerType(toolName, toolUseContext.options.mcpClients);
  const mcpServerBaseUrl = getMcpServerBaseUrlFromToolName(toolName, toolUseContext.options.mcpClients);

  // Tool not found — yield error and return
  if (!tool) {
    const sanitizedToolName = toolUseContext.analytics?.sanitizeToolName(toolName) ?? toolName;
    toolUseContext.logForDebugging?.(`Unknown tool ${toolName}: ${toolUse.id}`);
    toolUseContext.analytics?.logEvent("tengu_tool_use_error", {
      error: `No such tool available: ${sanitizedToolName}`,
      toolName: sanitizedToolName,
      toolUseID: toolUse.id,
      isMcp: toolName.startsWith("mcp__"),
      queryChainId: toolUseContext.queryTracking?.chainId,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && { mcpServerType }),
      ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
      ...(requestId && { requestId }),
      ...mcpToolDetailsForAnalytics(toolName, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
    });
    yield {
      message: createToolResultMessage(
        toolUse.id,
        wrapToolUseError(`Error: No such tool available: ${toolName}`),
        true,
        { sourceToolAssistantUUID: (assistantMessage as any).uuid, toolUseResult: `Error: No such tool available: ${toolName}` },
      ),
    };
    return;
  }

  try {
    // Abort check — aligned with claude-code
    if (toolUseContext.abortController.signal.aborted) {
      toolUseContext.analytics?.logEvent("tengu_tool_use_cancelled", {
        toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
        toolUseID: toolUse.id,
        isMcp: tool.isMcp ?? false,
        queryChainId: toolUseContext.queryTracking?.chainId,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && { mcpServerType }),
        ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
        ...(requestId && { requestId }),
        ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
      });
      yield {
        message: createToolResultMessage(
          toolUse.id,
          withMemoryCorrectionHint(CANCEL_MESSAGE),
          true,
          { sourceToolAssistantUUID: (assistantMessage as any).uuid, toolUseResult: CANCEL_MESSAGE },
        ),
      };
      return;
    }

    // Delegate to layer 2 — aligned with claude-code's streamedCheckPermissionsAndCallTool
    for await (const update of streamedCheckPermissionsAndCallTool(
      tool,
      toolUse.id,
      toolUse.input as Record<string, unknown>,
      toolUseContext,
      canUseTool,
      assistantMessage,
      messageId,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      yield update;
    }
  } catch (error) {
    // Outer error boundary — aligned with claude-code
    toolUseContext.logForDebugging?.(`Outer catch in runToolUse for ${tool?.name}: ${error instanceof Error ? error.message : String(error)}`, { level: "error" });
    const errorContent = formatError(error);
    const toolInfo = tool ? ` (${tool.name})` : "";
    const detailedError = `Error calling tool${toolInfo}: ${errorContent}`;

    yield {
      message: createToolResultMessage(
        toolUse.id,
        wrapToolUseError(detailedError),
        true,
        { sourceToolAssistantUUID: (assistantMessage as any).uuid, toolUseResult: detailedError },
      ),
    };
  }
}

// =============================================================================
// Layer 2: streamedCheckPermissionsAndCallTool() — Stream wrapper
// =============================================================================
// Aligned with claude-code: bridges progress events into the async iterable
// via a SimpleStream. checkPermissionsAndCallTool() pushes results into the
// stream; progress callbacks enqueue progress messages immediately.

function streamedCheckPermissionsAndCallTool(
  tool: AgentTool,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolExecutionContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): AsyncIterable<MessageUpdateLazy> {
  const stream = new SimpleStream<MessageUpdateLazy>();

  checkPermissionsAndCallTool(
    tool,
    toolUseID,
    input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
    (progress) => {
      // Progress events enqueued immediately into the stream
      // Aligned with claude-code's onToolProgress → stream.enqueue + analytics pattern
      toolUseContext.analytics?.logEvent("tengu_tool_use_progress", {
        messageID: messageId,
        toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
        isMcp: tool.isMcp ?? false,
        queryChainId: toolUseContext.queryTracking?.chainId,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && { mcpServerType }),
        ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
        ...(requestId && { requestId }),
        ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
      });

      // Create a proper progress message with parentToolUseID — aligned with
      // claude-code's createProgressMessage({toolUseID, parentToolUseID, data})
      const progressData = typeof progress === "object" ? progress as Record<string, unknown> : {};
      const progressToolUseID = (progressData as any).toolUseID ?? toolUseID;
      stream.enqueue({
        message: {
          type: "progress",
          toolUseID: progressToolUseID,
          parentToolUseID: toolUseID,
          data: (progressData as any).data ?? progress,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        } as any,
      });
    },
  )
    .then((results) => {
      for (const result of results) {
        stream.enqueue(result);
      }
    })
    .catch((error) => {
      stream.error(error);
    })
    .finally(() => {
      stream.done();
    });

  return stream;
}

// =============================================================================
// buildSchemaNotSentHint — aligned with claude-code (re-exported from executor)
// =============================================================================
// The actual implementation lives in deferred-tools.ts. This re-export keeps
// the import path consistent for consumers that previously imported from executor.

export { buildSchemaNotSentHint } from "./deferred-tools.js";

// =============================================================================
// Layer 3: checkPermissionsAndCallTool() — inner async function
// =============================================================================
// Aligned with claude-code's checkPermissionsAndCallTool():
// 1. Zod schema validation
// 2. Tool-specific validateInput()
// 3. _simulatedSedEdit stripping
// 4. backfillObservableInput
// 5. Pre-tool hooks (via hookRunner)
// 6. Permission resolution (via hookRunner or direct)
// 7. Permission denied → yield error
// 8. file_path convergence for VCR hash stability
// 9. tool.call()
// 10. Result mapping via mapToolResultToToolResultBlockParam
// 11. acceptFeedback + contentBlocks assembly
// 12. Post-tool hooks
// 13. newMessages
// 14. shouldPreventContinuation
// Error path: PostToolUseFailure hooks, MCP auth error handling

async function checkPermissionsAndCallTool(
  tool: AgentTool,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolExecutionContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
  onToolProgress: (progress: unknown) => void,
): Promise<MessageUpdateLazy[]> {
  // --- Step 1: Zod schema validation ---
  const parsedInput = tool.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    let errorContent = formatZodValidationError(tool.name, parsedInput.error);

    // Pass actual messages (not empty Set) so extractDiscoveredToolNames can check
    // if the tool was already discovered via ToolSearch — aligned with claude-code
    const schemaHint = buildSchemaNotSentHint(
      tool,
      toolUseContext.messages,
      toolUseContext.options.tools,
    );
    if (schemaHint) {
      toolUseContext.analytics?.logEvent("tengu_deferred_tool_schema_not_sent", {
        toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
        isMcp: tool.isMcp ?? false,
      });
      errorContent += schemaHint;
    }

    toolUseContext.logForDebugging?.(`${tool.name} tool input error: ${errorContent.slice(0, 200)}`);
    toolUseContext.analytics?.logEvent("tengu_tool_use_error", {
      error: "InputValidationError",
      errorDetails: errorContent.slice(0, 2000),
      messageID: messageId,
      toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
      isMcp: tool.isMcp ?? false,
      queryChainId: toolUseContext.queryTracking?.chainId,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && { mcpServerType }),
      ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
      ...(requestId && { requestId }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
    });

    return [{
      message: createToolResultMessage(
        toolUseID,
        wrapToolUseError(`InputValidationError: ${errorContent}`),
        true,
        {
          sourceToolAssistantUUID: (assistantMessage as any).uuid,
          toolUseResult: `InputValidationError: ${parsedInput.error.message}`,
        },
      ),
    }];
  }

  // --- Step 2: Tool-specific validateInput ---
  const isValidCall = await tool.validateInput?.(parsedInput.data, toolUseContext);
  if (isValidCall?.result === false) {
    toolUseContext.logForDebugging?.(`${tool.name} tool validation error: ${isValidCall.message?.slice(0, 200)}`);
    toolUseContext.analytics?.logEvent("tengu_tool_use_error", {
      messageID: messageId,
      toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
      error: isValidCall.message,
      errorCode: isValidCall.errorCode,
      isMcp: tool.isMcp ?? false,
      queryChainId: toolUseContext.queryTracking?.chainId,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && { mcpServerType }),
      ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
      ...(requestId && { requestId }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
    });
    return [{
      message: createToolResultMessage(
        toolUseID,
        wrapToolUseError(isValidCall.message ?? "Validation failed"),
        true,
        {
          sourceToolAssistantUUID: (assistantMessage as any).uuid,
          toolUseResult: `Error: ${isValidCall.message}`,
        },
      ),
    }];
  }

  // --- Step 2.5: Speculative classifier check — aligned with claude-code ---
  // Start the bash allow classifier check early so it runs in parallel with
  // pre-tool hooks, deny/ask classifiers, and permission dialog setup.
  if (
    (tool.name === "Bash" || tool.name === "bash") &&
    parsedInput.data &&
    typeof parsedInput.data === "object" &&
    "command" in parsedInput.data
  ) {
    // Aligned with claude-code: 4 args (command, toolPermissionContext, signal, isNonInteractiveSession)
    toolUseContext.startSpeculativeClassifierCheck?.(
      (parsedInput.data as { command: string }).command,
      (toolUseContext.getAppState() as any)?.toolPermissionContext,
      toolUseContext.abortController.signal,
      toolUseContext.options.isNonInteractiveSession,
    );
  }

  // --- Step 3: Strip _simulatedSedEdit from Bash input ---
  let processedInput = parsedInput.data;
  if (
    (tool.name === "Bash" || tool.name === "bash") &&
    processedInput &&
    typeof processedInput === "object" &&
    "_simulatedSedEdit" in processedInput
  ) {
    const { _simulatedSedEdit: _, ...rest } = processedInput as typeof processedInput & { _simulatedSedEdit: unknown };
    processedInput = rest as typeof processedInput;
  }

  // --- Step 4: backfillObservableInput ---
  let callInput = processedInput;
  const backfilledClone =
    tool.backfillObservableInput &&
    typeof processedInput === "object" &&
    processedInput !== null
      ? ({ ...processedInput } as typeof processedInput)
      : null;
  if (backfilledClone) {
    tool.backfillObservableInput!(backfilledClone as Record<string, unknown>);
    processedInput = backfilledClone;
  }

  const resultingMessages: MessageUpdateLazy[] = [];
  let shouldPreventContinuation = false;
  let stopReason: string | undefined;
  let hookPermissionResult: PermissionResult | undefined;
  const preToolHookInfos: Array<{ command: string; durationMs: number }> = [];

  // --- Step 5: Pre-tool hooks (direct call, aligned with claude-code) ---
  const preToolHookStart = Date.now();
  for await (const result of runPreToolUseHooks(
    toolUseContext,
    tool,
    processedInput as Record<string, unknown>,
    toolUseID,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
  )) {
    switch (result.type) {
      case "message": {
        const hookMsg = result.message as unknown as MessageUpdateLazy;
        // Forward progress messages through the progress callback —
        // aligned with claude-code's hook progress path
        const innerMsg = hookMsg.message as any;
        if (innerMsg?.type === "progress") {
          onToolProgress(innerMsg);
        } else {
          resultingMessages.push(hookMsg);
          // Track hook timing info for summary — aligned with claude-code's preToolHookInfos
          const att = innerMsg?.attachment;
          if (
            att &&
            "command" in att &&
            att.command !== undefined &&
            "durationMs" in att &&
            att.durationMs !== undefined
          ) {
            preToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            });
          }
        }
        break;
      }
      case "hookPermissionResult":
        hookPermissionResult = result.hookPermissionResult;
        break;
      case "hookUpdatedInput":
        processedInput = result.updatedInput as typeof processedInput;
        break;
      case "preventContinuation":
        shouldPreventContinuation = result.shouldPreventContinuation;
        break;
      case "stopReason":
        stopReason = result.stopReason;
        break;
      case "additionalContext":
        resultingMessages.push(result.message as unknown as MessageUpdateLazy);
        break;
      case "stop":
        toolUseContext.statsStore?.observe("pre_tool_hook_duration_ms", Date.now() - preToolHookStart);
        resultingMessages.push({
          message: createToolResultMessage(
            toolUseID,
            CANCEL_MESSAGE,
            true,
            { sourceToolAssistantUUID: (assistantMessage as any).uuid, toolUseResult: `Error: ${stopReason}` },
          ),
        });
        return resultingMessages;
    }
  }
  const preToolHookDurationMs = Date.now() - preToolHookStart;
  toolUseContext.statsStore?.observe("pre_tool_hook_duration_ms", preToolHookDurationMs);
  if (preToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
    toolUseContext.logForDebugging?.(
      `Slow PreToolUse hooks: ${preToolHookDurationMs}ms for ${tool.name} (${preToolHookInfos.length} hooks)`,
      { level: "info" },
    );
  }

  // Emit PreToolUse summary immediately so it's visible while the tool executes.
  // Use wall-clock time (not sum of individual durations) since hooks run in parallel.
  // Aligned with claude-code: gated on USER_TYPE === 'ant'.
  if (process.env.USER_TYPE === "ant" && preToolHookInfos.length > 0) {
    if (preToolHookDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
      resultingMessages.push({
        message: createStopHookSummaryMessage(
          preToolHookInfos.length,
          preToolHookInfos,
          [],
          false,
          undefined,
          false,
          "suggestion",
          undefined,
          "PreToolUse",
          preToolHookDurationMs,
        ),
      });
    }
  }

  // --- Step 5.5: Tool span tracing — start span before permission ---
  // Check specific tool names for attributes — aligned with claude-code
  const toolAttributes: Record<string, unknown> = {};
  if (processedInput && typeof processedInput === "object") {
    if (tool.name === "Read" && "file_path" in processedInput) {
      toolAttributes.file_path = String((processedInput as any).file_path);
    } else if ((tool.name === "Edit" || tool.name === "Write") && "file_path" in processedInput) {
      toolAttributes.file_path = String((processedInput as any).file_path);
    } else if ((tool.name === "Bash" || tool.name === "bash") && "command" in processedInput) {
      toolAttributes.full_command = String((processedInput as any).command);
    }
  }
  toolUseContext.tracing?.startToolSpan(
    tool.name,
    toolAttributes,
    toolUseContext.tracing.isBetaTracingEnabled() ? jsonStringify(processedInput) : undefined,
  );
  toolUseContext.tracing?.startToolBlockedOnUserSpan();

  // --- Step 6: Permission resolution (direct call, aligned with claude-code) ---
  const permissionMode = (toolUseContext.getAppState() as any)?.toolPermissionContext?.mode;
  const permissionStart = Date.now();
  let permissionDecision: PermissionResult;

  // Always use resolveHookPermissionDecision — aligned with claude-code (no conditional on hookExecutor)
  {
    const resolved = await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      processedInput as Record<string, unknown>,
      toolUseContext,
      canUseTool,
      assistantMessage,
      toolUseID,
    );
    permissionDecision = resolved.decision;
    processedInput = resolved.input as typeof processedInput;
  }
  const permissionDurationMs = Date.now() - permissionStart;
  // Slow permission logging — auto mode only (in default mode this includes user think time)
  if (permissionDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS && permissionMode === "auto") {
    toolUseContext.logForDebugging?.(
      `Slow permission decision: ${permissionDurationMs}ms for ${tool.name} (mode=${permissionMode}, behavior=${permissionDecision.behavior})`,
      { level: "info" },
    );
  }

  // OTel tool_decision event — aligned with claude-code
  if (
    permissionDecision.behavior !== "ask" &&
    !toolUseContext.toolDecisions?.has(toolUseID)
  ) {
    const decision = permissionDecision.behavior === "allow" ? "accept" : "reject";
    // Map decisionReason to OTel source — aligned with claude-code's decisionReasonToOTelSource
    const otelSource = decisionReasonToOTelSource(
      (permissionDecision as any).decisionReason,
      permissionDecision.behavior as 'allow' | 'deny',
    );
    toolUseContext.analytics?.logOTelEvent("tool_decision", {
      decision,
      source: otelSource,
      tool_name: toolUseContext.analytics.sanitizeToolName(tool.name),
    });

    // Increment code-edit tool decision counter for headless mode —
    // aligned with claude-code's buildCodeEditToolAttributes + getCodeEditToolDecisionCounter.
    // Uses the callback pattern: toolUseContext exposes isCodeEditingTool/buildCodeEditToolAttributes
    // so the host app can wire in OTel counters without direct dependencies.
    if (toolUseContext.codeEditMetrics?.isCodeEditingTool(tool.name)) {
      void toolUseContext.codeEditMetrics
        .buildCodeEditToolAttributes(tool, processedInput, decision, otelSource)
        .then((attributes) =>
          toolUseContext.codeEditMetrics?.getCodeEditToolDecisionCounter()?.add(1, attributes),
        );
    }
  }

  // Add message if permission was granted/denied by PermissionRequest hook — aligned with claude-code
  if (
    (permissionDecision as any).decisionReason?.type === "hook" &&
    (permissionDecision as any).decisionReason.hookName === "PermissionRequest" &&
    permissionDecision.behavior !== "ask"
  ) {
    resultingMessages.push({
      message: {
        type: "attachment",
        attachment: {
          type: "hook_permission_decision",
          decision: permissionDecision.behavior,
          toolUseID,
          hookEvent: "PermissionRequest",
        },
      } as any,
    });
  }

  // --- Step 7: Permission denied → yield error ---
  if (permissionDecision.behavior !== "allow") {
    toolUseContext.logForDebugging?.(`${tool.name} tool permission denied`);
    const decisionInfoReject = toolUseContext.toolDecisions?.get(toolUseID);
    toolUseContext.tracing?.endToolBlockedOnUserSpan("reject", decisionInfoReject?.source || "unknown");
    toolUseContext.tracing?.endToolSpan();

    toolUseContext.analytics?.logEvent("tengu_tool_use_can_use_tool_rejected", {
      messageID: messageId,
      toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
      queryChainId: toolUseContext.queryTracking?.chainId,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && { mcpServerType }),
      ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
      ...(requestId && { requestId }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
    });
    let errorMessage = (permissionDecision as any).message;
    // Only use generic "Execution stopped" message if we don't have a detailed hook message
    if (shouldPreventContinuation && !errorMessage) {
      errorMessage = `Execution stopped by PreToolUse hook${stopReason ? `: ${stopReason}` : ""}`;
    }

    const messageContent: Array<{ type: string; [key: string]: unknown }> = [
      {
        type: "tool_result",
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ];

    // Add content blocks (e.g., images) from the permission decision
    const rejectContentBlocks =
      permissionDecision.behavior === "ask"
        ? (permissionDecision as any).contentBlocks
        : undefined;
    if (rejectContentBlocks?.length) {
      messageContent.push(...rejectContentBlocks);
    }

    // Generate sequential imagePasteIds so each image renders with a distinct label
    let rejectImageIds: number[] | undefined;
    if (rejectContentBlocks?.length) {
      const imageCount = rejectContentBlocks.filter((b: any) => b.type === "image").length;
      if (imageCount > 0) {
        const startId = getNextImagePasteId(toolUseContext.messages);
        rejectImageIds = Array.from({ length: imageCount }, (_, i) => startId + i);
      }
    }

    resultingMessages.push({
      message: {
        role: "user",
        content: messageContent as any,
        imagePasteIds: rejectImageIds,
        sourceToolAssistantUUID: (assistantMessage as any).uuid,
        toolUseResult: `Error: ${errorMessage}`,
      },
    });

    // --- PermissionDenied hooks — aligned with claude-code ---
    // Run executePermissionDeniedHooks for auto-mode classifier denials.
    // If a hook returns {retry: true}, tell the model it may retry.
    const decisionReason = (permissionDecision as any).decisionReason;
    if (
      decisionReason?.type === "classifier" &&
      decisionReason.classifier === "auto-mode" &&
      toolUseContext.hookExecutor?.executePermissionDeniedHooks
    ) {
      let hookSaysRetry = false;
      for await (const result of toolUseContext.hookExecutor.executePermissionDeniedHooks(
        tool.name,
        toolUseID,
        processedInput as Record<string, unknown>,
        decisionReason.reason ?? "Permission denied",
        toolUseContext,
        permissionMode,
        toolUseContext.abortController.signal,
      )) {
        if (result.retry) hookSaysRetry = true;
      }
      if (hookSaysRetry) {
        resultingMessages.push({
          message: {
            role: "user",
            content: "The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.",
            isMeta: true,
          } as any,
        });
      }
    }

    return resultingMessages;
  }

  // Permission allowed — log and start execution span
  toolUseContext.analytics?.logEvent("tengu_tool_use_can_use_tool_allowed", {
    messageID: messageId,
    toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
    queryChainId: toolUseContext.queryTracking?.chainId,
    queryDepth: toolUseContext.queryTracking?.depth,
    ...(mcpServerType && { mcpServerType }),
    ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
    ...(requestId && { requestId }),
    ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
  });

  // --- Apply updatedInput from permission decision ---
  if (permissionDecision.updatedInput !== undefined) {
    processedInput = permissionDecision.updatedInput;
  }

  // --- Prepare tool parameters for OTel logging ---
  const telemetryToolInput = toolUseContext.analytics?.extractToolInputForTelemetry(processedInput);
  let toolParameters: Record<string, unknown> = {};
  if (toolUseContext.analytics?.isToolDetailsLoggingEnabled()) {
    if ((tool.name === "Bash" || tool.name === "bash") && typeof processedInput === "object" && processedInput !== null && "command" in processedInput) {
      const pi = processedInput as Record<string, unknown>;
      const command = String(pi.command);
      const commandParts = command.trim().split(/\s+/);
      toolParameters = {
        bash_command: commandParts[0] || "",
        full_command: command,
        // Aligned with claude-code: include timeout, description, dangerouslyDisableSandbox
        ...(pi.timeout !== undefined && { timeout: pi.timeout }),
        ...(pi.description !== undefined && { description: pi.description }),
        ...("dangerouslyDisableSandbox" in pi && { dangerouslyDisableSandbox: pi.dangerouslyDisableSandbox }),
      };
    }
    const mcpDetails = toolUseContext.analytics.extractMcpToolDetails?.(tool.name);
    if (mcpDetails) {
      toolParameters.mcp_server_name = mcpDetails.serverName;
      toolParameters.mcp_tool_name = mcpDetails.mcpToolName;
    }
    const skillName = toolUseContext.analytics.extractSkillName?.(tool.name, processedInput);
    if (skillName) {
      toolParameters.skill_name = skillName;
    }
  }

  const decisionInfo = toolUseContext.toolDecisions?.get(toolUseID);
  toolUseContext.tracing?.endToolBlockedOnUserSpan(
    decisionInfo?.decision || "unknown",
    decisionInfo?.source || "unknown",
  );
  toolUseContext.tracing?.startToolExecutionSpan();

  // --- Step 8: file_path convergence for VCR hash stability ---
  if (
    backfilledClone &&
    processedInput !== callInput &&
    typeof processedInput === "object" &&
    processedInput !== null &&
    "file_path" in processedInput &&
    "file_path" in (callInput as Record<string, unknown>) &&
    (processedInput as Record<string, unknown>).file_path ===
      (backfilledClone as Record<string, unknown>).file_path
  ) {
    callInput = {
      ...processedInput,
      file_path: (callInput as Record<string, unknown>).file_path,
    } as typeof processedInput;
  } else if (processedInput !== backfilledClone) {
    callInput = processedInput;
  }

  // --- Step 9: tool.call() ---
  const startTime = Date.now();

  toolUseContext.sessionActivity?.start("tool_exec");

  try {
    const result = await tool.call(
      callInput as any,
      {
        ...toolUseContext,
        toolUseId: toolUseID,
        userModified: permissionDecision.userModified ?? false,
      },
      canUseTool,
      assistantMessage,
      // Progress callback (5th arg) — aligned with claude-code
      (progress: unknown) => {
        const progressData = progress && typeof progress === "object" ? progress as Record<string, unknown> : {};
        onToolProgress({
          toolUseID: (progressData as any).toolUseID ?? toolUseID,
          data: (progressData as any).data ?? progress,
        });
      },
    );

    const durationMs = Date.now() - startTime;
    // Accumulate tool duration — aligned with claude-code's addToToolDuration
    toolUseContext.analytics?.addToToolDuration?.(durationMs);

    // --- Tool content events — aligned with claude-code's addToolContentEvent ---
    // Only log content for specific tool names (file read, edit, write, bash).
    if (result.data && typeof result.data === "object") {
      const contentAttributes: Record<string, string | number | boolean> = {};
      const pi = processedInput as Record<string, unknown>;
      const rd = result.data as Record<string, unknown>;

      // Read tool: capture file_path and content
      if (tool.name === "Read" && "content" in rd) {
        if ("file_path" in pi) {
          contentAttributes.file_path = String(pi.file_path);
        }
        contentAttributes.content = String(rd.content);
      }

      // Edit/Write tools: capture file_path and diff/content
      if ((tool.name === "Edit" || tool.name === "Write") && "file_path" in pi) {
        contentAttributes.file_path = String(pi.file_path);
        if (tool.name === "Edit" && "diff" in rd) {
          contentAttributes.diff = String(rd.diff);
        }
        if (tool.name === "Write" && "content" in pi) {
          contentAttributes.content = String(pi.content);
        }
      }

      // Bash tool: capture command and output
      if ((tool.name === "Bash" || tool.name === "bash") && "command" in pi) {
        contentAttributes.bash_command = String(pi.command);
        if ("output" in rd) {
          contentAttributes.output = String(rd.output);
        }
      }

      if (Object.keys(contentAttributes).length > 0) {
        toolUseContext.tracing?.addToolContentEvent("tool.output", contentAttributes);
      }
    }

    // --- Structured output — aligned with claude-code ---
    if (typeof result === "object" && "structured_output" in result) {
      resultingMessages.push({
        message: { type: "attachment", attachment: { type: "structured_output", data: (result as any).structured_output } } as any,
      });
    }

    toolUseContext.tracing?.endToolExecutionSpan({ success: true });
    const toolResultStr = result.data && typeof result.data === "object"
      ? jsonStringify(result.data)
      : String(result.data ?? "");
    toolUseContext.tracing?.endToolSpan(toolResultStr);

    // --- Step 10: Map tool result to API format ---
    const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    );
    const mappedContent = mappedToolResultBlock.content;
    const toolResultSizeBytes = !mappedContent
      ? 0
      : typeof mappedContent === "string"
        ? mappedContent.length
        : jsonStringify(mappedContent).length;

    // --- File extension analytics — aligned with claude-code ---
    // Check specific tool names rather than generic input key presence.
    let fileExtension: string | undefined;
    if (processedInput && typeof processedInput === "object") {
      const pi = processedInput as Record<string, unknown>;
      if (
        (tool.name === "Read" || tool.name === "Edit" || tool.name === "Write") &&
        "file_path" in pi && typeof pi.file_path === "string"
      ) {
        fileExtension = toolUseContext.analytics?.getFileExtensionForAnalytics?.(pi.file_path);
      } else if (
        tool.name === "NotebookEdit" &&
        "notebook_path" in pi && typeof pi.notebook_path === "string"
      ) {
        fileExtension = toolUseContext.analytics?.getFileExtensionForAnalytics?.(pi.notebook_path);
      } else if ((tool.name === "Bash" || tool.name === "bash") && "command" in pi && typeof pi.command === "string") {
        const simulatedSedFilePath = (input as Record<string, unknown>)?._simulatedSedEdit as { filePath?: string } | undefined;
        fileExtension = toolUseContext.analytics?.getFileExtensionsFromBashCommand?.(
          pi.command as string,
          simulatedSedFilePath?.filePath,
        );
      }
    }

    // --- Git commit ID extraction — aligned with claude-code ---
    if (
      toolUseContext.analytics?.isToolDetailsLoggingEnabled() &&
      (tool.name === "Bash" || tool.name === "bash" || tool.name === "PowerShell") &&
      typeof processedInput === "object" && processedInput !== null &&
      "command" in processedInput &&
      typeof (processedInput as any).command === "string" &&
      (processedInput as any).command.match(/\bgit\s+commit\b/) &&
      result.data &&
      typeof result.data === "object" &&
      "stdout" in (result.data as Record<string, unknown>)
    ) {
      const gitCommitId = parseGitCommitId(String((result.data as any).stdout));
      if (gitCommitId) {
        toolParameters.git_commit_id = gitCommitId;
      }
    }

    // --- Analytics: tool success — aligned with claude-code ---
    toolUseContext.analytics?.logEvent("tengu_tool_use_success", {
      messageID: messageId,
      toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
      isMcp: tool.isMcp ?? false,
      durationMs,
      preToolHookDurationMs,
      toolResultSizeBytes,
      ...(fileExtension !== undefined && { fileExtension }),
      queryChainId: toolUseContext.queryTracking?.chainId,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && { mcpServerType }),
      ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
      ...(requestId && { requestId }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
    });

    // --- OTel tool_result event (success) — aligned with claude-code ---
    const mcpServerScope = isMcpTool(tool)
      ? getMcpServerScopeFromToolName(tool.name)
      : null;
    toolUseContext.analytics?.logOTelEvent("tool_result", {
      tool_name: toolUseContext.analytics.sanitizeToolName(tool.name),
      success: "true",
      duration_ms: String(durationMs),
      ...(Object.keys(toolParameters).length > 0 && {
        tool_parameters: jsonStringify(toolParameters),
      }),
      ...(telemetryToolInput && { tool_input: telemetryToolInput }),
      tool_result_size_bytes: String(toolResultSizeBytes),
      ...(decisionInfo && {
        decision_source: decisionInfo.source,
        decision_type: decisionInfo.decision,
      }),
      ...(mcpServerScope && { mcp_server_scope: mcpServerScope }),
    });

    // Run PostToolUse hooks
    let toolOutput = result.data;
    const hookResults: MessageUpdateLazy[] = [];
    const toolContextModifier = result.contextModifier;
    const mcpMeta = result.mcpMeta;

    // --- Step 11: addToolResult helper — aligned with claude-code ---
    // Uses processPreMappedToolResultBlock for non-MCP tools (optimization:
    // skips re-mapping), processToolResultBlock for MCP tools (must re-map
    // since hooks may have modified the output).
    const addToolResult = async (
      toolUseResult: any,
      preMappedBlock?: typeof mappedToolResultBlock,
    ) => {
      const toolResultBlock = preMappedBlock
        ? await processPreMappedToolResultBlock(
            preMappedBlock,
            tool.name,
            tool.maxResultSizeChars,
          )
        : await processToolResultBlock(tool, toolUseResult, toolUseID);

      // Build content blocks — tool result first, then optional feedback
      const contentBlocks: ContentBlockParam[] = [
        toolResultBlock as ContentBlockParam,
      ];

      // acceptFeedback — aligned with claude-code
      if ("acceptFeedback" in permissionDecision && permissionDecision.acceptFeedback) {
        contentBlocks.push({ type: "text", text: permissionDecision.acceptFeedback });
      }

      // contentBlocks from permission decision (e.g., pasted images)
      const allowContentBlocks =
        "contentBlocks" in permissionDecision
          ? permissionDecision.contentBlocks
          : undefined;
      if (allowContentBlocks?.length) {
        contentBlocks.push(...allowContentBlocks);
      }

      // Generate imagePasteIds — aligned with claude-code
      let imagePasteIds: number[] | undefined;
      if (allowContentBlocks?.length) {
        const imageCount = allowContentBlocks.filter((b: ContentBlockParam) => b.type === "image").length;
        if (imageCount > 0) {
          const startId = getNextImagePasteId(toolUseContext.messages);
          imagePasteIds = Array.from({ length: imageCount }, (_, i) => startId + i);
        }
      }

      resultingMessages.push({
        message: {
          role: "user",
          content: contentBlocks as any,
          imagePasteIds,
          toolUseResult: toolUseContext.agentId && !toolUseContext.preserveToolUseResults
            ? undefined
            : toolUseResult,
          mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
          sourceToolAssistantUUID: (assistantMessage as any).uuid,
        },
        contextModifier: toolContextModifier
          ? { toolUseID, modifyContext: toolContextModifier }
          : undefined,
      });
    };

    // Non-MCP tools: add result immediately with pre-mapped block (optimization)
    if (!isMcpTool(tool)) {
      await addToolResult(toolOutput, mappedToolResultBlock);
    }

    // --- Step 12: Post-tool hooks (direct call, aligned with claude-code) ---
    const postToolHookInfos: Array<{ command: string; durationMs: number }> = [];
    const postToolHookStart = Date.now();
    for await (const hookResult of runPostToolUseHooks(
      toolUseContext,
      tool,
      toolUseID,
      messageId,
      processedInput,
      toolOutput,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      if ("updatedMCPToolOutput" in hookResult) {
        if (isMcpTool(tool)) {
          toolOutput = hookResult.updatedMCPToolOutput;
        }
      } else if (isMcpTool(tool)) {
        // For MCP tools, defer hook result messages until after addToolResult
        hookResults.push(hookResult as unknown as MessageUpdateLazy);
        if ((hookResult as any).message.type === "attachment") {
          const att = (hookResult as any).message.attachment;
          if (
            "command" in att &&
            att.command !== undefined &&
            "durationMs" in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({ command: att.command, durationMs: att.durationMs });
          }
        }
      } else {
        resultingMessages.push(hookResult as unknown as MessageUpdateLazy);
        if ((hookResult as any).message.type === "attachment") {
          const att = (hookResult as any).message.attachment;
          if (
            "command" in att &&
            att.command !== undefined &&
            "durationMs" in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({ command: att.command, durationMs: att.durationMs });
          }
        }
      }
    }
    const postToolHookDurationMs = Date.now() - postToolHookStart;
    if (postToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
      toolUseContext.logForDebugging?.(
        `Slow PostToolUse hooks: ${postToolHookDurationMs}ms for ${tool.name} (${postToolHookInfos.length} hooks)`,
        { level: "info" },
      );
    }

    // MCP tools: add result after post-hooks (hooks may modify output) — no pre-mapped block
    if (isMcpTool(tool)) {
      await addToolResult(toolOutput);
    }

    // Show PostToolUse hook timing inline below tool result when > 500ms.
    // Use wall-clock time (not sum of individual durations) since hooks run in parallel.
    // Aligned with claude-code: gated on USER_TYPE === 'ant'.
    if (process.env.USER_TYPE === "ant" && postToolHookInfos.length > 0) {
      if (postToolHookDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
        resultingMessages.push({
          message: createStopHookSummaryMessage(
            postToolHookInfos.length,
            postToolHookInfos,
            [],
            false,
            undefined,
            false,
            "suggestion",
            undefined,
            "PostToolUse",
            postToolHookDurationMs,
          ),
        });
      }
    }

    // --- Step 13: newMessages from tool result ---
    if (result.newMessages && result.newMessages.length > 0) {
      for (const msg of result.newMessages) {
        resultingMessages.push({ message: msg as UserMessage });
      }
    }

    // --- Step 14: shouldPreventContinuation — aligned with claude-code ---
    // Use createAttachmentMessage with typed hook_stopped_continuation
    if (shouldPreventContinuation) {
      resultingMessages.push({
        message: {
          type: "attachment",
          attachment: {
            type: "hook_stopped_continuation",
            message: stopReason || "Execution stopped by hook",
            hookName: `PreToolUse:${tool.name}`,
            toolUseID,
            hookEvent: "PreToolUse",
          },
        } as any,
      });
    }

    // Yield remaining hook results for MCP tools after other messages — aligned with claude-code
    for (const hookResult of hookResults) {
      resultingMessages.push(hookResult);
    }

    return resultingMessages;
  } catch (error) {
    // --- Error path ---
    const errorDurationMs = Date.now() - startTime;
    // Accumulate tool duration even on error — aligned with claude-code
    toolUseContext.analytics?.addToToolDuration?.(errorDurationMs);
    const isInterrupt = error instanceof Error && error.name === "AbortError";
    const errorMsg = error instanceof Error ? error.message : String(error);

    toolUseContext.tracing?.endToolExecutionSpan({ success: false, error: errorMsg });
    toolUseContext.tracing?.endToolSpan();

    // MCP auth error handling — aligned with claude-code
    if (error instanceof Error && error.name === "McpAuthError" && "serverName" in error) {
      const serverName = (error as any).serverName as string;
      toolUseContext.setAppState((prevState: Record<string, unknown>) => {
        const mcp = prevState.mcp as { clients: Array<{ name: string; type: string; config?: unknown }> } | undefined;
        if (!mcp) return prevState;
        const idx = mcp.clients.findIndex((c) => c.name === serverName);
        if (idx === -1) return prevState;
        const existing = mcp.clients[idx];
        if (!existing || existing.type !== "connected") return prevState;
        const updatedClients = [...mcp.clients];
        updatedClients[idx] = { name: serverName, type: "needs-auth" as const, config: (existing as any).config };
        return { ...prevState, mcp: { ...mcp, clients: updatedClients } };
      });
    }

    // Analytics: tool error — aligned with claude-code
    if (!isInterrupt) {
      toolUseContext.logForDebugging?.(
        `${tool.name} tool error (${errorDurationMs}ms): ${errorMsg.slice(0, 200)}`,
      );
      // logError for non-ShellError, non-AbortError — aligned with claude-code
      if (!(error instanceof Error && error.name === "ShellError")) {
        toolUseContext.logError?.(error);
      }
      toolUseContext.analytics?.logEvent("tengu_tool_use_error", {
        messageID: messageId,
        toolName: toolUseContext.analytics.sanitizeToolName(tool.name),
        error: classifyToolError(error),
        isMcp: tool.isMcp ?? false,
        queryChainId: toolUseContext.queryTracking?.chainId,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && { mcpServerType }),
        ...(mcpServerBaseUrl && { mcpServerBaseUrl }),
        ...(requestId && { requestId }),
        ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl, toolUseContext.analytics),
      });
      // OTel tool_result event (error) — aligned with claude-code
      const mcpServerScope = isMcpTool(tool)
        ? getMcpServerScopeFromToolName(tool.name)
        : null;
      toolUseContext.analytics?.logOTelEvent("tool_result", {
        tool_name: toolUseContext.analytics.sanitizeToolName(tool.name),
        use_id: toolUseID,
        success: "false",
        duration_ms: String(errorDurationMs),
        error: errorMsg,
        ...(Object.keys(toolParameters).length > 0 && {
          tool_parameters: jsonStringify(toolParameters),
        }),
        ...(telemetryToolInput && { tool_input: telemetryToolInput }),
        ...(decisionInfo && {
          decision_source: decisionInfo.source,
          decision_type: decisionInfo.decision,
        }),
        ...(mcpServerScope && { mcp_server_scope: mcpServerScope }),
      });
    }

    const content = formatError(error);

    // PostToolUseFailure hooks — aligned with claude-code (direct call)
    const hookMessages: MessageUpdateLazy[] = [];
    for await (const hookResult of runPostToolUseFailureHooks(
      toolUseContext,
      tool,
      toolUseID,
      messageId,
      processedInput,
      content,
      isInterrupt,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      hookMessages.push(hookResult as unknown as MessageUpdateLazy);
    }

    return [
      {
        message: createToolResultMessage(
          toolUseID,
          content,
          true,
          {
            sourceToolAssistantUUID: (assistantMessage as any).uuid,
            toolUseResult: `Error: ${content}`,
            mcpMeta: toolUseContext.agentId
              ? undefined
              : (error instanceof Error && "mcpMeta" in error)
                ? (error as any).mcpMeta
                : undefined,
          },
        ),
      },
      ...hookMessages,
    ];
  } finally {
    toolUseContext.sessionActivity?.stop("tool_exec");
    // Clean up decision info after logging — aligned with claude-code
    if (decisionInfo) {
      toolUseContext.toolDecisions?.delete(toolUseID);
    }
  }
}
