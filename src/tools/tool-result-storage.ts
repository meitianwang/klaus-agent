// Tool result storage — persist large tool results to disk instead of truncating.
//
// Aligned with claude-code's toolResultStorage.ts:
// - Large tool results are written to a session-specific directory
// - The model receives a preview with the file path instead of the full content
// - Per-message aggregate budget enforcement ensures context doesn't explode
// - State is tracked by tool_use_id for prompt cache stability

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { TextContent, ImageContent, ContentBlock, Message, ToolResultBlock } from "../llm/types.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "./types.js";
import { isToolResultMessage, getToolResultBlocks } from "../utils/messages.js";

// --- Constants ---

/** Subdirectory name for tool results within a session directory. */
export const TOOL_RESULTS_SUBDIR = "tool-results";

/** XML tag used to wrap persisted output messages. */
export const PERSISTED_OUTPUT_TAG = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSING_TAG = "</persisted-output>";

/** Message used when tool result content was cleared without persisting to file. */
export const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";

/** Preview size in bytes for the reference message. */
export const PREVIEW_SIZE_BYTES = 2000;

/** Approximate bytes per token for budget estimation. */
export const BYTES_PER_TOKEN = 4;

/**
 * Maximum size for tool results in tokens.
 * Aligned with claude-code: 100k tokens ≈ 400KB of text.
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000;

/** Global max bytes for a single tool result (derived from token limit). */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN;

/**
 * Per-message aggregate budget for tool results.
 * Prevents N parallel tools from collectively producing too much in one turn.
 * Aligned with claude-code: 200k chars.
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

// --- Types ---

export type PersistedToolResult = {
  filepath: string;
  originalSize: number;
  isJson: boolean;
  preview: string;
  hasMore: boolean;
};

export type PersistToolResultError = {
  error: string;
};

/**
 * Per-conversation-thread state for the aggregate tool result budget.
 * State must be stable to preserve prompt cache:
 *   - seenIds: results that have passed through the budget check
 *   - replacements: subset of seenIds that were persisted to disk
 */
export type ContentReplacementState = {
  seenIds: Set<string>;
  replacements: Map<string, string>;
};

export type ContentReplacementRecord = {
  kind: "tool-result";
  toolUseId: string;
  replacement: string;
};

export type ToolResultReplacementRecord = Extract<
  ContentReplacementRecord,
  { kind: "tool-result" }
>;

/** Minimal analytics interface for tool result storage. */
export type ToolResultAnalytics = {
  logEvent(name: string, metadata: Record<string, unknown>): void;
};

// --- Helpers ---

/**
 * Safe JSON serialization that handles circular references and large objects.
 * Aligned with claude-code's jsonStringify from utils/slowOperations.
 */
function jsonStringify(value: unknown, _replacer?: null, space?: number): string {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (_key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      });
    } catch {
      return String(value);
    }
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code: string }).code;
  }
  return undefined;
}

/**
 * Map errno codes to human-readable messages.
 * Aligned with claude-code's getFileSystemErrorMessage.
 */
export function getFileSystemErrorMessage(error: unknown): string {
  const code = getErrnoCode(error);
  if (!code) return error instanceof Error ? error.message : String(error);
  const path = (error as any).path ? `: ${(error as any).path}` : "";
  switch (code) {
    case "ENOENT": return `File or directory not found${path}`;
    case "EACCES": return `Permission denied${path}`;
    case "EPERM": return `Operation not permitted${path}`;
    case "ENOSPC": return "No space left on device";
    case "EMFILE": return "Too many open files";
    case "ENFILE": return "File table overflow";
    case "EISDIR": return `Is a directory${path}`;
    case "ENOTDIR": return `Not a directory${path}`;
    case "EEXIST": return `File already exists${path}`;
    case "ENOTEMPTY": return `Directory not empty${path}`;
    case "EROFS": return "Read-only file system";
    default: return `${code}: ${(error as any).message ?? "unknown error"}`;
  }
}

// --- Session directory ---

let _sessionDir: string | undefined;
let _toolResultsDir: string | undefined;

/**
 * Configure the session directory for tool result storage.
 * Must be called before any tool results are persisted.
 */
export function configureToolResultStorage(sessionDir: string): void {
  _sessionDir = sessionDir;
  _toolResultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR);
}

function getToolResultsDir(): string {
  if (!_toolResultsDir) {
    throw new Error(
      "Tool result storage not configured. Call configureToolResultStorage() first.",
    );
  }
  return _toolResultsDir;
}

