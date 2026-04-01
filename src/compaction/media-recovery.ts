// Media size recovery — detect and recover from oversized image/PDF errors.
//   - isMediaSizeError() detects API error patterns for oversized media
//   - isMediaSizeErrorMessage() checks assistant messages for media errors
//   - stripImagesFromMessages() removes image/document blocks and replaces with text markers
//   - Used by the agent loop to withhold media errors and retry with stripped media

import type { AssistantMessage, Message } from "../llm/types.js";

/**
 * Detect media size errors from API error text.
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes("image exceeds") && raw.includes("maximum")) ||
    (raw.includes("image dimensions exceed") && raw.includes("many-image")) ||
    /maximum of \d+ PDF pages/.test(raw)
  );
}

/**
 * Check if an assistant message is a media size error.
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage | undefined): msg is AssistantMessage {
  if (!msg) return false;
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails)
  );
}

/**
 * Check if a message should be withheld for media size recovery.
 */
export function isWithheldMediaSizeError(msg: AssistantMessage | undefined): msg is AssistantMessage {
  return isMediaSizeErrorMessage(msg);
}

/**
 * Strip image and document blocks from messages, replacing them with text markers.
 * Used by the reactive compact strip-retry path for media size recovery.
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const stripped = msg.content.map((block) => {
        if (block.type === "image") {
          return { type: "text" as const, text: "[image]" };
        }
        return block;
      });
      return { ...msg, content: stripped };
    }
    if (msg.role === "tool_result" && Array.isArray(msg.content)) {
      const stripped = msg.content.map((block) => {
        if (block.type === "image") {
          return { type: "text" as const, text: "[image]" };
        }
        return block;
      });
      return { ...msg, content: stripped };
    }
    return msg;
  });
}
