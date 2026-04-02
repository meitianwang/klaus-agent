// Message constants — aligned with claude-code's utils/messages.ts
//
// Standard messages used for tool rejection, cancellation, and interruption.
// These must match claude-code exactly so the model sees consistent signals.

import type { Message, UserMessage, ContentBlock, ToolResultBlock } from "../llm/types.js";

export const INTERRUPT_MESSAGE = "[Request interrupted by user]";
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  "[Request interrupted by user for tool use]";
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
export const SUBAGENT_REJECT_MESSAGE =
  "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.";
export const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX =
  "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n";

export const PLAN_REJECTION_PREFIX =
  "The agent proposed a plan that was rejected by the user. The user chose to stay in plan mode rather than proceed with implementation.\n\nRejected plan:\n";

/**
 * Shared guidance for permission denials, instructing the model on appropriate workarounds.
 * Exported to match claude-code.
 */
export const DENIAL_WORKAROUND_GUIDANCE =
  "IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, " +
  "e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, " +
  "e.g. do not use your ability to run tests to execute non-test actions. " +
  "You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. " +
  "If you believe this capability is essential to complete the user's request, STOP and explain to the user " +
  "what you were trying to do and why you need this permission. Let the user decide how to proceed.";

export function AUTO_REJECT_MESSAGE(toolName: string): string {
  return `Permission to use ${toolName} has been denied. ${DENIAL_WORKAROUND_GUIDANCE}`;
}
export function DONT_ASK_REJECT_MESSAGE(toolName: string): string {
  return `Permission to use ${toolName} has been denied because Claude Code is running in don't ask mode. ${DENIAL_WORKAROUND_GUIDANCE}`;
}
export const NO_RESPONSE_REQUESTED = "No response requested.";

// Synthetic tool_result content inserted when a tool_use block has no matching tool_result.
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  "[Tool result missing due to internal error]";

// Placeholder content inserted when stripping orphaned tool_results empties a user message.
// Aligned with claude-code's NO_CONTENT_MESSAGE from constants/messages.ts.
export const NO_CONTENT_MESSAGE = "(no content)";

// Prefix used by UI to detect classifier denials and render them concisely.
// Aligned with claude-code's AUTO_MODE_REJECTION_PREFIX.
const AUTO_MODE_REJECTION_PREFIX =
  "Permission for this action has been denied. Reason: ";

/**
 * Check if a tool result message is a classifier denial.
 * Used by the UI to render a short summary instead of the full message.
 * Aligned with claude-code's isClassifierDenial.
 */
export function isClassifierDenial(content: string): boolean {
  return content.startsWith(AUTO_MODE_REJECTION_PREFIX);
}

/**
 * Build a rejection message for auto mode classifier denials.
 * Encourages continuing with other tasks and suggests permission rules.
 * Aligned with claude-code's buildYoloRejectionMessage.
 *
 * @param reason - The classifier's reason for denying the action
 */
export function buildYoloRejectionMessage(reason: string): string {
  const prefix = AUTO_MODE_REJECTION_PREFIX;

  const ruleHint =
    "To allow this type of action in the future, the user can add a permission rule like " +
    "Bash(prompt: <description of allowed action>) to their settings. " +
    "At the end of your session, recommend what permission rules to add so you don't get blocked again.";

  return (
    `${prefix}${reason}. ` +
    `If you have other tasks that don't depend on this action, continue working on those. ` +
    `${DENIAL_WORKAROUND_GUIDANCE} ` +
    ruleHint
  );
}

/**
 * Build a message for when the auto mode classifier is temporarily unavailable.
 * Tells the agent to wait and retry, and suggests working on other tasks.
 * Aligned with claude-code's buildClassifierUnavailableMessage.
 */
export function buildClassifierUnavailableMessage(
  toolName: string,
  classifierModel: string,
): string {
  return (
    `${classifierModel} is temporarily unavailable, so auto mode cannot determine the safety of ${toolName} right now. ` +
    `Wait briefly and then try this action again. ` +
    `If it keeps failing, continue with other tasks that don't require this action and come back to it later. ` +
    `Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.`
  );
}

export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Set of synthetic messages that should be detected and handled specially
 * (e.g., not shown to the user as regular messages).
 */
export const SYNTHETIC_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
]);

