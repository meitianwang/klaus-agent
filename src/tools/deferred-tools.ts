// Deferred tools — progressive disclosure with same-turn schema injection
//
// Core tools are always sent with full schemas. All others are deferred:
// only their names appear in the system prompt. When the model calls ToolSearch,
// the full JSON schema is returned in the tool result. The tool is also activated
// so it appears in the tools parameter on the NEXT inner-loop iteration (same turn).
//
// Flow (within a single prompt() call — "same step" means same inner loop):
//  Iteration N:   model calls tool_search({query: "WebFetch"})
//                 → result contains full JSON schema
//                 → tool marked as activated in registry
//                 → hasMoreWork = true, inner loop continues
//  Iteration N+1: enforceBudget/partition() includes WebFetch in activeTools
//                 → model sees WebFetch in tool definitions
//                 → model calls WebFetch with correct parameters

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "./types.js";

export interface DeferredToolsConfig {
  /** Tool names that are always sent with full schema. */
  alwaysInclude?: string[];
  /** Max tools to send per turn. Excess tools are deferred. Default: Infinity. */
  maxToolsPerTurn?: number;
}

export class DeferredToolRegistry {
  private _allTools: AgentTool[] = [];
  private _alwaysInclude: Set<string>;
  private _maxPerTurn: number;
  private _activated = new Set<string>();

  constructor(config: DeferredToolsConfig = {}) {
    this._alwaysInclude = new Set(config.alwaysInclude ?? []);
    this._maxPerTurn = config.maxToolsPerTurn ?? Infinity;
  }

  setTools(tools: AgentTool[]): void {
    this._allTools = tools;
  }

  /**
   * Split tools into active (full schema sent) and deferred (name-only).
   * Active = alwaysInclude ∪ previously-activated ∪ first N that fit.
   * Deferred = everything else.
   * If any deferred exist, the built-in tool_search tool is added to active.
   */
  partition(): { activeTools: AgentTool[]; deferredNames: string[] } {
    // Fast path: everything fits
    if (this._alwaysInclude.size === 0 && this._maxPerTurn >= this._allTools.length) {
      return { activeTools: this._allTools, deferredNames: [] };
    }

    const active: AgentTool[] = [];
    const deferred: string[] = [];

    for (const tool of this._allTools) {
      if (tool.name === "tool_search") {
        active.push(tool);
        continue;
      }
      const mustInclude = this._alwaysInclude.has(tool.name) || this._activated.has(tool.name);
      if (mustInclude) {
        active.push(tool);
      } else if (active.length < this._maxPerTurn) {
        active.push(tool);
      } else {
        deferred.push(tool.name);
      }
    }

    if (deferred.length > 0 && !active.some((t) => t.name === "tool_search")) {
      active.push(this._buildToolSearchTool());
    }

    return { activeTools: active, deferredNames: deferred };
  }

  activate(name: string): AgentTool | undefined {
    const tool = this._allTools.find((t) => t.name === name);
    if (tool) this._activated.add(name);
    return tool;
  }

  /** Format the system prompt section listing deferred tools. */
  formatDeferredSection(names: string[]): string {
    if (names.length === 0) return "";
    return (
      "The following deferred tools are now available via ToolSearch:\n" +
      names.join("\n")
    );
  }

  // ── ToolSearch tool ───────────────────────────────────────────

  private _buildToolSearchTool(): AgentTool {
    const registry = this;

    return {
      name: "tool_search",
      label: "ToolSearch",
      description:
        "Fetches full schema definitions for deferred tools so they can be called.\n\n" +
        "Deferred tools appear by name in <system-reminder> messages. Until fetched, " +
        "only the name is known — there is no parameter schema, so the tool cannot be invoked. " +
        "This tool takes a query, matches it against the deferred tool list, and returns the " +
        "matched tools' complete JSONSchema definitions inside a <functions> block. Once a " +
        "tool's schema appears in that result, it is callable exactly like any tool defined " +
        "at the top of the prompt.\n\n" +
        "Result format: each matched tool appears as one " +
        '<function>{"description": "...", "name": "...", "parameters": {...}}</function> ' +
        "line inside the <functions> block — the same encoding as the tool list at the top of this prompt.\n\n" +
        "Query forms:\n" +
        '- "select:Read,Edit,Grep" — fetch these exact tools by name\n' +
        '- "notebook jupyter" — keyword search, up to max_results best matches\n' +
        '- "+slack send" — require "slack" in the name, rank by remaining terms',
      parameters: Type.Object({
        query: Type.String({
          description:
            'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
        }),
        max_results: Type.Optional(
          Type.Number({ description: "Maximum number of results to return (default: 5)", default: 5 }),
        ),
      }),

      async execute(
        _toolCallId: string,
        params: { query: string; max_results?: number },
      ): Promise<AgentToolResult> {
        const { query, max_results = 5 } = params;

        let matched: AgentTool[] = [];

        if (query.startsWith("select:")) {
          // Direct selection by name
          const names = query.slice(7).split(",").map((n) => n.trim());
          for (const name of names) {
            const tool = registry._allTools.find((t) => t.name === name);
            if (tool) matched.push(tool);
          }
        } else {
          // Keyword search
          matched = registry._search(query, max_results);
        }

        if (matched.length === 0) {
          return { content: [{ type: "text", text: `No tools found matching "${query}".` }] };
        }

        // Activate all matched tools so they appear in next partition()
        for (const tool of matched) {
          registry._activated.add(tool.name);
        }

        // Format as <functions> block — same encoding as the tool list in the prompt
        const functionDefs = matched.map((t) => {
          const def = {
            description: t.description,
            name: t.name,
            parameters: t.parameters ?? {},
          };
          return `<function>${JSON.stringify(def)}</function>`;
        });

        const text = `<functions>\n${functionDefs.join("\n")}\n</functions>`;
        return { content: [{ type: "text", text }] };
      },
    } as AgentTool;
  }

  private _search(query: string, maxResults: number): AgentTool[] {
    const q = query.toLowerCase();
    // "+required rest" syntax: require "required" in name
    let requiredInName: string | null = null;
    let searchTerms = q;
    if (q.startsWith("+")) {
      const spaceIdx = q.indexOf(" ");
      if (spaceIdx > 0) {
        requiredInName = q.slice(1, spaceIdx);
        searchTerms = q.slice(spaceIdx + 1);
      } else {
        requiredInName = q.slice(1);
        searchTerms = "";
      }
    }

    const words = searchTerms.split(/\s+/).filter(Boolean);

    return this._allTools
      .map((t) => {
        const name = t.name.toLowerCase();
        const desc = t.description.toLowerCase();

        if (requiredInName && !name.includes(requiredInName)) return null;

        let score = 0;
        if (name === q) score += 100;
        else if (name.includes(q)) score += 50;
        if (desc.includes(q)) score += 20;
        for (const w of words) {
          if (name.includes(w)) score += 10;
          if (desc.includes(w)) score += 5;
        }
        if (requiredInName && name.includes(requiredInName)) score += 30;

        return score > 0 ? { tool: t, score } : null;
      })
      .filter((x): x is { tool: AgentTool; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((x) => x.tool);
  }
}
