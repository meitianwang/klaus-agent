// Compaction logic — token estimation, cut point detection, shouldCompact

import type { AgentMessage, Message } from "../types.js";
import type { ToolResultBlock } from "../llm/types.js";
import type { CutPointResult } from "./types.js";
import { isToolResultMessage, getToolResultBlocks, getToolUseId, createToolResultMessage } from "../utils/messages.js";

/**
 * Estimate token count for a string using a mixed heuristic:
 * ASCII chars average ~4 chars/token, non-ASCII (CJK, etc.) ~1.5 chars/token.
 * This is significantly more accurate than a flat chars/4 for multilingual content.
 */
function estimateStringTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) {
      asciiChars++;
    } else {
      nonAsciiChars++;
    }
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

export function estimateTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

function estimateMessageTokens(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object" || !("role" in msg)) return 0;
  const m = msg as Message;

  if (m.role === "user") {
    if (typeof m.content === "string") return estimateStringTokens(m.content);
    return m.content.reduce((sum, block) => {
      if (block.type === "text") return sum + estimateStringTokens(block.text);
      if (block.type === "tool_result") {
        const trb = block as ToolResultBlock;
        if (typeof trb.content === "string") return sum + estimateStringTokens(trb.content);
        return sum + trb.content.reduce((s, inner) => {
          if (inner.type === "text") return s + estimateStringTokens(inner.text);
          return s + 1000;
        }, 0);
      }
      return sum + 1000; // image estimate
    }, 0);
  }

  if (m.role === "assistant") {
    return m.content.reduce((sum, block) => {
      if (block.type === "text") return sum + estimateStringTokens(block.text);
      if (block.type === "thinking") return sum + estimateStringTokens(block.thinking);
      if (block.type === "tool_use") return sum + estimateStringTokens(JSON.stringify(block.input)) + 20;
      return sum;
    }, 0);
  }

  return 0;
}

export function shouldCompact(
  contextTokens: number,
  maxContextTokens: number,
  reserveTokens: number,
): boolean {
  return contextTokens > maxContextTokens - reserveTokens;
}

export function findCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
): CutPointResult {
  if (messages.length === 0) {
    return { firstKeptIndex: 0, isSplitTurn: false };
  }

  // Walk backwards, accumulating tokens until we reach keepRecentTokens
  let accumulated = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    accumulated += tokens;

    if (accumulated >= keepRecentTokens) {
      cutIndex = i + 1;
      break;
    }
  }

  // If all messages fit within keepRecentTokens, nothing can be discarded.
  // Return firstKeptIndex: 0 so callers know there's nothing to cut —
  // this prevents infinite compaction loops when context exceeds max but
  // all messages fall within the keep window.
  if (cutIndex >= messages.length) {
    return { firstKeptIndex: 0, isSplitTurn: false };
  }

  // Ensure we don't cut at a tool_result (must follow its tool_use)
  while (cutIndex < messages.length) {
    const msg = messages[cutIndex];
    if (msg && typeof msg === "object" && "role" in msg && isToolResultMessage(msg as Message)) {
      cutIndex++;
    } else {
      break;
    }
  }

  // After adjusting for tool_results, check if we've pushed past all messages
  if (cutIndex >= messages.length || cutIndex <= 1) {
    return { firstKeptIndex: 0, isSplitTurn: false };
  }

  const isSplitTurn = cutIndex > 0 && cutIndex < messages.length &&
    messages[cutIndex - 1] && typeof messages[cutIndex - 1] === "object" &&
    "role" in messages[cutIndex - 1]! && (messages[cutIndex - 1] as Message).role === "assistant";

  return { firstKeptIndex: cutIndex, isSplitTurn };
}

/** Replace old tool_result content with `[Previous: used {toolName}]`, keeping the most recent N intact. */
export function microCompact(messages: Message[], keepRecent: number): Message[] {
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isToolResultMessage(messages[i])) {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= keepRecent) return messages;

  // Build toolUseId → toolName map in one pass
  const toolCallNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const b of msg.content) {
        if (b.type === "tool_use") {
          toolCallNames.set(b.id, b.name);
        }
      }
    }
  }

  const toReplace = toolResultIndices.slice(0, -keepRecent);
  const result = [...messages];

  for (const idx of toReplace) {
    const msg = result[idx];
    const toolUseId = getToolUseId(msg)!;
    const toolName = toolCallNames.get(toolUseId) ?? "tool";

    result[idx] = createToolResultMessage(toolUseId, `[Previous: used ${toolName}]`);
  }

  return result;
}