/**
 * Check if a message is synthetic (generated by the system, not the model).
 * Aligned with claude-code's isSyntheticMessage.
 */
export function isSyntheticMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return SYNTHETIC_MESSAGES.has(content);
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    if (first && first.type === "text" && SYNTHETIC_MESSAGES.has(first.text)) return true;
  }
  return false;
}

/**
 * Derive a short stable message ID (6-char base36 string) from a UUID.
 * Used for snip tool referencing — injected into API-bound messages as [id:...] tags.
 * Deterministic: same UUID always produces the same short ID.
 * Aligned with claude-code's deriveShortMessageId.
 */
export function deriveShortMessageId(uuid: string): string {
  // Take first 10 hex chars from the UUID (skipping dashes)
  const hex = uuid.replace(/-/g, "").slice(0, 10);
  // Convert to base36 for shorter representation, take 6 chars
  return parseInt(hex, 16).toString(36).slice(0, 6);
}

/**
 * Memory correction hint appended to rejection messages.
 * Aligned with claude-code's MEMORY_CORRECTION_HINT + withMemoryCorrectionHint.
 *
 * In claude-code this is gated by isAutoMemoryEnabled() AND a GrowthBook feature
 * flag (tengu_amber_prism). Since klaus-agent doesn't have GrowthBook, we gate
 * only on the isAutoMemoryEnabled callback (configurable by the host app).
 */
const MEMORY_CORRECTION_HINT =
  "\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";

let _isAutoMemoryEnabled: () => boolean = () => false;

/**
 * Configure whether auto-memory is enabled.
 * Must be called during bootstrap if auto-memory is supported.
 */
export function configureAutoMemory(isEnabled: () => boolean): void {
  _isAutoMemoryEnabled = isEnabled;
}

/**
 * Wraps a rejection/cancellation message with a memory correction hint.
 * Aligned with claude-code: conditionally appends when auto-memory is enabled.
 */
export function withMemoryCorrectionHint(message: string): string {
  if (_isAutoMemoryEnabled()) {
    return message + MEMORY_CORRECTION_HINT;
  }
  return message;
}

/**
 * Wrap error content in tool_use_error XML tags.
 * Aligned with claude-code's error wrapping convention.
 */
export function wrapToolUseError(message: string): string {
  return `<tool_use_error>${message}</tool_use_error>`;
}

// --- Tool result message helpers (aligned with claude-code) ---
// In claude-code, tool results are UserMessage instances with tool_result content blocks.
// These helpers centralize creation and inspection of that pattern.

/**
 * Create a UserMessage containing a single tool_result content block.
 * Aligned with claude-code: tool results are UserMessage, not a separate type.
 */
export function createToolResultMessage(
  toolUseId: string,
  content: string | ContentBlock[],
  isError?: boolean,
  metadata?: {
    sourceToolAssistantId?: string;
    sourceToolAssistantUUID?: string;
    toolUseResult?: string;
    mcpMeta?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> };
    imagePasteIds?: number[];
  },
): UserMessage {
  const toolResultBlock: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  };
  return {
    role: "user",
    content: [toolResultBlock],
    ...metadata,
  };
}

/**
 * Check if a message contains tool_result content blocks.
 * Aligned with claude-code: tool results are UserMessage with tool_result blocks.
 */
export function isToolResultMessage(msg: Message): msg is UserMessage {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return false;
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result");
}

/**
 * Extract tool_result blocks from a message.
 */
