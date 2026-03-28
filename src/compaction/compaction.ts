// Compaction logic — token estimation, cut point detection, shouldCompact

import type { AgentMessage, Message, ToolResultMessage, ToolCallBlock } from "../types.js";
import type { CutPointResult } from "./types.js";

const CHARS_PER_TOKEN = 4;

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
    if (typeof m.content === "string") return Math.ceil(m.content.length / CHARS_PER_TOKEN);
    return m.content.reduce((sum, block) => {
      if (block.type === "text") return sum + Math.ceil(block.text.length / CHARS_PER_TOKEN);
      return sum + 1000; // image estimate
    }, 0);
  }

  if (m.role === "assistant") {
    return m.content.reduce((sum, block) => {
      if (block.type === "text") return sum + Math.ceil(block.text.length / CHARS_PER_TOKEN);
      if (block.type === "thinking") return sum + Math.ceil(block.thinking.length / CHARS_PER_TOKEN);
      if (block.type === "tool_call") return sum + Math.ceil(JSON.stringify(block.input).length / CHARS_PER_TOKEN) + 20;
      return sum;
    }, 0);
  }

  if (m.role === "tool_result") {
    if (typeof m.content === "string") return Math.ceil(m.content.length / CHARS_PER_TOKEN);
    return m.content.reduce((sum, block) => {
      if (block.type === "text") return sum + Math.ceil(block.text.length / CHARS_PER_TOKEN);
      return sum + 1000;
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

  // Ensure we don't cut at a tool_result (must follow its tool_call)
  while (cutIndex < messages.length) {
    const msg = messages[cutIndex];
    if (msg && typeof msg === "object" && "role" in msg && (msg as Message).role === "tool_result") {
      cutIndex++;
    } else {
      break;
    }
  }

  // Don't cut if nothing to discard
  if (cutIndex <= 1) {
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
    if (messages[i].role === "tool_result") {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= keepRecent) return messages;

  const toReplace = toolResultIndices.slice(0, -keepRecent);
  const result = [...messages];

  for (const idx of toReplace) {
    const msg = result[idx] as ToolResultMessage;

    let toolName = "tool";
    for (let j = idx - 1; j >= 0; j--) {
      const prev = result[j];
      if (prev.role === "assistant") {
        const call = prev.content.find(
          (b): b is ToolCallBlock => b.type === "tool_call" && b.id === msg.toolCallId,
        );
        if (call) {
          toolName = call.name;
          break;
        }
      }
    }

    result[idx] = {
      role: "tool_result",
      toolCallId: msg.toolCallId,
      content: `[Previous: used ${toolName}]`,
      ...(msg.isError && { isError: msg.isError }),
    };
  }

  return result;
}

