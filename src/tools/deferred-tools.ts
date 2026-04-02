// Deferred tools — progressive disclosure with same-turn schema injection
//
// Aligned with claude-code's ToolSearch system across 4 files:
// - ToolSearchTool/constants.ts (TOOL_SEARCH_TOOL_NAME)
// - ToolSearchTool/prompt.ts (isDeferredTool, formatDeferredToolLine, getPrompt)
// - ToolSearchTool/ToolSearchTool.ts (ToolSearch tool, search logic, caching)
// - utils/toolSearch.ts (mode, threshold, delta, discovery)

import { z } from "zod/v4";
import { lazySchema } from "../utils/lazySchema.js";
import type {
  AgentTool,
  AgentToolResult,
  AgentTools,
  ToolPermissionContext,
} from "./types.js";
import { buildTool, findToolByName } from "./types.js";

// =============================================================================
// 1. Constants
// =============================================================================

export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

`;

const PROMPT_TAIL =
  ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;

/**
 * Default percentage of context window at which to auto-enable tool search.
 */
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10; // 10%

/**
 * Approximate chars per token for tool definitions.
 * Used as fallback when no token counting API is available.
 */
const CHARS_PER_TOKEN = 2.5;

// =============================================================================
// 2. Types
// =============================================================================

export type DeferredToolsDelta = {
  addedNames: string[];
  addedLines: string[];
  removedNames: string[];
};

export type ToolSearchMode = "tst" | "tst-auto" | "standard";

export interface DeferredToolsConfig {
  alwaysInclude?: string[];
  maxToolsPerTurn?: number;
  neverDeferToolNames?: string[];
  getPendingMCPServers?: () => string[];
  modelId?: string;
}

// =============================================================================
// 3. Core deferral functions
// =============================================================================

/**
 * Module-level set of tool names that should never be deferred.
 * Configured via configureNeverDeferToolNames().
 */
let _neverDeferToolNames = new Set<string>();

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 * Single-parameter signature aligned with claude-code's isDeferredTool.
 *
 * A tool is deferred if:
 * - It's an MCP tool (always deferred — workflow-specific)
 * - It has shouldDefer: true
 *
 * A tool is NEVER deferred if:
 * - alwaysLoad: true (checked first)
 * - It's ToolSearch itself
 * - It's in the _neverDeferToolNames set
 */
export function isDeferredTool(tool: AgentTool): boolean {
  // Explicit opt-out via alwaysLoad — checked first so MCP tools can opt out
  if (tool.alwaysLoad === true) return false;

  // MCP tools are always deferred (workflow-specific)
  if (tool.isMcp === true) return true;

  // Never defer ToolSearch itself — the model needs it to load everything else
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false;

  // Feature-gated exceptions configured at startup
  if (_neverDeferToolNames.has(tool.name)) return false;

  return tool.shouldDefer === true;
}

/**
 * Format one deferred-tool line for display.
 * Aligned with claude-code: returns tool.name (no searchHint).
 */
export function formatDeferredToolLine(tool: AgentTool): string {
  return tool.name;
}

// =============================================================================
// 4. Tool search mode/config functions
// =============================================================================

function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith("auto:")) return null;
  const percent = parseInt(value.slice(5), 10);
  if (isNaN(percent)) return null;
  return Math.max(0, Math.min(100, percent));
}

function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) return false;
  return value === "auto" || value.startsWith("auto:");
}

function getAutoToolSearchPercentage(): number {
  const value = process.env.ENABLE_TOOL_SEARCH;
  if (!value || value === "auto") return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE;
  const parsed = parseAutoPercentage(value);
  if (parsed !== null) return parsed;
  return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE;
}

/**
 * Check if a URL is a first-party Anthropic endpoint.
 */
function isFirstPartyAnthropicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith(".anthropic.com") || parsed.hostname === "anthropic.com";
  } catch {
    return false;
  }
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower === "true" || lower === "1";
}

function isEnvDefinedFalsy(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const lower = value.toLowerCase();
  return lower === "false" || lower === "0";
}

/**
 * Determines the tool search mode from ENABLE_TOOL_SEARCH.
 * Aligned with claude-code's getToolSearchMode.
 */
export function getToolSearchMode(): ToolSearchMode {
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is a kill switch for beta API features.
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return "standard";
  }

  const value = process.env.ENABLE_TOOL_SEARCH;

  // Handle auto:N syntax — check edge cases first
  const autoPercent = value ? parseAutoPercentage(value) : null;
  if (autoPercent === 0) return "tst"; // auto:0 = always enabled
  if (autoPercent === 100) return "standard";
  if (isAutoToolSearchMode(value)) {
    return "tst-auto"; // auto or auto:1-99
  }

  if (isEnvTruthy(value)) return "tst";
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return "standard";
  return "tst"; // default: always defer MCP and shouldDefer tools
}

/**
 * Default patterns for models that do NOT support tool_reference.
 */
const DEFAULT_UNSUPPORTED_MODEL_PATTERNS = ["haiku"];

/**
 * Get the list of model patterns that do NOT support tool_reference.
 */
function getUnsupportedToolReferencePatterns(): string[] {
  return _unsupportedToolReferencePatterns ?? DEFAULT_UNSUPPORTED_MODEL_PATTERNS;
}

/**
 * Check if a model supports tool_reference blocks.
 * Aligned with claude-code's modelSupportsToolReference.
 */
export function modelSupportsToolReference(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  const unsupportedPatterns = getUnsupportedToolReferencePatterns();
  for (const pattern of unsupportedPatterns) {
    if (normalizedModel.includes(pattern.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/**
 * Optimistic check for whether ToolSearch might be enabled.
 * Aligned with claude-code's isToolSearchEnabledOptimistic with logged-once flag.
 */
let _loggedOptimistic = false;

export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode();
  if (mode === "standard") {
    if (!_loggedOptimistic) {
      _loggedOptimistic = true;
    }
    return false;
  }

  // tool_reference is a beta content type that third-party API gateways
  // typically don't support. Only disable when ENABLE_TOOL_SEARCH is unset.
  if (
    !process.env.ENABLE_TOOL_SEARCH &&
    _apiProvider === "firstParty" &&
    process.env.ANTHROPIC_BASE_URL &&
    !isFirstPartyAnthropicUrl(process.env.ANTHROPIC_BASE_URL)
  ) {
    if (!_loggedOptimistic) {
      _loggedOptimistic = true;
    }
    return false;
  }

  if (!_loggedOptimistic) {
    _loggedOptimistic = true;
  }
  return true;
}

/**
 * Check if ToolSearchTool is available in the provided tools list.
 * Aligned with claude-code's isToolSearchToolAvailable.
 */
export function isToolSearchToolAvailable(
  tools: readonly { name: string; aliases?: string[] }[],
): boolean {
  return tools.some(
    (tool) =>
      tool.name === TOOL_SEARCH_TOOL_NAME ||
      (tool.aliases?.includes(TOOL_SEARCH_TOOL_NAME) ?? false),
  );
}

/**
 * Check if an object is a tool_reference block.
 * Aligned with claude-code's isToolReferenceBlock.
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "type" in obj &&
    (obj as { type: unknown }).type === "tool_reference"
  );
}

// =============================================================================
// 5. Token/threshold functions
// =============================================================================

/**
 * Calculate total deferred tool description size in characters.
 * Aligned with claude-code's calculateDeferredToolDescriptionChars.
 */
async function calculateDeferredToolDescriptionChars(
  tools: AgentTool[],
): Promise<number> {
  const deferredTools = tools.filter((t) => isDeferredTool(t));
  if (deferredTools.length === 0) return 0;

  const sizes = await Promise.all(
    deferredTools.map(async (tool) => {
      let descSize = 0;
      try {
        const desc = await tool.prompt({
          getToolPermissionContext: async () => ({
            mode: "default" as const,
            additionalWorkingDirectories: new Map(),
            alwaysAllowRules: {},
            alwaysDenyRules: {},
            alwaysAskRules: {},
            isBypassPermissionsModeAvailable: false,
          }),
          tools,
          agents: [],
        });
        descSize = desc.length;
      } catch {
        descSize = 0;
      }
      const schemaSize = tool.inputSchema ? JSON.stringify(tool.inputSchema).length : 0;
      return tool.name.length + descSize + schemaSize;
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
}

function getAutoToolSearchTokenThreshold(contextWindowTokens: number): number {
  const percentage = getAutoToolSearchPercentage() / 100;
  return Math.floor(contextWindowTokens * percentage);
}

export function getAutoToolSearchCharThreshold(contextWindowTokens: number): number {
  return Math.floor(getAutoToolSearchTokenThreshold(contextWindowTokens) * CHARS_PER_TOKEN);
}

/**
 * Get the token count for all deferred tools.
 * Tries the injected token counting function first (exact API count),
 * falls back to char-based estimation if unavailable.
 * Memoized by deferred tool name set.
 * Aligned with claude-code's getDeferredToolTokenCount.
 */
let _deferredTokenCountCache: { key: string; value: number | null } | null = null;
let _countToolDefinitionTokens: ((tools: AgentTool[]) => Promise<number | null>) | undefined;

/**
 * Configure the token counting function. When provided, getDeferredToolTokenCount
 * will call this for exact token counts before falling back to char estimation.
 * Aligned with claude-code's countToolDefinitionTokens from analyzeContext.
 */
export function configureTokenCounter(
  counter: (tools: AgentTool[]) => Promise<number | null>,
): void {
  _countToolDefinitionTokens = counter;
}

export async function getDeferredToolTokenCount(
  tools: AgentTool[],
): Promise<number | null> {
  const deferredTools = tools.filter((t) => isDeferredTool(t));
  const cacheKey = deferredTools
    .map((t) => t.name)
    .sort()
    .join(",");

  if (_deferredTokenCountCache && _deferredTokenCountCache.key === cacheKey) {
    return _deferredTokenCountCache.value;
  }

  // Try exact token counting API first — aligned with claude-code
  if (_countToolDefinitionTokens) {
    try {
      const tokens = await _countToolDefinitionTokens(deferredTools);
      if (tokens !== null) {
        _deferredTokenCountCache = { key: cacheKey, value: tokens };
        return tokens;
      }
    } catch {
      // Fall through to char-based estimation
    }
  }

  // Fallback: char-based estimation
  const chars = await calculateDeferredToolDescriptionChars(tools);
  const result = Math.ceil(chars / CHARS_PER_TOKEN);
  _deferredTokenCountCache = { key: cacheKey, value: result };
  return result;
}

/**
 * Check whether deferred tools exceed the auto-threshold for enabling tool search.
 * Tries exact token count first, falls back to char-based heuristic.
 * Aligned with claude-code's checkAutoThreshold.
 */
export async function checkAutoThreshold(
  tools: AgentTool[],
  contextWindowTokens: number,
): Promise<{
  enabled: boolean;
  debugDescription: string;
  metrics: Record<string, number>;
}> {
  // Try exact token count first — aligned with claude-code
  const tokens = await getDeferredToolTokenCount(tools);
  if (tokens !== null) {
    const tokenThreshold = getAutoToolSearchTokenThreshold(contextWindowTokens);
    return {
      enabled: tokens >= tokenThreshold,
      debugDescription:
        `${tokens} tokens (threshold: ${tokenThreshold}, ` +
        `${getAutoToolSearchPercentage()}% of context)`,
      metrics: { deferredToolTokenCount: tokens, tokenThreshold },
    };
  }

  // Fallback: char-based heuristic
  const deferredToolDescriptionChars = await calculateDeferredToolDescriptionChars(tools);
  const charThreshold = getAutoToolSearchCharThreshold(contextWindowTokens);
  return {
    enabled: deferredToolDescriptionChars >= charThreshold,
    debugDescription:
      `${deferredToolDescriptionChars} chars (threshold: ${charThreshold}, ` +
      `${getAutoToolSearchPercentage()}% of context) (char fallback)`,
    metrics: { deferredToolDescriptionChars, charThreshold },
  };
}

// =============================================================================
// 6. Delta functions
// =============================================================================

/** Configurable flag for delta mode. Defaults to false. */
let _deferredToolsDeltaEnabled = false;

export function isDeferredToolsDeltaEnabled(): boolean {
  return _deferredToolsDeltaEnabled;
}

/**
 * Diff the current deferred-tool pool against what's already been
 * announced in this conversation. Returns null if nothing changed.
 * Aligned with claude-code's getDeferredToolsDelta signature and logic.
 */
export function getDeferredToolsDelta(
  tools: AgentTool[],
  messages: ReadonlyArray<{
    role?: string;
    content?: unknown;
    type?: string;
    subtype?: string;
    attachment?: any;
  }>,
  neverDeferToolNames?: ReadonlySet<string>,
): DeferredToolsDelta | null {
  // Apply any explicitly passed neverDeferToolNames for this call
  const prevSet = _neverDeferToolNames;
  if (neverDeferToolNames) {
    _neverDeferToolNames = new Set([..._neverDeferToolNames, ...neverDeferToolNames]);
  }

  try {
    const announced = new Set<string>();
    for (const msg of messages) {
      if ((msg as any).type !== "attachment") continue;
      const attachment = (msg as any).attachment;
      if (!attachment || attachment.type !== "deferred_tools_delta") continue;
      if (Array.isArray(attachment.addedNames)) {
        for (const n of attachment.addedNames) announced.add(n);
      }
      if (Array.isArray(attachment.removedNames)) {
        for (const n of attachment.removedNames) announced.delete(n);
      }
    }

    const deferred = tools.filter((t) => isDeferredTool(t));
    const deferredNames = new Set(deferred.map((t) => t.name));
    const poolNames = new Set(tools.map((t) => t.name));

    const added = deferred.filter((t) => !announced.has(t.name));
    const removed: string[] = [];
    for (const n of announced) {
      if (deferredNames.has(n)) continue;
      if (!poolNames.has(n)) removed.push(n);
      // else: undeferred — silent
    }

    if (added.length === 0 && removed.length === 0) return null;

    return {
      addedNames: added.map((t) => t.name).sort(),
      addedLines: added.map(formatDeferredToolLine).sort(),
      removedNames: removed.sort(),
    };
  } finally {
    _neverDeferToolNames = prevSet;
  }
}

// =============================================================================
// 7. Discovery functions
// =============================================================================

/**
 * Type guard for tool_reference block with tool_name.
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: "tool_reference"; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    "tool_name" in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === "string"
  );
}

/**
 * Type guard for tool_result blocks with array content.
 */
function isToolResultBlockWithContent(
  obj: unknown,
): obj is { type: "tool_result"; content: unknown[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "type" in obj &&
    (obj as { type: unknown }).type === "tool_result" &&
    "content" in obj &&
    Array.isArray((obj as { content: unknown }).content)
  );
}

/**
 * Extract tool names from tool_reference blocks in message history.
 * Aligned with claude-code's extractDiscoveredToolNames, handles compact_boundary.
 */
export function extractDiscoveredToolNames(
  messages: ReadonlyArray<{
    role?: string;
    content?: unknown;
    type?: string;
    subtype?: string;
    compactMetadata?: any;
  }>,
): Set<string> {
  const discoveredTools = new Set<string>();

  for (const msg of messages) {
    // Compact boundary carries the pre-compact discovered set
    if ((msg as any).type === "system" && (msg as any).subtype === "compact_boundary") {
      const carried = (msg as any).compactMetadata?.preCompactDiscoveredTools;
      if (carried) {
        for (const name of carried) {
          if (typeof name === "string") discoveredTools.add(name);
        }
      }
      continue;
    }

    // Only user messages contain tool_result blocks
    if (msg.role !== "user" && (msg as any).type !== "user") continue;
    const content = (msg as any).message?.content ?? msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (isToolResultBlockWithContent(block)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name);
          }
        }
      }
    }
  }

  return discoveredTools;
}

/**
 * Build a hint when a deferred tool is called without being discovered via ToolSearch.
 * Aligned with claude-code's 3-param signature: (tool, messages, tools).
 */
export function buildSchemaNotSentHint(
  tool: AgentTool,
  messages: ReadonlyArray<{ role?: string; content?: unknown; type?: string; subtype?: string; compactMetadata?: any }>,
  allTools: readonly AgentTool[],
): string | null {
  if (!isToolSearchEnabledOptimistic()) return null;
  if (!isToolSearchToolAvailable(allTools)) return null;
  if (!isDeferredTool(tool)) return null;

  const activatedNames = extractDiscoveredToolNames(messages);
  if (activatedNames.has(tool.name)) return null;

  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  );
}

// =============================================================================
// 8. Prompt functions
// =============================================================================

function getToolLocationHint(): string {
  return isDeferredToolsDeltaEnabled()
    ? "Deferred tools appear by name in <system-reminder> messages."
    : "Deferred tools appear by name in <available-deferred-tools> messages.";
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL;
}

/** Alias for getPrompt. */
export function getToolSearchPrompt(): string {
  return getPrompt();
}

// =============================================================================
// 9. Search functions
// =============================================================================

/**
 * Parse tool name into searchable parts.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 * Aligned with claude-code's parseToolName.
 */
export function parseToolName(name: string): {
  parts: string[];
  full: string;
  isMcp: boolean;
} {
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = withoutPrefix.split("__").flatMap((p) => p.split("_"));
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return {
    parts,
    full: parts.join(" "),
    isMcp: false,
  };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pre-compile word-boundary regexes for all search terms.
 * Called once per search instead of tools*terms*2 times.
 */
export function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
    }
  }
  return patterns;
}

/**
 * Keyword-based search over tool names and descriptions.
 * Module-level function aligned with claude-code's searchToolsWithKeywords.
 * Uses lazy per-tool description fetching (not Promise.all pre-fetch).
 */
export async function searchToolsWithKeywords(
  query: string,
  deferredTools: AgentTool[],
  tools: AgentTool[],
  maxResults: number,
): Promise<string[]> {
  const queryLower = query.toLowerCase().trim();

  // Fast path: exact name match
  const exactMatch =
    deferredTools.find((t) => t.name.toLowerCase() === queryLower) ??
    tools.find((t) => t.name.toLowerCase() === queryLower);
  if (exactMatch) {
    return [exactMatch.name];
  }

  // MCP tool prefix matching
  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => t.name);
    if (prefixMatches.length > 0) {
      return prefixMatches;
    }
  }

  const queryTerms = queryLower.split(/\s+/).filter((term) => term.length > 0);

  // Partition into required (+prefixed) and optional terms
  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;
  const termPatterns = compileTermPatterns(allScoringTerms);

  // Pre-filter to tools matching ALL required terms
  let candidateTools = deferredTools;
  if (requiredTerms.length > 0) {
    const matches = await Promise.all(
      deferredTools.map(async (tool) => {
        const parsed = parseToolName(tool.name);
        const description = await getToolDescriptionMemoized(tool.name, tools);
        const descNormalized = description.toLowerCase();
        const hintNormalized = tool.searchHint?.toLowerCase() ?? "";
        const matchesAll = requiredTerms.every((term) => {
          const pattern = termPatterns.get(term)!;
          return (
            parsed.parts.includes(term) ||
            parsed.parts.some((part) => part.includes(term)) ||
            pattern.test(descNormalized) ||
            (hintNormalized && pattern.test(hintNormalized))
          );
        });
        return matchesAll ? tool : null;
      }),
    );
    candidateTools = matches.filter((t): t is AgentTool => t !== null);
  }

  const scored = await Promise.all(
    candidateTools.map(async (tool) => {
      const parsed = parseToolName(tool.name);
      const description = await getToolDescriptionMemoized(tool.name, tools);
      const descNormalized = description.toLowerCase();
      const hintNormalized = tool.searchHint?.toLowerCase() ?? "";

      let score = 0;
      for (const term of allScoringTerms) {
        const pattern = termPatterns.get(term)!;

        // Exact part match
        if (parsed.parts.includes(term)) {
          score += parsed.isMcp ? 12 : 10;
        } else if (parsed.parts.some((part) => part.includes(term))) {
          score += parsed.isMcp ? 6 : 5;
        }

        // Full name fallback
        if (parsed.full.includes(term) && score === 0) {
          score += 3;
        }

        // searchHint match
        if (hintNormalized && pattern.test(hintNormalized)) {
          score += 4;
        }

        // Description match
        if (pattern.test(descNormalized)) {
          score += 2;
        }
      }

      return { name: tool.name, score };
    }),
  );

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.name);
}

// =============================================================================
// 10. Description caching
// =============================================================================

const _descriptionCache = new Map<string, string>();
let _cachedDeferredToolNames: string | null = null;

/**
 * Get tool description, memoized by tool name.
 * Module-level memoized function using a Map (no lodash dependency).
 * Aligned with claude-code's getToolDescriptionMemoized.
 */
async function getToolDescriptionMemoized(
  toolName: string,
  tools: readonly AgentTool[],
): Promise<string> {
  const cached = _descriptionCache.get(toolName);
  if (cached !== undefined) return cached;

  const tool = findToolByName(tools, toolName);
  if (!tool) {
    _descriptionCache.set(toolName, "");
    return "";
  }
  try {
    const desc = await tool.prompt({
      getToolPermissionContext: async () => ({
        mode: "default" as const,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }),
      tools,
      agents: [],
    });
    _descriptionCache.set(toolName, desc);
    return desc;
  } catch {
    _descriptionCache.set(toolName, "");
    return "";
  }
}

/**
 * Invalidate the description cache if deferred tools have changed.
 * Aligned with claude-code's maybeInvalidateCache.
 */
function maybeInvalidateCache(deferredTools: readonly AgentTool[]): void {
  const currentKey = deferredTools
    .map((t) => t.name)
    .sort()
    .join(",");
  if (_cachedDeferredToolNames !== currentKey) {
    _descriptionCache.clear();
    _cachedDeferredToolNames = currentKey;
  }
}

/**
 * Clear the tool search description cache.
 * Aligned with claude-code's clearToolSearchDescriptionCache.
 */
export function clearToolSearchDescriptionCache(): void {
  _descriptionCache.clear();
  _cachedDeferredToolNames = null;
}

// =============================================================================
// 11. ToolSearch tool definition
// =============================================================================

export const inputSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
      ),
    max_results: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum number of results to return (default: 5)"),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

export const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(z.string()),
    query: z.string(),
    total_deferred_tools: z.number(),
    pending_mcp_servers: z.array(z.string()).optional(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type ToolSearchOutput = z.infer<OutputSchema>;

/**
 * Build the search result output structure.
 * Aligned with claude-code's buildSearchResult.
 */
function buildSearchResult(
  matches: string[],
  query: string,
  totalDeferredTools: number,
  pendingMcpServers?: string[],
): { data: ToolSearchOutput } {
  return {
    data: {
      matches,
      query,
      total_deferred_tools: totalDeferredTools,
      ...(pendingMcpServers && pendingMcpServers.length > 0
        ? { pending_mcp_servers: pendingMcpServers }
        : {}),
    },
  };
}

/**
 * Module-level ToolSearch tool built with buildTool().
 * Aligned with claude-code's ToolSearchTool.
 */
export const ToolSearchTool = buildTool({
  isEnabled() {
    return isToolSearchEnabledOptimistic();
  },
  isConcurrencySafe() {
    return true;
  },
  isReadOnly() {
    return true;
  },
  name: TOOL_SEARCH_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return getPrompt();
  },
  async prompt() {
    return getPrompt();
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  async call(
    input: { query: string; max_results?: number },
    context: {
      options: { tools: readonly AgentTool[] };
      getAppState(): Record<string, unknown>;
      analytics?: { logEvent(name: string, metadata: Record<string, unknown>): void };
    },
  ): Promise<AgentToolResult<ToolSearchOutput>> {
    const { query, max_results = 5 } = input;
    const tools = context.options.tools as AgentTool[];

    const deferredTools = tools.filter(isDeferredTool);
    maybeInvalidateCache(deferredTools);

    // Check for MCP servers still connecting — aligned with claude-code
    function getPendingServerNames(): string[] | undefined {
      const appState = context.getAppState();
      const mcp = appState.mcp as { clients?: Array<{ name: string; type?: string; status?: string }> } | undefined;
      if (!mcp?.clients) return undefined;
      const pending = mcp.clients.filter(c => c.type === "pending" || c.status === "pending");
      return pending.length > 0 ? pending.map(s => s.name) : undefined;
    }

    // Helper to log search outcome via DI analytics
    function logSearchOutcome(
      matches: string[],
      queryType: "select" | "keyword",
    ): void {
      context.analytics?.logEvent("tengu_tool_search_outcome", {
        query,
        queryType,
        matchCount: matches.length,
        totalDeferredTools: deferredTools.length,
        maxResults: max_results,
        hasMatches: matches.length > 0,
      });
    }

    // Check for select: prefix — direct tool selection
    const selectMatch = query.match(/^select:(.+)$/i);
    if (selectMatch) {
      const requested = selectMatch[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const found: string[] = [];
      const missing: string[] = [];
      for (const toolName of requested) {
        const tool =
          findToolByName(deferredTools, toolName) ??
          findToolByName(tools, toolName);
        if (tool) {
          if (!found.includes(tool.name)) found.push(tool.name);
        } else {
          missing.push(toolName);
        }
      }

      logSearchOutcome(found, "select");

      if (found.length === 0) {
        const pendingServers = getPendingServerNames();
        return buildSearchResult([], query, deferredTools.length, pendingServers);
      }

      return buildSearchResult(found, query, deferredTools.length);
    }

    // Keyword search
    const matches = await searchToolsWithKeywords(
      query,
      deferredTools,
      tools,
      max_results,
    );

    logSearchOutcome(matches, "keyword");

    // Include pending server info when search finds no matches
    if (matches.length === 0) {
      const pendingServers = getPendingServerNames();
      return buildSearchResult(matches, query, deferredTools.length, pendingServers);
    }

    return buildSearchResult(matches, query, deferredTools.length);
  },
  renderToolUseMessage() {
    return null;
  },
  userFacingName: () => "",
  mapToolResultToToolResultBlockParam(
    content: ToolSearchOutput,
    toolUseID: string,
  ) {
    if (content.matches.length === 0) {
      let text = "No matching deferred tools found";
      if (
        content.pending_mcp_servers &&
        content.pending_mcp_servers.length > 0
      ) {
        text += `. Some MCP servers are still connecting: ${content.pending_mcp_servers.join(", ")}. Their tools will become available shortly — try searching again.`;
      }
      return {
        type: "tool_result" as const,
        tool_use_id: toolUseID,
        content: text,
      };
    }
    return {
      type: "tool_result" as const,
      tool_use_id: toolUseID,
      content: content.matches.map((name) => ({
        type: "tool_reference" as const,
        tool_name: name,
      })),
    } as any;
  },
});

// =============================================================================
// 12. SDK wrapper class (DeferredToolRegistry)
// =============================================================================

/**
 * Optional API provider identifier for proxy detection.
 * Set via configureApiProvider().
 */
let _apiProvider: string = "firstParty";

let _unsupportedToolReferencePatterns: string[] | undefined;

/**
 * Configure the API provider type.
 */
export function configureApiProvider(provider: string): void {
  _apiProvider = provider;
}

/**
 * Configure whether deferred tools delta mode is enabled.
 */
export function configureDeferredToolsDelta(enabled: boolean): void {
  _deferredToolsDeltaEnabled = enabled;
}

/**
 * Configure the list of model name patterns that do NOT support tool_reference.
 */
export function configureUnsupportedToolReferencePatterns(patterns: string[]): void {
  _unsupportedToolReferencePatterns = patterns;
}

/**
 * Configure the set of tool names that should never be deferred.
 */
export function configureNeverDeferToolNames(names: string[]): void {
  _neverDeferToolNames = new Set(names);
}

/**
 * Definitive async check for whether tool search is enabled.
 * Aligned with claude-code's isToolSearchEnabled parameter pattern.
 */
export interface ToolSearchEnabledConfig {
  modelId: string;
  tools: AgentTool[];
  contextWindowTokens: number;
  source?: string;
}

export async function isToolSearchEnabled(config: ToolSearchEnabledConfig): Promise<boolean> {
  const { modelId, tools, contextWindowTokens } = config;

  if (!modelSupportsToolReference(modelId)) {
    return false;
  }

  if (!isToolSearchToolAvailable(tools)) {
    return false;
  }

  const mode = getToolSearchMode();

  switch (mode) {
    case "tst":
      return true;

    case "tst-auto": {
      const result = await checkAutoThreshold(tools, contextWindowTokens);
      return result.enabled;
    }

    case "standard":
      return false;
  }
}

export class DeferredToolRegistry {
  private _allTools: AgentTool[] = [];
  private _alwaysInclude: Set<string>;
  private _maxPerTurn: number;
  private _activated = new Set<string>();
  private _getPendingMCPServers: () => string[];
  private _modelId?: string;

  constructor(config: DeferredToolsConfig = {}) {
    this._alwaysInclude = new Set(config.alwaysInclude ?? []);
    this._maxPerTurn = config.maxToolsPerTurn ?? Infinity;
    this._getPendingMCPServers = config.getPendingMCPServers ?? (() => []);
    this._modelId = config.modelId;

    // Configure module-level neverDeferToolNames from config
    if (config.neverDeferToolNames && config.neverDeferToolNames.length > 0) {
      configureNeverDeferToolNames(config.neverDeferToolNames);
    }
  }

  setModelId(modelId: string): void {
    this._modelId = modelId;
  }

  setTools(tools: AgentTool[]): void {
    this._allTools = tools;
  }

  /**
   * Split tools into active (full schema sent) and deferred (name-only).
   */
  partition(): { activeTools: AgentTool[]; deferredNames: string[] } {
    if (!modelSupportsToolReference(this._modelId ?? "")) {
      return { activeTools: [...this._allTools], deferredNames: [] };
    }

    const mode = getToolSearchMode();
    if (mode === "standard") {
      return { activeTools: [...this._allTools], deferredNames: [] };
    }

    const active: AgentTool[] = [];
    const deferred: string[] = [];

    for (const tool of this._allTools) {
      if (tool.name === TOOL_SEARCH_TOOL_NAME) {
        active.push(tool);
        continue;
      }

      if (this._activated.has(tool.name)) {
        active.push(tool);
        continue;
      }

      if (this._alwaysInclude.has(tool.name)) {
        active.push(tool);
        continue;
      }

      if (isDeferredTool(tool)) {
        deferred.push(tool.name);
        continue;
      }

      if (active.length < this._maxPerTurn) {
        active.push(tool);
      } else {
        deferred.push(tool.name);
      }
    }

    if (deferred.length > 0 && !active.some((t) => t.name === TOOL_SEARCH_TOOL_NAME)) {
      active.push(ToolSearchTool as unknown as AgentTool);
    }

    return { activeTools: active, deferredNames: deferred };
  }

  activate(name: string): AgentTool | undefined {
    const tool = this._allTools.find((t) => t.name === name);
    if (tool) this._activated.add(name);
    return tool;
  }

  getActivatedNames(): ReadonlySet<string> {
    return this._activated;
  }

  formatDeferredSection(names: string[]): string {
    if (names.length === 0) return "";
    return (
      "The following deferred tools are now available via ToolSearch:\n" +
      names.join("\n")
    );
  }

  getDeferredToolsDelta(
    messages: ReadonlyArray<{
      role?: string;
      content?: unknown;
      type?: string;
      subtype?: string;
      attachment?: any;
    }>,
  ): DeferredToolsDelta | null {
    return getDeferredToolsDelta(this._allTools, messages);
  }

  formatDeferredDelta(delta: DeferredToolsDelta): string {
    const parts: string[] = [];
    if (delta.addedNames.length > 0) {
      parts.push("New deferred tools available via ToolSearch:\n" + delta.addedLines.join("\n"));
    }
    if (delta.removedNames.length > 0) {
      parts.push("Deferred tools no longer available:\n" + delta.removedNames.join("\n"));
    }
    return parts.join("\n\n");
  }

  invalidateDescriptionCache(): void {
    clearToolSearchDescriptionCache();
  }
}