export function getToolResultBlocks(msg: Message): ToolResultBlock[] {
  if (msg.role !== "user" || typeof msg.content === "string" || !Array.isArray(msg.content)) return [];
  return msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

/**
 * Get the first tool_use_id from a tool_result message.
 */
export function getToolUseId(msg: Message): string | undefined {
  const blocks = getToolResultBlocks(msg);
  return blocks.length > 0 ? blocks[0].tool_use_id : undefined;
}

/**
 * Get the content from a tool_result message (first block's content).
 */
export function getToolResultContent(msg: Message): string | ContentBlock[] | undefined {
  const blocks = getToolResultBlocks(msg);
  return blocks.length > 0 ? blocks[0].content : undefined;
}

/**
 * Check if a tool_result message has is_error set.
 */
export function isToolResultError(msg: Message): boolean {
  const blocks = getToolResultBlocks(msg);
  return blocks.length > 0 && blocks[0].is_error === true;
}

/**
 * Analytics callback for ensureToolResultPairing telemetry.
 */
export type PairingAnalyticsCallback = (event: string, metadata: Record<string, unknown>) => void;

/**
 * Smoosh `<system-reminder>`-prefixed text siblings in user messages that also
 * contain tool_result blocks. After pairing fixes (which may prepend synthetic
 * tool_result blocks), a user message can end up with [tool_result, text(SR)]
 * siblings that the normalize pass never saw. This re-merges them into the
 * last tool_result's content.
 *
 * Aligned with claude-code's smooshSystemReminderSiblings. Non-system-reminder
 * text (real user input) is left untouched.
 *
 * Idempotent. Pure function of shape.
 *
 * @param messages - The message array to post-process
 * @param enabled - Whether smooshing is enabled (configurable, mirrors claude-code's feature flag)
 */
export function smooshSystemReminderSiblings(
  messages: Message[],
  enabled = true,
): Message[] {
  if (!enabled) return messages;

  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    const hasToolResult = content.some((b) => b.type === "tool_result");
    if (!hasToolResult) return msg;

    const srTexts: { type: "text"; text: string }[] = [];
    const kept: (ContentBlock | ToolResultBlock)[] = [];
    for (const b of content) {
      if (b.type === "text" && b.text.startsWith("<system-reminder>")) {
        srTexts.push(b as { type: "text"; text: string });
      } else {
        kept.push(b);
      }
    }
    if (srTexts.length === 0) return msg;

    // Find the LAST tool_result and smoosh SR text into its content
    let lastTrIdx = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].type === "tool_result") {
        lastTrIdx = i;
        break;
      }
    }
    if (lastTrIdx === -1) return msg; // shouldn't happen given hasToolResult check

    const lastTr = kept[lastTrIdx] as ToolResultBlock;
    // Smoosh: append SR text into the tool_result's content
    const existingContent = lastTr.content;
    const srTextContent = srTexts.map((t) => t.text).join("\n\n");

    let newTrContent: string | ContentBlock[];
    if (typeof existingContent === "string" || existingContent == null) {
      // String content — just append
      const base = typeof existingContent === "string" ? existingContent.trim() : "";
      newTrContent = [base, srTextContent].filter(Boolean).join("\n\n");
    } else {
      // Array content — append text blocks
      newTrContent = [...existingContent, ...srTexts];
    }

    const newContent = [
      ...kept.slice(0, lastTrIdx),
      { ...lastTr, content: newTrContent },
      ...kept.slice(lastTrIdx + 1),
    ];
    return { ...msg, content: newContent } as UserMessage;
  });
}

/**
 * Check if an object is a tool_reference block.
 * tool_reference is a beta feature not in the SDK types, so we need runtime checks.
 * Aligned with claude-code's isToolReferenceBlock.
 */
function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "type" in obj &&
    (obj as { type: unknown }).type === "tool_reference"
  );
}

/**
 * Does the content array have a tool_result block whose inner content
 * contains tool_reference (ToolSearch loaded tools)?
 * Aligned with claude-code's contentHasToolReference.
 */
function contentHasToolReference(
  content: ReadonlyArray<ContentBlock | ToolResultBlock>,
): boolean {
  return content.some(
    (block) =>
      block.type === "tool_result" &&
      Array.isArray((block as ToolResultBlock).content) &&
      ((block as ToolResultBlock).content as ContentBlock[]).some(isToolReferenceBlock),
  );
}

/**
 * Strip non-text blocks from is_error tool_results — the API rejects the
 * combination with "all content must be type text if is_error is true".
 *
 * Read-side guard for transcripts persisted before smooshIntoToolResult
 * learned to filter on is_error. Without this a resumed session with an
 * image-in-error tool_result 400s forever.
 *
 * Aligned with claude-code's sanitizeErrorToolResultContent.
 */
function sanitizeErrorToolResultContent(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((b) => {
      if (b.type !== "tool_result" || !(b as ToolResultBlock).is_error) return b;
      const trContent = (b as ToolResultBlock).content;
      if (!Array.isArray(trContent)) return b;
      if (trContent.every((c) => c.type === "text")) return b;
      changed = true;
      const texts = trContent
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text);
      const textOnly: ContentBlock[] =
        texts.length > 0
          ? [{ type: "text" as const, text: texts.join("\n\n") }]
          : [{ type: "text" as const, text: NO_CONTENT_MESSAGE }];
      return { ...b, content: textOnly };
    });
    if (!changed) return msg;
    return { ...msg, content: newContent } as UserMessage;
  });
}

