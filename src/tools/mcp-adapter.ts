// MCP adapter — connect to MCP servers, wrap tools as AgentTool

import type { AgentTool, AgentToolResult, ToolExecutionContext } from "../tools/types.js";
import type { TextContent } from "../llm/types.js";
import { Type, type TSchema } from "@sinclair/typebox";

// --- MCP config types ---

export interface MCPServerConfig {
  name: string;
  transport: MCPTransport;
  timeout?: number;
}

export type MCPTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

export interface MCPServerStatus {
  name: string;
  status: "pending" | "connecting" | "connected" | "failed";
  error?: string;
  tools: AgentTool[];
}

// --- MCP tool schema ---

interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface MCPToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

// --- MCP Client interface (abstract over transport) ---

export interface MCPClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  close(): Promise<void>;
}

// --- MCP Adapter ---

export class MCPAdapter {
  private _servers = new Map<string, MCPServerStatus>();
  private _clients = new Map<string, MCPClient>();
  private _loadingPromise: Promise<void> | null = null;

  constructor(
    private _configs: MCPServerConfig[],
    private _clientFactory: (config: MCPServerConfig) => MCPClient,
  ) {
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

  // --- Internal ---

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

      const toolDefs = await client.listTools();
      const tools = toolDefs.map((def) => this._wrapMCPTool(config.name, def, client, config.timeout));

      status.status = "connected";
      status.tools = tools;
    } catch (err) {
      status.status = "failed";
      status.error = err instanceof Error ? err.message : String(err);
    }
  }

  private _wrapMCPTool(
    serverName: string,
    def: MCPToolDefinition,
    client: MCPClient,
    timeout?: number,
  ): AgentTool {
    const toolName = `${serverName}__${def.name}`;
    const schema = (def.inputSchema as TSchema) ?? Type.Object({});

    return {
      name: toolName,
      label: def.name,
      description: def.description ?? `MCP tool: ${def.name}`,
      parameters: schema,
      approvalAction: `mcp:${serverName}:${def.name}`,

      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        context: ToolExecutionContext,
      ): Promise<AgentToolResult> {
        // Approval is handled by the executor via approvalAction field
        // No need to request approval here

        // Call with timeout and abort signal support
        const callPromise = client.callTool(def.name, params);
        let result: MCPToolResult;

        if (timeout || context.signal) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {};
          const racers: Promise<MCPToolResult>[] = [callPromise];

          if (timeout) {
            racers.push(new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`MCP tool ${def.name} timed out after ${timeout}ms`)), timeout);
            }));
          }

          if (context.signal) {
            if (context.signal.aborted) throw new Error("Aborted");
            racers.push(new Promise<never>((_, reject) => {
              context.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
            }));
          }

          try {
            result = await Promise.race(racers);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        } else {
          result = await callPromise;
        }

        // Convert MCP result to AgentToolResult
        const content: TextContent[] = result.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => ({ type: "text" as const, text: c.text! }));

        if (content.length === 0) {
          content.push({ type: "text", text: "(empty result)" });
        }

        return { content };
      },
    };
  }
}
