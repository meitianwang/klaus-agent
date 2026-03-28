// History normalizer — merge adjacent user messages

import type { AgentMessage, Message, ContentBlock } from "../types.js";

export function normalizeHistory(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= 1) return messages;

  const result: AgentMessage[] = [];

  for (const msg of messages) {
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

      const merged: ContentBlock[] = [...prevBlocks, ...currentBlocks];

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

  return result;
}