/**
 * Move text-block siblings off user messages that contain tool_reference.
 *
 * When a tool_result contains tool_reference, the server expands it to a
 * functions block. Any text siblings appended to that same user message
 * (auto-memory, skill reminders, etc.) create a second human-turn segment
 * right after the functions-close tag — an anomalous pattern the model
 * imprints on.
 *
 * The fix: find the next user message with tool_result content but NO
 * tool_reference, and move the text siblings there. Pure transformation —
 * no state, no side effects.
 *
 * If no valid target exists, siblings stay in place.
 *
 * Aligned with claude-code's relocateToolReferenceSiblings.
 */
function relocateToolReferenceSiblings(messages: Message[]): Message[] {
  const result = [...messages];

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    if (!contentHasToolReference(content)) continue;

    const textSiblings = content.filter((b) => b.type === "text");
    if (textSiblings.length === 0) continue;

    // Find the next user message with tool_result but no tool_reference.
    let targetIdx = -1;
    for (let j = i + 1; j < result.length; j++) {
      const cand = result[j];
      if (cand.role !== "user") continue;
      const cc = cand.content;
      if (!Array.isArray(cc)) continue;
      if (!cc.some((b) => b.type === "tool_result")) continue;
      if (contentHasToolReference(cc)) continue;
      targetIdx = j;
      break;
    }

    if (targetIdx === -1) continue; // No valid target; leave in place.

    // Strip text from source, append to target.
    result[i] = {
      ...msg,
      content: content.filter((b) => b.type !== "text"),
    } as UserMessage;
    const target = result[targetIdx] as UserMessage;
    result[targetIdx] = {
      ...target,
      content: [
        ...(target.content as (ContentBlock | ToolResultBlock)[]),
        ...textSiblings,
      ],
    } as UserMessage;
  }

  return result;
}

/**
 * Defensive validation: ensure tool_use/tool_result pairing is correct.
 * Aligned with claude-code's ensureToolResultPairing.
 *
 * Handles:
 * - Forward: inserts synthetic error tool_result messages for tool_use blocks missing results
 * - Reverse: strips orphaned tool_result blocks (not entire messages) from user messages
 * - server_tool_use/mcp_tool_use orphan stripping: strips API-managed tool use blocks with no result
 * - Cross-message tool_use ID deduplication: strips duplicate tool_use IDs across ALL assistant messages
 * - Duplicate tool_result deduplication: strips duplicate tool_result blocks
 * - Orphaned tool_results at conversation start: strips tool_result blocks from leading user messages
 * - Empty content handling: inserts placeholder text if stripping empties a message
 * - System reminder smooshing: re-merges SR text siblings after pairing fixes (configurable)
 *
 * @param messages - The message array to validate
 * @param onRepaired - Optional analytics callback invoked when pairing fixes are applied
 * @param smooshSystemReminders - Whether to smoosh system reminder siblings after pairing (default: true)
 */
