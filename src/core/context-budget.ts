// Context budget — closed-loop token budget enforcement
//
// Called inside the agent loop on every turn. Directly mutates the
// DeferredToolRegistry to force-defer tools when the budget is exceeded,
// then returns updated tool list and budget metrics.

import type { AgentTool } from "../tools/types.js";
import type { AgentMessage } from "../types.js";
import type { DeferredToolRegistry } from "../tools/deferred-tools.js";
import { estimateTokens } from "../compaction/compaction.js";
import { zodToJsonSchema } from "../utils/zodToJsonSchema.js";

/** Get JSON Schema for a tool (inputJSONSchema takes priority, otherwise convert Zod). */
function getToolJsonSchema(tool: AgentTool): Record<string, unknown> {
  if (tool.inputJSONSchema) return tool.inputJSONSchema;
  try {
    return zodToJsonSchema(tool.inputSchema);
  } catch {
    return {};
  }
}

export interface ContextBudget {
  maxContextTokens: number;
  reserveOutputTokens: number;
  /** Max fraction of context for tool definitions. Default: 0.15 (15%). */
  maxToolFraction?: number;
}

export interface BudgetResult {
  /** Tools that should be sent to the LLM this turn (post-deferral). */
  activeTools: AgentTool[];
  /** Tool names that were deferred (for system prompt listing). */
  deferredNames: string[];
  /** Available tokens for output after all input is accounted for. */
  availableForOutput: number;
  /** Whether history compaction is recommended. */
  shouldCompact: boolean;
}

/** Estimate token count for tool definitions. */
export async function estimateToolTokens(tools: AgentTool[]): Promise<number> {
  let total = 0;
  for (const tool of tools) {
    const desc = await tool.description({}, { isNonInteractiveSession: false, toolPermissionContext: { mode: "default", additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }, tools });
    total += Math.ceil((tool.name.length + desc.length) / 4);
    const schema = getToolJsonSchema(tool);
    total += Math.ceil(JSON.stringify(schema).length / 4);
    total += 20;
  }
  return total;
}

function estimatePromptTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

/**
 * Enforce token budget. If tool definitions exceed the budget fraction,
 * force-defer the largest tools via the registry and re-partition.
 *
 * The `calibrationRatio` parameter corrects heuristic estimates using
 * the ratio of (API-reported tokens / estimated tokens) from the previous turn.
 * A ratio > 1.0 means our estimates were too low (undercount).
 *
 * Returns the final active tool list, deferred names, and budget metrics.
 * The caller uses these directly — no need to call partition() again.
 */
export async function enforceBudget(
  systemPrompt: string,
  allTools: AgentTool[],
  messages: AgentMessage[],
  budget: ContextBudget,
  deferredRegistry?: DeferredToolRegistry,
  calibrationRatio = 1.0,
): Promise<BudgetResult> {
  const rawSystemPromptTokens = estimatePromptTokens(systemPrompt);
  const rawHistoryTokens = estimateTokens(messages);

  // Apply calibration: if the API told us our estimates were off, correct them
  const systemPromptTokens = Math.ceil(rawSystemPromptTokens * calibrationRatio);
  const historyTokens = Math.ceil(rawHistoryTokens * calibrationRatio);
  const maxToolBudget = Math.floor(
    budget.maxContextTokens * (budget.maxToolFraction ?? 0.15),
  );

  let activeTools = allTools;
  let deferredNames: string[] = [];

  // Step 1: If we have a registry, do the initial partition
  if (deferredRegistry) {
    deferredRegistry.setTools(allTools);
    const initial = deferredRegistry.partition();
    activeTools = initial.activeTools;
    deferredNames = initial.deferredNames;
  }

  // Step 2: If active tools exceed budget, force-defer the largest ones.
  // Never force-defer tools that were previously activated via ToolSearch —
  // the model already fetched their schema and may try to call them. Removing
  // them would cause confusing "unknown tool" errors.
  let toolTokens = await estimateToolTokens(activeTools);
  if (toolTokens > maxToolBudget && deferredRegistry) {
    const activatedNames = deferredRegistry.getActivatedNames();
    // Sort active tools by schema size descending (defer most expensive first)
    // Never defer ToolSearch itself, activated tools, or alwaysLoad tools.
    const candidates = activeTools
      .filter((t) =>
        t.name !== "ToolSearch" &&
        !activatedNames.has(t.name) &&
        !t.alwaysLoad,
      )
      .map((t) => ({
        tool: t,
        tokens: Math.ceil(JSON.stringify(getToolJsonSchema(t)).length / 4) + 20,
      }))
      .sort((a, b) => b.tokens - a.tokens);

    const toDeferNames = new Set<string>();
    let excess = toolTokens - maxToolBudget;
    for (const c of candidates) {
      if (excess <= 0) break;
      toDeferNames.add(c.tool.name);
      excess -= c.tokens;
    }

    if (toDeferNames.size > 0) {
      // Remove force-deferred tools from active list, add to deferred names
      activeTools = activeTools.filter((t) => !toDeferNames.has(t.name));
      deferredNames = [...deferredNames, ...toDeferNames];
      toolTokens = await estimateToolTokens(activeTools);
    }
  }

  const totalTokens = systemPromptTokens + toolTokens + historyTokens;
  const availableForOutput = Math.max(0, budget.maxContextTokens - totalTokens);
  const shouldCompact = totalTokens > budget.maxContextTokens - budget.reserveOutputTokens;

  return { activeTools, deferredNames, availableForOutput, shouldCompact };
}
