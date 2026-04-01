// Tool use summary generation — async pipeline for summarizing tool execution.
//   - After tool execution, fires off an async summary generation (non-blocking)
//   - Summary is awaited and emitted in the next iteration while the model streams
//   - Uses a separate (cheaper/faster) model call for generation
//   - Non-critical: failures are swallowed, returning null

import type { ToolCallBlock, ToolUseSummaryMessage } from "../llm/types.js";
import type { ToolCallResult } from "../tools/executor.js";
import type { LLMProvider, LLMRequestOptions } from "../llm/types.js";

const TOOL_USE_SUMMARY_SYSTEM_PROMPT =
  "Write a short summary label describing what these tool calls accomplished. " +
  "It appears as a single-line row in a UI and truncates around 30 characters, " +
  "so think git-commit-subject, not sentence.\n\n" +
  "Keep the verb in past tense and the most distinctive noun. " +
  "Drop articles, connectors, and long location context first.\n\n" +
  "Examples:\n" +
  "- Searched in auth/\n" +
  "- Fixed NPE in UserService\n" +
  "- Created signup endpoint\n" +
  "- Read config.json\n" +
  "- Ran failing tests";

export interface ToolUseSummaryConfig {
  /** Whether to enable tool use summary generation. */
  enabled: boolean;
  /** LLM provider to use for summary generation (typically a fast/cheap model). */
  provider: LLMProvider;
  /** Model ID for summary generation (e.g., a Haiku-class model). */
  modelId: string;
}

function truncateJson(value: unknown, maxChars: number): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (!str) return "(empty)";
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "...";
}

/**
 * Generate a tool use summary for a batch of tool executions.
 * Returns a ToolUseSummaryMessage or null on failure.
 */
export async function generateToolUseSummary(
  toolBlocks: ToolCallBlock[],
  toolResults: ToolCallResult[],
  lastAssistantText: string | undefined,
  config: ToolUseSummaryConfig,
  signal?: AbortSignal,
): Promise<ToolUseSummaryMessage | null> {
  if (!config.enabled || toolBlocks.length === 0) return null;

  try {
    // Build concise representation of tool execution
    const toolSummaries = toolBlocks
      .map((block) => {
        const result = toolResults.find((r) => r.toolCallId === block.id);
        const inputStr = truncateJson(block.input, 300);
        const outputStr = result ? truncateJson(result.result.content, 300) : "(no result)";
        return `Tool: ${block.name}\nInput: ${inputStr}\nOutput: ${outputStr}`;
      })
      .join("\n\n");

    const contextPrefix = lastAssistantText
      ? `User's intent (from assistant's last message): ${lastAssistantText.slice(0, 200)}\n\n`
      : "";

    const requestOptions: LLMRequestOptions = {
      model: config.modelId,
      systemPrompt: TOOL_USE_SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`,
        },
      ],
      maxTokens: 100,
      signal,
    };

    let summaryText = "";
    for await (const event of config.provider.stream(requestOptions)) {
      if (event.type === "done") {
        for (const block of event.message.content) {
          if (block.type === "text") summaryText += block.text;
        }
      }
    }

    summaryText = summaryText.trim();
    if (!summaryText) return null;

    return {
      type: "tool_use_summary",
      summary: summaryText,
      precedingToolUseIds: toolBlocks.map((b) => b.id),
    };
  } catch {
    // Non-critical — return null on any failure
    return null;
  }
}
