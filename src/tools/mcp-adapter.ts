// MCP adapter — connect to MCP servers, wrap tools as AgentTool

import type { AgentTool, AgentToolResult, ToolExecutionContext, ToolResultBlockParam } from "../tools/types.js";
import { buildTool, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../tools/types.js";
import type { TextContent, ImageContent, ContentBlock } from "../llm/types.js";
import { persistToolResult, buildLargeToolResultMessage, isPersistError } from "../tools/tool-result-storage.js";

export interface MCPServerConfig {
  name: string;
  transport: MCPTransport;
  timeout?: number;
  /** When true, skip the mcp__ prefix on tool names (SDK mode). */
  skipToolPrefix?: boolean;
}

export type MCPTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "streamable-http"; url: string; headers?: Record<string, string> }
  | { type: "websocket"; url: string; headers?: Record<string, string> };

export interface MCPServerStatus {
  name: string;
  status: "pending" | "connecting" | "connected" | "failed" | "needs_auth";
  error?: string;
  tools: AgentTool[];
}

/** MCP tool annotations (behavioral hints from tool provider). */
interface MCPToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /**
   * MCP tool metadata. Supports:
   * - `anthropic/alwaysLoad`: when true, tool is never deferred
   * - `anthropic/searchHint`: keyword phrase for ToolSearch matching
   */
  _meta?: Record<string, unknown>;
  /** MCP tool annotations (behavioral flags from tool provider). */
  annotations?: MCPToolAnnotations;
}

interface MCPToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; blob?: string; uri?: string }>;
  isError?: boolean;
  /** MCP protocol metadata */
  _meta?: Record<string, unknown>;
  /** MCP structured content */
  structuredContent?: Record<string, unknown>;
}

export class McpSessionExpiredError extends Error {
  constructor(message?: string) {
    super(message ?? "MCP session expired");
    this.name = "McpSessionExpiredError";
  }
}

export class McpAuthError extends Error {
  public readonly serverName: string;
  constructor(serverName: string, message?: string) {
    super(message ?? "MCP authentication required");
    this.name = "McpAuthError";
    this.serverName = serverName;
  }
}

export class McpToolCallError extends Error {
  public readonly mcpMeta?: { _meta?: Record<string, unknown> };
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly serverName: string,
    mcpMeta?: { _meta?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "McpToolCallError";
    this.mcpMeta = mcpMeta;
  }
}

const CLAUDEAI_SERVER_PREFIX = "claude.ai ";

/**
 * Normalize a name for use in MCP tool naming.
 * Replaces non-alphanumeric/underscore/hyphen chars with underscore.
 * Only collapses consecutive underscores and strips leading/trailing underscores
 * for claude.ai prefixed server names.
 */
function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  return normalized;
}

/**
 * Build the full MCP tool name: mcp__{normalizedServer}__{normalizedTool}
 */
function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

/**
 * Sanitize a single string by normalizing unicode and stripping invisible/problematic chars.
 */
function partiallySanitizeUnicode(prompt: string): string {
  let current = prompt;
  let previous = "";
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (current !== previous && iterations < MAX_ITERATIONS) {
    previous = current;
    current = current.normalize("NFKC");
    current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "");
    current = current
      .replace(/[\u200B-\u200F]/g, "")
      .replace(/[\u202A-\u202E]/g, "")
      .replace(/[\u2066-\u2069]/g, "")
      .replace(/[\uFEFF]/g, "")
      .replace(/[\uE000-\uF8FF]/g, "");
    iterations++;
  }

  if (iterations >= MAX_ITERATIONS) {
    throw new Error(`Unicode sanitization reached maximum iterations (${MAX_ITERATIONS}) for input: ${prompt.slice(0, 100)}`);
  }
  return current;
}

/**
 * Recursively sanitize unicode in an object.
 */
function recursivelySanitizeUnicode(value: unknown): unknown {
  if (typeof value === "string") return partiallySanitizeUnicode(value);
  if (Array.isArray(value)) return value.map(recursivelySanitizeUnicode);
  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[recursivelySanitizeUnicode(key) as string] = recursivelySanitizeUnicode(val);
    }
    return sanitized;
  }
  return value;
}

export interface MCPClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<MCPToolResult>;
  close(): Promise<void>;
}

/**
 * Check if an error represents an MCP session expiry.
 * Detects:
 * - Direct 404 + JSON-RPC -32001 from the server (StreamableHTTPError)
 * - -32000 "Connection closed" (McpError)
 */
function isSessionExpiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof McpSessionExpiredError) return true;
  const errorCode = 'code' in error ? (error as Error & { code?: number }).code : undefined;
  const isSessionExpiredCode =
    errorCode === -32001 ||
    (error.message && (error.message.includes('"code":-32001') || error.message.includes('"code": -32001')));
  const isConnectionClosed =
    errorCode === -32000 && error.message.includes("Connection closed");
  return !!(isSessionExpiredCode || isConnectionClosed);
}

/** Error code for MCP elicitation requests (-32042). */
const MCP_ELICITATION_ERROR_CODE = -32042;

/** Check if an error is an MCP elicitation request (-32042). */
function isMcpElicitationError(error: unknown): error is Error & { code: number; data?: Record<string, unknown> } {
  return (
    error instanceof Error &&
    typeof (error as any).code === "number" &&
    (error as any).code === MCP_ELICITATION_ERROR_CODE
  );
}

/** Callback for URL elicitation when MCP server returns -32042 error. */
export type MCPElicitationHandler = (
  serverName: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

/** Classify an MCP tool for UI collapse behavior. */
export type MCPToolCollapseClassifier = (
  serverName: string,
  toolName: string,
) => { isSearch: boolean; isRead: boolean; isList?: boolean } | undefined;

/** Filter function to determine if an MCP tool should be included. */
export type MCPToolFilter = (tool: AgentTool) => boolean;

/** Default IDE tool filter. */
const ALLOWED_IDE_TOOLS = ["mcp__ide__executeCode", "mcp__ide__getDiagnostics"];

export function defaultMCPToolFilter(tool: AgentTool): boolean {
  return (
    !tool.name.startsWith("mcp__ide__") || ALLOWED_IDE_TOOLS.includes(tool.name)
  );
}

const MAX_SESSION_RETRIES = 1;
const MAX_URL_ELICITATION_RETRIES = 3;
const LARGE_MCP_RESULT_CHARS = 50_000;

export interface MCPAdapterOptions {
  configs: MCPServerConfig[];
  clientFactory: (config: MCPServerConfig) => MCPClient;
  /** URL elicitation handler for MCP -32042 errors. */
  elicitationHandler?: MCPElicitationHandler;
  /** MCP tool collapse classifier for UI grouping. */
  collapseClassifier?: MCPToolCollapseClassifier;
  /** Filter to include/exclude MCP tools. Default: defaultMCPToolFilter. */
  toolFilter?: MCPToolFilter;
}

export class MCPAdapter {
  private _servers = new Map<string, MCPServerStatus>();
  private _clients = new Map<string, MCPClient>();
  private _loadingPromise: Promise<void> | null = null;
  private _elicitationHandler?: MCPElicitationHandler;
  private _collapseClassifier?: MCPToolCollapseClassifier;
  private _toolFilter: MCPToolFilter;

  constructor(
    private _configs: MCPServerConfig[],
    private _clientFactory: (config: MCPServerConfig) => MCPClient,
    options?: Partial<MCPAdapterOptions>,
  ) {
    this._elicitationHandler = options?.elicitationHandler;
    this._collapseClassifier = options?.collapseClassifier;
    this._toolFilter = options?.toolFilter ?? defaultMCPToolFilter;
    for (const config of _configs) {
      this._servers.set(config.name, {
        name: config.name,
        status: "pending",
        tools: [],
      });
    }
  }

  // Start loading all MCP servers in background
  startLoading(): void {
    if (this._loadingPromise) return;
    this._loadingPromise = this._loadAll();
  }

  // Wait for all servers to finish loading
  async waitForReady(): Promise<void> {
    if (this._loadingPromise) {
      await this._loadingPromise;
    }
  }

  // Get all tools from connected servers
  getAllTools(): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const server of this._servers.values()) {
      tools.push(...server.tools);
    }
    return tools;
  }

  // Get server statuses
  getStatuses(): MCPServerStatus[] {
    return [...this._servers.values()];
  }

  /** Get pending (still-connecting) MCP server names. */
  getPendingServerNames(): string[] {
    return [...this._servers.values()]
      .filter((s) => s.status === "pending" || s.status === "connecting")
      .map((s) => s.name);
  }

  // Disconnect all servers
  async dispose(): Promise<void> {
    for (const client of this._clients.values()) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
    this._clients.clear();
  }

  private async _loadAll(): Promise<void> {
    const promises = this._configs.map((config) => this._loadServer(config));
    await Promise.allSettled(promises);
  }

  private async _loadServer(config: MCPServerConfig): Promise<void> {
    const status = this._servers.get(config.name)!;
    status.status = "connecting";

    try {
      const client = this._clientFactory(config);
      this._clients.set(config.name, client);

      await client.connect();

      let toolDefs = await client.listTools();
      toolDefs = recursivelySanitizeUnicode(toolDefs) as MCPToolDefinition[];

      const allTools = toolDefs.map((def) =>
        this._wrapMCPTool(config.name, def, client, config.timeout, config.skipToolPrefix),
      );

      const tools = allTools.filter(this._toolFilter);

      status.status = "connected";
      status.tools = tools;
    } catch (err) {
      if (err instanceof McpAuthError) {
        status.status = "needs_auth";
      } else {
        status.status = "failed";
      }
      status.error = err instanceof Error ? err.message : String(err);
    }
  }

  private _wrapMCPTool(
    serverName: string,
    def: MCPToolDefinition,
    client: MCPClient,
    timeout?: number,
    skipToolPrefix?: boolean,
  ): AgentTool {
    const fullyQualifiedName = buildMcpToolName(serverName, def.name);
    const toolName = skipToolPrefix ? def.name : fullyQualifiedName;

    const schema = def.inputSchema ?? {};
    const alwaysLoad = def._meta?.["anthropic/alwaysLoad"] === true;

    const rawSearchHint = def._meta?.["anthropic/searchHint"];
    const searchHint =
      typeof rawSearchHint === "string"
        ? rawSearchHint.replace(/\s+/g, " ").trim() || undefined
        : undefined;

    const MAX_MCP_DESCRIPTION_LENGTH = 2048;
    const desc = def.description ?? '';
    const promptDescription =
      desc.length > MAX_MCP_DESCRIPTION_LENGTH
        ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + "… [truncated]"
        : desc;

    const annotations = def.annotations;
    const displayName = annotations?.title || def.name;
    const adapter = this;

    return buildTool({
      name: toolName,
      async description() { return promptDescription; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: content as string | ContentBlock[] };
      },
      renderToolUseMessage() { return null; },
      inputSchema: schema as any,
      inputJSONSchema: def.inputSchema as any,
      searchHint,

      isMcp: true,
      alwaysLoad,
      mcpInfo: { serverName, toolName: def.name },

      isConcurrencySafe: () => annotations?.readOnlyHint ?? false,
      isReadOnly: () => annotations?.readOnlyHint ?? false,
      isDestructive: () => annotations?.destructiveHint ?? false,
      isOpenWorld: () => annotations?.openWorldHint ?? false,

      async prompt() {
        return promptDescription;
      },

      userFacingName: () => `${serverName} - ${displayName} (MCP)`,

      isSearchOrReadCommand: adapter._collapseClassifier
        ? () => adapter._collapseClassifier!(serverName, def.name) ?? { isSearch: false, isRead: false }
        : undefined,

      toAutoClassifierInput(input: Record<string, unknown>) {
        const keys = Object.keys(input);
        return {
          tool_name: toolName,
          input: keys.length > 0
            ? keys.map(k => `${k}=${String(input[k])}`).join(' ')
            : def.name,
        };
      },

      isResultTruncated(output: unknown) {
        return typeof output === 'string' && output.includes('[truncated]');
      },

      async checkPermissions() {
        return {
          behavior: "passthrough" as const,
          message: "MCPTool requires permission.",
          suggestions: [{
            type: "addRules" as const,
            destination: "localSettings" as const,
            rules: [{ toolName: fullyQualifiedName, ruleContent: undefined }],
            behavior: "allow" as const,
          }],
        };
      },

      async call(
        params: Record<string, unknown>,
        context: ToolExecutionContext,
        _canUseTool?: unknown,
        _parentMessage?: unknown,
        onProgress?: (progress: { toolUseID: string; data: Record<string, unknown> }) => void,
      ): Promise<AgentToolResult> {
        const startTime = Date.now();
        onProgress?.({
          toolUseID: context.toolUseId ?? "",
          data: { type: "mcp_progress", status: "started", serverName, toolName: def.name },
        });

        let lastError: Error | null = null;
        let elicitationRetries = 0;
        for (let attempt = 0; attempt <= MAX_SESSION_RETRIES; attempt++) {
          try {
            const toolUseID = context.toolUseId ?? "";
            const meta = { 'claudecode/toolUseId': toolUseID };

            const callPromise = client.callTool(def.name, params, meta);
            let result: MCPToolResult;

            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortHandler: (() => void) | undefined;
            const racers: Promise<MCPToolResult>[] = [callPromise];

            if (timeout) {
              racers.push(new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`MCP tool ${def.name} timed out after ${timeout}ms`)), timeout);
              }));
            }

            if (context.abortController.signal.aborted) throw new Error("Aborted");
            racers.push(new Promise<never>((_, reject) => {
              abortHandler = () => reject(new Error("Aborted"));
              context.abortController.signal.addEventListener("abort", abortHandler, { once: true });
            }));

            try {
              result = await Promise.race(racers);
            } finally {
              if (timer !== undefined) clearTimeout(timer);
              if (abortHandler) {
                context.abortController.signal.removeEventListener("abort", abortHandler);
              }
            }

            if (result.isError) {
              const errorText = result.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("\n") || `MCP tool ${def.name} returned an error`;
              throw new McpToolCallError(errorText, def.name, serverName, {
                _meta: result._meta,
              });
            }

            // Convert MCP result to AgentToolResult
            const content: ContentBlock[] = [];
            for (const block of result.content) {
              if (block.type === "text" && block.text) {
                content.push({ type: "text", text: block.text } satisfies TextContent);
              } else if (block.type === "image" && block.data && block.mimeType) {
                content.push({
                  type: "image",
                  source: { type: "base64", mediaType: block.mimeType, data: block.data },
                } satisfies ImageContent);
              } else if (block.type === "resource" && block.uri) {
                content.push({ type: "text", text: `[Resource: ${block.uri}]` } satisfies TextContent);
              }
            }

            if (content.length === 0) {
              content.push({ type: "text", text: "(empty result)" });
            }

            // Persist large MCP results to disk
            const totalTextSize = content.reduce(
              (sum, b) => sum + (b.type === "text" ? (b as TextContent).text.length : 0),
              0,
            );
            const hasImages = content.some((b) => b.type === "image");
            if (totalTextSize > LARGE_MCP_RESULT_CHARS && !hasImages) {
              const timestamp = Date.now();
              const persistId = `mcp-${normalizeNameForMCP(serverName)}-${normalizeNameForMCP(def.name)}-${timestamp}`;
              const contentStr = content.length === 1 && content[0]!.type === "text"
                ? (content[0] as TextContent).text
                : JSON.stringify(content, null, 2);
              const persistResult = await persistToolResult(contentStr, persistId);
              if (!isPersistError(persistResult)) {
                const message = buildLargeToolResultMessage(persistResult);
                content.splice(0, content.length, { type: "text", text: message } satisfies TextContent);
              }
            }

            const toolResult: AgentToolResult = { data: content };

            if (result._meta || result.structuredContent) {
              toolResult.mcpMeta = {
                _meta: result._meta,
                structuredContent: result.structuredContent,
              };
            }

            const elapsedTimeMs = Date.now() - startTime;
            onProgress?.({
              toolUseID: context.toolUseId ?? "",
              data: { type: "mcp_progress", status: "completed", serverName, toolName: def.name, elapsedTimeMs },
            });

            return toolResult;
          } catch (err) {
            if (isSessionExpiredError(err)) {
              if (attempt < MAX_SESSION_RETRIES) {
                lastError = err instanceof Error ? err : new Error(String(err));
                await client.connect();
                continue;
              }
              const elapsedTimeMs = Date.now() - startTime;
              onProgress?.({
                toolUseID: context.toolUseId ?? "",
                data: { type: "mcp_progress", status: "failed", serverName, toolName: def.name, elapsedTimeMs },
              });
              throw err instanceof McpSessionExpiredError
                ? err
                : new McpSessionExpiredError(
                    `MCP session expired during tool call`,
                  );
            }

            if (isMcpElicitationError(err) && adapter._elicitationHandler && elicitationRetries < MAX_URL_ELICITATION_RETRIES) {
              try {
                const elicitResult = await adapter._elicitationHandler(
                  serverName,
                  (err as any).data ?? {},
                  context.abortController.signal,
                );
                if (elicitResult) {
                  lastError = err;
                  elicitationRetries++;
                  attempt--;
                  continue;
                }
              } catch {
                // Elicitation failed — fall through to error handling
              }
            }

            if (err instanceof Error) {
              const errorCode = 'code' in err ? (err as Error & { code?: number }).code : undefined;
              if (errorCode === 401 || err.name === "UnauthorizedError") {
                const authErr = new McpAuthError(serverName, `MCP server "${serverName}" requires re-authorization (token expired)`);
                const status = adapter._servers.get(serverName);
                if (status) status.status = "needs_auth";
                throw authErr;
              }
            }

            if (err instanceof McpAuthError) {
              const status = adapter._servers.get(serverName);
              if (status) status.status = "needs_auth";
            }
            const elapsedTimeMs = Date.now() - startTime;
            onProgress?.({
              toolUseID: context.toolUseId ?? "",
              data: { type: "mcp_progress", status: "failed", serverName, toolName: def.name, elapsedTimeMs },
            });
            throw err;
          }
        }
        throw lastError ?? new Error("MCP call failed after retries");
      },
    }) as AgentTool;
  }
}

// Re-export for use in tool name parsing
export { buildMcpToolName, normalizeNameForMCP };