export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? "json" : "txt";
  return join(getToolResultsDir(), `${id}.${ext}`);
}

async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true });
  } catch {
    // Directory may already exist
  }
}

// --- Persistence threshold ---

/**
 * Per-tool threshold overrides.
 * Aligned with claude-code's GrowthBook tengu_satin_quoll override —
 * in klaus-agent this is configured programmatically instead.
 */
let _perToolThresholdOverrides: Record<string, number> | null = null;

/**
 * Configure per-tool persistence threshold overrides.
 * Aligned with claude-code's GrowthBook-based override mechanism.
 */
export function configurePerToolThresholdOverrides(
  overrides: Record<string, number> | null,
): void {
  _perToolThresholdOverrides = overrides;
}

/**
 * Resolve the effective persistence threshold for a tool.
 * Aligned with claude-code: checks per-tool overrides, then declared max,
 * then global default.
 */
export function getPersistenceThreshold(
  toolName: string,
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = hard opt-out (e.g. Read tool).
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars;
  }

  // Per-tool override (aligned with claude-code's GrowthBook override)
  if (_perToolThresholdOverrides && typeof _perToolThresholdOverrides === "object") {
    const override = _perToolThresholdOverrides[toolName];
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      return override;
    }
  }

  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS);
}

// --- Persist tool result to disk ---

export async function persistToolResult(
  content: string | ContentBlock[],
  toolUseId: string,
  logForDebugging?: (message: string) => void,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content);

  // Check for non-text content
  if (isJson) {
    const hasNonTextContent = content.some(
      (block) => block.type !== "text",
    );
    if (hasNonTextContent) {
      return { error: "Cannot persist tool results containing non-text content" };
    }
  }

  await ensureToolResultsDir();
  const filePath = getToolResultPath(toolUseId, isJson);
  const contentStr = isJson ? jsonStringify(content, null, 2) : content;
  const contentBytes = contentStr.length;

  // tool_use_id is unique per invocation — skip if file already exists.
  try {
    await writeFile(filePath, contentStr, { encoding: "utf-8", flag: "wx" });
    logForDebugging?.(`Persisted tool result for ${toolUseId} (${contentBytes} bytes) to ${filePath}`);
  } catch (error) {
    if (getErrnoCode(error) !== "EEXIST") {
      return { error: getFileSystemErrorMessage(error) };
    }
    // EEXIST: already persisted on a prior turn
  }

  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES);

  return {
    filepath: filePath,
    originalSize: contentBytes,
    isJson,
    preview,
    hasMore,
  };
}

/**
 * Build a message for large tool results with preview.
 */
export function buildLargeToolResultMessage(
  result: PersistedToolResult,
): string {
  let message = `${PERSISTED_OUTPUT_TAG}\n`;
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`;
  message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`;
  message += result.preview;
  message += result.hasMore ? "\n...\n" : "\n";
  message += PERSISTED_OUTPUT_CLOSING_TAG;
  return message;
}

/**
 * Generate a preview of content, truncating at a newline boundary when possible.
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false };
  }

  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;

  return { preview: content.slice(0, cutPoint), hasMore: true };
}

export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return "error" in result;
}

// --- Empty content detection ---

export function isToolResultContentEmpty(
  content: string | ContentBlock[] | undefined,
): boolean {
  if (!content) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every(
    (block) =>
      block.type === "text" &&
      (typeof (block as TextContent).text !== "string" || (block as TextContent).text.trim() === ""),
  );
}

// --- Maybe persist large tool result ---

function hasImageBlock(content: string | ContentBlock[]): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => b.type === "image")
  );
}

function contentSize(content: string | ContentBlock[]): number {
  if (typeof content === "string") return content.length;
  return content.reduce(
    (sum, b) => sum + (b.type === "text" ? (b as TextContent).text.length : 0),
    0,
  );
}

function isContentAlreadyCompacted(content: string | ContentBlock[]): boolean {
  return typeof content === "string" && content.startsWith(PERSISTED_OUTPUT_TAG);
}

/**
 * Handle large tool results by persisting to disk instead of truncating.
 * Aligned with claude-code: accepts a ToolResultBlockParam and returns a
 * modified ToolResultBlockParam with content replaced by a file reference.
 * Returns the original block if no persistence needed.
 */