export function ensureToolResultPairing(
  messages: Message[],
  onRepaired?: PairingAnalyticsCallback,
  smooshSystemReminders = true,
): Message[] {
  let changed = false;

  // --- Pass 1: Strip orphaned tool_result BLOCKS from leading user messages ---
  // A user message with tool_result blocks but NO preceding assistant message
  // in the output has orphaned tool_results. Strip only the tool_result blocks,
  // not the entire message — preserve text and other content.
  const working: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Only process user messages at the start before any assistant message appears
    if (msg.role === "user" && Array.isArray(msg.content) && !working.some((m) => m.role === "assistant")) {
      const stripped = msg.content.filter(
        (block) => !(typeof block === "object" && "type" in block && block.type === "tool_result"),
      );
      if (stripped.length !== msg.content.length) {
        changed = true;
        if (stripped.length > 0) {
          // Keep the message with non-tool-result content preserved
          working.push({ ...msg, content: stripped } as UserMessage);
        } else {
          // Stripping emptied the message — insert placeholder to maintain role
          // alternation. If nothing has been pushed yet, we need a user message
          // so the payload doesn't start with assistant.
          working.push({
            role: "user",
            content: [{ type: "text" as const, text: NO_CONTENT_MESSAGE }],
          } as UserMessage);
        }
        continue;
      }
    }
    working.push(msg);
  }

  // --- Pass 2: Deduplicate tool_use IDs across ALL assistant messages and strip orphaned server tool uses ---
  // Cross-message tool_use ID tracking: catches duplicates across different
  // assistant messages (e.g. orphan handler re-pushed an assistant already present),
  // not just within a single message's content array.
  const allSeenToolUseIds = new Set<string>();
  const deduped: Message[] = [];

  for (const msg of working) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Collect server-side tool result IDs (*_tool_result blocks have tool_use_id).
      // These are API-managed result blocks that live in the SAME assistant message.
      const serverResultIds = new Set<string>();
      for (const block of msg.content) {
        if ("tool_use_id" in block && typeof (block as Record<string, unknown>).tool_use_id === "string") {
          serverResultIds.add((block as Record<string, unknown>).tool_use_id as string);
        }
      }

      const filteredContent = msg.content.filter((block) => {
        // Deduplicate tool_use blocks by ID across all assistant messages
        if (block.type === "tool_use" && block.id) {
          if (allSeenToolUseIds.has(block.id)) {
            changed = true;
            return false; // strip duplicate
          }
          allSeenToolUseIds.add(block.id);
        }
        // Strip orphaned server-side tool use blocks (server_tool_use, mcp_tool_use)
        // whose result blocks live in the SAME assistant message. If the stream was
        // interrupted before the result arrived, the use block has no matching
        // *_tool_result and the API rejects.
        const blockType = block.type as string;
        if (
          (blockType === "server_tool_use" || blockType === "mcp_tool_use") &&
          !serverResultIds.has((block as unknown as { id: string }).id)
        ) {
          changed = true;
          return false;
        }
        return true;
      });

      if (filteredContent.length === 0) {
        // Stripping duplicates/orphans emptied the message — insert placeholder
        changed = true;
        deduped.push({ ...msg, content: [{ type: "text", text: "[Tool use interrupted]" }] } as Message);
      } else if (filteredContent.length !== msg.content.length) {
        changed = true;
        deduped.push({ ...msg, content: filteredContent } as Message);
      } else {
        deduped.push(msg);
      }
    } else {
      deduped.push(msg);
    }
  }

  // --- Pass 3: Adjacency-based tool_use/tool_result pairing ---
  // Aligned with claude-code: for each assistant message, collect tool_use IDs,
  // then check the NEXT message for matching tool_results. Insert synthetics for
  // missing results and strip orphaned/duplicate tool_results.
  const result: Message[] = [];

  for (let i = 0; i < deduped.length; i++) {
    const msg = deduped[i];

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Collect tool_use IDs from this assistant message
      const toolUseIdsInAssistant: string[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseIdsInAssistant.push(block.id);
        }
      }

      result.push(msg);

      // If no tool_use blocks, nothing to pair
      if (toolUseIdsInAssistant.length === 0) continue;

      const toolUseIdSet = new Set(toolUseIdsInAssistant);

      // Check the next message for matching tool_results
      const nextMsg = deduped[i + 1];
      const existingToolResultIds = new Set<string>();
      let hasDuplicateToolResults = false;

      if (nextMsg && isToolResultMessage(nextMsg)) {
        const content = nextMsg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && "type" in block && block.type === "tool_result") {
              const trId = (block as ToolResultBlock).tool_use_id;
              if (existingToolResultIds.has(trId)) {
                hasDuplicateToolResults = true;
              }
              existingToolResultIds.add(trId);
            }
          }
        }
      }

      // Find missing tool_result IDs (tool_use without tool_result)
      const missingIds = toolUseIdsInAssistant.filter((id) => !existingToolResultIds.has(id));

      // Find orphaned tool_result IDs (tool_result without tool_use in preceding assistant)
      const orphanedIds = [...existingToolResultIds].filter((id) => !toolUseIdSet.has(id));

      if (missingIds.length === 0 && orphanedIds.length === 0 && !hasDuplicateToolResults) {
        continue;
      }

      changed = true;

      // Build synthetic error tool_result blocks for missing IDs
      const syntheticBlocks: ToolResultBlock[] = missingIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
        is_error: true,
      }));

      if (nextMsg && isToolResultMessage(nextMsg)) {
        // Next message is already a user message with tool_results — patch it
        let content: (ContentBlock | ToolResultBlock)[] = Array.isArray(nextMsg.content)
          ? nextMsg.content
          : [{ type: "text" as const, text: typeof nextMsg.content === "string" ? nextMsg.content : "" }];

        // Strip orphaned tool_results and dedupe duplicate tool_result IDs
        if (orphanedIds.length > 0 || hasDuplicateToolResults) {
          const orphanedSet = new Set(orphanedIds);
          const seenTrIds = new Set<string>();
          content = content.filter((block) => {
            if (typeof block === "object" && "type" in block && block.type === "tool_result") {
              const trId = (block as ToolResultBlock).tool_use_id;
              if (orphanedSet.has(trId)) return false;
              if (seenTrIds.has(trId)) return false;
              seenTrIds.add(trId);
            }
            return true;
          });
        }

        const patchedContent = [...syntheticBlocks, ...content];

        if (patchedContent.length > 0) {
          const patchedNext = { ...nextMsg, content: patchedContent } as UserMessage;
          i++; // Skip the processed user message
          // Re-smoosh system reminder siblings after patching
          result.push(
            smooshSystemReminders
              ? smooshSystemReminderSiblings([patchedNext])[0]!
              : patchedNext,
          );
        } else {
          // Content is empty after stripping orphaned tool_results — insert placeholder
          i++; // Skip the processed user message
          result.push({
            role: "user",
            content: [{ type: "text" as const, text: NO_CONTENT_MESSAGE }],
          } as UserMessage);
        }
      } else {
        // No user message follows — insert a synthetic user message (only if missing IDs)
        if (syntheticBlocks.length > 0) {
          result.push(createToolResultMessage(
            syntheticBlocks[0].tool_use_id,
            syntheticBlocks[0].content,
            true,
          ));
          // If multiple missing, create a single message with all synthetic blocks
          if (syntheticBlocks.length > 1) {
            result[result.length - 1] = {
              role: "user",
              content: syntheticBlocks,
            } as UserMessage;
          }
        }
      }
    } else {
      result.push(msg);
    }
  }

  // --- Pass 4: Smoosh system reminder siblings ---
  // After pairing fixes, user messages may have [tool_result, text(SR)] siblings.
  // Re-merge SR text into the last tool_result to avoid spurious Human: boundaries.
  const smooshed = smooshSystemReminders ? smooshSystemReminderSiblings(result) : result;

  // --- Pass 5: Sanitize error tool_result content ---
  // The API rejects non-text content in is_error tool_results ("all content must
  // be type text if is_error is true"). Strip images, tool_references, etc.
  const sanitized = sanitizeErrorToolResultContent(smooshed);

  // --- Pass 6: Relocate text siblings off tool_reference messages ---
  // When a tool_result contains tool_reference, the server expands it to a
  // functions block. Text siblings create a broken prompt structure. Move text
  // blocks to the next suitable user message. See claude-code #21049.
  const finalResult = relocateToolReferenceSiblings(sanitized);

  if (changed && onRepaired) {
    // Log diagnostic info to help identify root cause of pairing issues
    const messageTypes = messages.map((m, idx) => {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const toolUses = m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => (b as { id: string }).id);
        const serverToolUses = m.content
          .filter((b) => (b.type as string) === "server_tool_use" || (b.type as string) === "mcp_tool_use")
          .map((b) => (b as unknown as { id: string }).id);
        const parts = [`tool_uses=[${toolUses.join(",")}]`];
        if (serverToolUses.length > 0) {
          parts.push(`server_tool_uses=[${serverToolUses.join(",")}]`);
        }
        return `[${idx}] assistant(${parts.join(", ")})`;
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        const toolResults = m.content
          .filter((b): b is ToolResultBlock => typeof b === "object" && "type" in b && b.type === "tool_result")
          .map((b) => b.tool_use_id);
        if (toolResults.length > 0) {
          return `[${idx}] user(tool_results=[${toolResults.join(",")}])`;
        }
      }
      return `[${idx}] ${m.role}`;
    });

    onRepaired("tool_result_pairing_repaired", {
      messageCount: messages.length,
      repairedMessageCount: finalResult.length,
      messageTypes: messageTypes.join("; "),
    });
  }

  return changed ? finalResult : messages;
}
