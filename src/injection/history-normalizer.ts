// History normalizer — merge adjacent user messages, validate message ordering

import type { AgentMessage, Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types.js";
import { isToolResultMessage, getToolUseId } from "../utils/messages.js";

export function normalizeHistory(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) return messages;

  // Phase 1: Filter out empty/invalid messages
  const filtered: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !("role" in msg)) continue;
    const m = msg as Message;
    // Remove empty messages
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content.length === 0) continue;
      if (Array.isArray(m.content) && m.content.length === 0) continue;
    }
    if (m.role === "assistant" && m.content.length === 0) continue;
    filtered.push(msg);
  }

  if (filtered.length === 0) return filtered;

  // Phase 2: Validate tool_result messages have matching tool_use IDs.
  // Build a set of valid tool_use IDs from assistant messages.
  const validToolCallIds = new Set<string>();
  for (const msg of filtered) {
    if (typeof msg === "object" && "role" in msg && (msg as Message).role === "assistant") {
      const assistantMsg = msg as Message & { role: "assistant" };
      for (const block of assistantMsg.content) {
        if ((block as ToolUseBlock).type === "tool_use") {
          validToolCallIds.add((block as ToolUseBlock).id);
        }
      }
    }
  }

  // Remove orphaned tool_result messages (no matching tool_use).
  // Only check after the first assistant message — tool_results before any
  // assistant message may be leftovers from compaction where the original
  // assistant message was discarded.
  const validated: AgentMessage[] = [];
  let seenAssistant = false;
  for (const msg of filtered) {
    if (typeof msg === "object" && "role" in msg) {
      const m = msg as Message;
      if (m.role === "assistant") seenAssistant = true;
      if (seenAssistant && isToolResultMessage(m) && !validToolCallIds.has(getToolUseId(m)!)) {
        continue; // orphaned tool_result — skip
      }
    }
    validated.push(msg);
  }

  // Phase 3: Merge adjacent user messages
  const result: AgentMessage[] = [];
  for (const msg of validated) {
    if (!msg || typeof msg !== "object" || !("role" in msg)) {
      result.push(msg);
      continue;
    }

    const current = msg as Message;
    const prev = result.length > 0 ? result[result.length - 1] : null;

    // Merge adjacent user messages
    if (
      current.role === "user" &&
      prev && typeof prev === "object" && "role" in prev &&
      (prev as Message).role === "user"
    ) {
      const prevMsg = prev as Message & { role: "user" };
      const prevBlocks = typeof prevMsg.content === "string"
        ? [{ type: "text" as const, text: prevMsg.content }]
        : prevMsg.content;
      const currentBlocks = typeof current.content === "string"
        ? [{ type: "text" as const, text: current.content }]
        : current.content;

      const merged: (ContentBlock | ToolResultBlock)[] = [...prevBlocks, ...currentBlocks];

      // Optimize: if all blocks are text, collapse to a single string
      if (merged.every((b) => b.type === "text")) {
        result[result.length - 1] = {
          role: "user",
          content: merged.map((b) => (b as { text: string }).text).join("\n"),
        };
      } else {
        result[result.length - 1] = {
          role: "user",
          content: merged,
        };
      }
      continue;
    }

    result.push(msg);
  }

  // Phase 4: Ensure conversation starts with a user message for API compatibility.
  // If the first message is assistant, prepend an empty context marker.
  if (result.length > 0 && typeof result[0] === "object" && "role" in result[0]) {
    const first = result[0] as Message;
    if (first.role === "assistant" || isToolResultMessage(first)) {
      result.unshift({ role: "user", content: "[continued from previous context]" });
    }
  }

  return result;
}