async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold?: number,
  analytics?: ToolResultAnalytics,
  logForDebugging?: (message: string) => void,
): Promise<ToolResultBlockParam> {
  const content = toolResultBlock.content;

  // Empty content — inject a marker
  if (isToolResultContentEmpty(content)) {
    analytics?.logEvent("tengu_tool_empty_result", { toolName });
    return {
      ...toolResultBlock,
      content: `(${toolName} completed with no output)`,
    };
  }

  // Skip persistence for image content blocks
  if (hasImageBlock(content)) {
    return toolResultBlock;
  }

  const size = contentSize(content);
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES;

  if (size <= threshold) {
    return toolResultBlock;
  }

  const result = await persistToolResult(content, toolResultBlock.tool_use_id, logForDebugging);
  if (isPersistError(result)) {
    return toolResultBlock; // Fall back to original
  }

  const message = buildLargeToolResultMessage(result);

  analytics?.logEvent("tengu_tool_result_persisted", {
    toolName,
    originalSizeBytes: result.originalSize,
    persistedSizeBytes: message.length,
    estimatedOriginalTokens: Math.ceil(result.originalSize / BYTES_PER_TOKEN),
    estimatedPersistedTokens: Math.ceil(message.length / BYTES_PER_TOKEN),
    thresholdUsed: threshold,
  });

  return { ...toolResultBlock, content: message };
}

// --- Tool result block processing helpers ---
// Aligned with claude-code's processToolResultBlock / processPreMappedToolResultBlock

// Import and re-export ToolResultBlockParam from the canonical types location
import type { ToolResultBlockParam } from "./types.js";
export type { ToolResultBlockParam };

/**
 * Process a tool result for inclusion in a message.
 * Maps the result using tool.mapToolResultToToolResultBlockParam (if available),
 * then applies large-result persistence.
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string;
    maxResultSizeChars: number;
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam;
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(toolUseResult, toolUseID);

  return maybePersistLargeToolResult(
    toolResultBlock,
    tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars),
  );
}

/**
 * Process a pre-mapped tool result block. Applies persistence for large results
 * without re-calling mapToolResultToToolResultBlockParam.
 * Delegates to maybePersistLargeToolResult — aligned with claude-code.
 */
export async function processPreMappedToolResultBlock(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
): Promise<ToolResultBlockParam> {
  return maybePersistLargeToolResult(
    toolResultBlock,
    toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars),
  );
}

// --- Content replacement state ---

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}

export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  };
}

// --- Per-message aggregate budget enforcement ---

type ToolResultCandidate = {
  toolUseId: string;
  content: string | ContentBlock[];
  size: number;
};

type CandidatePartition = {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>;
  frozen: ToolResultCandidate[];
  fresh: ToolResultCandidate[];
};

/**
 * Walk messages and build tool_use_id → tool_name from assistant tool_use
 * blocks. tool_use always precedes its tool_result (model calls, then result
 * arrives), so by the time budget enforcement sees a result, its name is known.
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * Extract candidate tool_result blocks from a single message: blocks
 * that are non-empty, non-image, and not already compacted by tag.
 * Returns [] for messages with no eligible blocks.
 */
function collectCandidatesFromMessage(message: Message): ToolResultCandidate[] {
  if (!isToolResultMessage(message)) return [];
  const candidates: ToolResultCandidate[] = [];
  for (const block of getToolResultBlocks(message)) {
    const content = block.content;
    if (!content) continue;
    if (isContentAlreadyCompacted(content)) continue;
    if (hasImageBlock(content)) continue;
    candidates.push({
      toolUseId: block.tool_use_id,
      content,
      size: contentSize(content),
    });
  }
  return candidates;
}

/**
 * Collect candidates grouped by API-level user message.
 *
 * normalizeMessagesForAPI merges consecutive user messages into one
 * (Bedrock compat; 1P does the same server-side), so parallel tool
 * results that arrive as N separate user messages in our state become
 * ONE user message on the wire. The budget must group the same way or
 * it would see N under-budget messages instead of one over-budget
 * message and fail to enforce exactly when it matters most.
 *
 * A "group" is a maximal run of user/tool_result messages NOT separated
 * by a *new* assistant message. Only a previously-unseen assistant
 * message ID creates a wire-level boundary (flush). Progress/system
 * messages do NOT break groups.
 *
 * Streaming tool execution can yield one assistant message per
 * content_block_stop (same id); a fast tool drains between blocks;
 * abort/hook-stop leaves [asst(X), tool_result(A), asst(X), tool_result(B)].
 * normalizeMessagesForAPI merges the X fragments into one wire assistant,
 * and their following tool_results merge into one wire user message —
 * so the budget must see them as one group too.
 */
