// History normalizer — merge adjacent user messages

import type { AgentMessage, Message } from "../types.js";

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
      const prevText = typeof prevMsg.content === "string"
        ? prevMsg.content
        : prevMsg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const currentText = typeof current.content === "string"
        ? current.content
        : current.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");

      result[result.length - 1] = {
        role: "user",
        content: prevText + "\n" + currentText,
      };
      continue;
    }

    result.push(msg);
  }

  return result;
}