function collectCandidatesByMessage(messages: Message[]): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = [];
  let current: ToolResultCandidate[] = [];

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  // Track all assistant message IDs seen so far. Same-ID fragments
  // must NOT create a group boundary — they are merged on the wire.
  const seenAsstIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isToolResultMessage(msg)) {
      current.push(...collectCandidatesFromMessage(msg));
    } else if (msg.role === "assistant") {
      // Only flush on a NEW assistant message ID. Re-appearances of
      // a previously-seen ID (streaming fragments) are not boundaries.
      const asstId = getAssistantMessageId(msg, i);
      if (!seenAsstIds.has(asstId)) {
        flush();
        seenAsstIds.add(asstId);
      }
    }
    // progress / system / other messages do NOT create wire boundaries.
  }
  flush();

  return groups;
}

/**
 * Extract a stable ID from an assistant message. Falls back to a
 * deterministic index-based ID if the message has no `id` field,
 * so flush() still triggers per-message boundaries.
 */
function getAssistantMessageId(msg: Message, index: number): string {
  // AssistantMessage may carry an `id` field from the provider.
  if (msg.role === "assistant" && "id" in msg && typeof msg.id === "string") {
    return msg.id;
  }
  return `__assistant_idx_${index}`;
}

function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ContentReplacementState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (acc, c) => {
      const replacement = state.replacements.get(c.toolUseId);
      if (replacement !== undefined) {
        acc.mustReapply.push({ ...c, replacement });
      } else if (state.seenIds.has(c.toolUseId)) {
        acc.frozen.push(c);
      } else {
        acc.fresh.push(c);
      }
      return acc;
    },
    { mustReapply: [], frozen: [], fresh: [] },
  );
}

/**
 * Pick the largest fresh results to replace until the model-visible total
 * is at or under budget.
 */
function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size);
  const selected: ToolResultCandidate[] = [];
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0);
  for (const c of sorted) {
    if (remaining <= limit) break;
    selected.push(c);
    remaining -= c.size;
  }
  return selected;
}

async function buildReplacement(
  candidate: ToolResultCandidate,
): Promise<{ content: string; originalSize: number } | null> {
  const result = await persistToolResult(candidate.content, candidate.toolUseId);
  if (isPersistError(result)) return null;
  return {
    content: buildLargeToolResultMessage(result),
    originalSize: result.originalSize,
  };
}

/**
 * Replace tool_result content in messages by toolUseId.
 */
function replaceToolResultContents(
  messages: Message[],
  replacementMap: Map<string, string>,
): Message[] {
  return messages.map((msg) => {
    if (!isToolResultMessage(msg)) return msg;
    let changed = false;
    const newContent = (msg.content as (ContentBlock | ToolResultBlock)[]).map((block) => {
      if (block.type === "tool_result") {
        const trb = block as ToolResultBlock;
        const replacement = replacementMap.get(trb.tool_use_id);
        if (replacement !== undefined) {
          changed = true;
          return { ...trb, content: replacement };
        }
      }
      return block;
    });
    return changed ? { ...msg, content: newContent } : msg;
  });
}

/**
 * Enforce the per-message budget on aggregate tool result size.
 *
 * For each group of tool_result messages (between assistant messages), if the
 * combined content exceeds the per-message limit, the largest FRESH results
 * are persisted to disk and replaced with previews.
 *
 * State is tracked by tool_use_id. Once a result's fate is decided, it's frozen.
 *
 * @param state — MUTATED: seenIds and replacements updated in place.
 */
export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames: ReadonlySet<string> = new Set(),
  logForDebugging?: (message: string) => void,
): Promise<{
  messages: Message[];
  newlyReplaced: ToolResultReplacementRecord[];
}> {
  const candidatesByMessage = collectCandidatesByMessage(messages);
  const nameByToolUseId =
    skipToolNames.size > 0 ? buildToolNameMap(messages) : undefined;
  const shouldSkip = (id: string): boolean =>
    nameByToolUseId !== undefined &&
    skipToolNames.has(nameByToolUseId.get(id) ?? "");

  const limit = getPerMessageBudgetLimit();
  const replacementMap = new Map<string, string>();
  const toPersist: ToolResultCandidate[] = [];
  let reappliedCount = 0;
  let messagesOverBudget = 0;

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      candidates,
      state,
    );

    // Re-apply cached replacements
    mustReapply.forEach((c) => replacementMap.set(c.toolUseId, c.replacement));
    reappliedCount += mustReapply.length;

    if (fresh.length === 0) {
      candidates.forEach((c) => state.seenIds.add(c.toolUseId));
      continue;
    }

    // Skip tools with Infinity maxResultSizeChars
    const skipped = fresh.filter((c) => shouldSkip(c.toolUseId));
    skipped.forEach((c) => state.seenIds.add(c.toolUseId));
    const eligible = fresh.filter((c) => !shouldSkip(c.toolUseId));

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0);
    const freshSize = eligible.reduce((sum, c) => sum + c.size, 0);

    const selected =
      frozenSize + freshSize > limit
        ? selectFreshToReplace(eligible, frozenSize, limit)
        : [];

    // Mark non-persisting candidates as seen NOW
    const selectedIds = new Set(selected.map((c) => c.toolUseId));
    candidates
      .filter((c) => !selectedIds.has(c.toolUseId))
      .forEach((c) => state.seenIds.add(c.toolUseId));

    if (selected.length === 0) continue;
    messagesOverBudget++;
    toPersist.push(...selected);
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, newlyReplaced: [] };
  }

  // Concurrent persist for all selected candidates
  const freshReplacements = await Promise.all(
    toPersist.map(async (c) => [c, await buildReplacement(c)] as const),
  );
  const newlyReplaced: ToolResultReplacementRecord[] = [];
  let replacedSize = 0;
  for (const [candidate, replacement] of freshReplacements) {
    state.seenIds.add(candidate.toolUseId);
    if (replacement === null) continue;
    replacedSize += candidate.size;
    replacementMap.set(candidate.toolUseId, replacement.content);
    state.replacements.set(candidate.toolUseId, replacement.content);
    newlyReplaced.push({
      kind: "tool-result",
      toolUseId: candidate.toolUseId,
      replacement: replacement.content,
    });
  }

  if (replacementMap.size === 0) {
    return { messages, newlyReplaced: [] };
  }

  if (newlyReplaced.length > 0) {
    logForDebugging?.(
      `Per-message budget: persisted ${newlyReplaced.length} tool results ` +
        `across ${messagesOverBudget} over-budget message(s), ` +
        `shed ~${formatFileSize(replacedSize)}, ${reappliedCount} re-applied`,
    );
  }

  return {
    messages: replaceToolResultContents(messages, replacementMap),
    newlyReplaced,
  };
}

/**
 * Query-loop integration point for the aggregate budget.
 */
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages;
  const result = await enforceToolResultBudget(messages, state, skipToolNames);
  if (result.newlyReplaced.length > 0) {
    writeToTranscript?.(result.newlyReplaced);
  }
  return result.messages;
}

/**
 * Reconstruct replacement state from content-replacement records.
 * Used on resume for prompt cache stability.
 * Aligned with claude-code: accepts optional inheritedReplacements for
 * fork-subagent resume gap-filling.
 */
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState();
  const candidateIds = new Set(
    collectCandidatesByMessage(messages)
      .flat()
      .map((c) => c.toolUseId),
  );

  for (const id of candidateIds) {
    state.seenIds.add(id);
  }
  for (const r of records) {
    if (r.kind === "tool-result" && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement);
    }
  }
  // Aligned with claude-code: merge inherited replacements from parent agent
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement);
      }
    }
  }
  return state;
}

/**
 * Reconstruct content replacement state for subagent resume.
 * Wraps reconstructContentReplacementState with parent gap-fill logic.
 * Aligned with claude-code's reconstructForSubagentResume.
 *
 * Returns undefined when parentState is undefined (feature off).
 */
export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  messages: Message[],
  records: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined;
  return reconstructContentReplacementState(messages, records, parentState.replacements);
}

/**
 * Provision a ContentReplacementState — either reconstruct from records
 * or create fresh.
 * Aligned with claude-code's provisionContentReplacementState.
 *
 * @param enabled - Whether the budget feature is enabled
 * @param messages - Current message history
 * @param records - Existing content replacement records (for resume)
 */
export function provisionContentReplacementState(
  enabled: boolean,
  messages?: Message[],
  records?: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!enabled) return undefined;
  if (messages) {
    return reconstructContentReplacementState(messages, records ?? []);
  }
  return createContentReplacementState();
}

/**
 * Per-message budget limit configuration.
 * Aligned with claude-code's GrowthBook tengu_hawthorn_window override.
 */
let _perMessageBudgetLimit: number = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS;

/**
 * Configure the per-message budget limit.
 */
export function configurePerMessageBudgetLimit(limit: number): void {
  _perMessageBudgetLimit = limit;
}

/**
 * Get the current per-message budget limit.
 * Aligned with claude-code's getPerMessageBudgetLimit.
 */
export function getPerMessageBudgetLimit(): number {
  return _perMessageBudgetLimit;
}
