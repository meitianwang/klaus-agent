/**
 * Tool Use Summary Generator
 *
 * Generates human-readable summaries of completed tool batches using a fast model.
 * Used by the SDK to provide high-level progress updates to clients.
 */

import { randomUUID } from "crypto";
import type { ToolUseSummaryMessage } from "../llm/types.js";
import type { LLMProvider, LLMRequestOptions } from "../llm/types.js";

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`;

export interface ToolUseSummaryConfig {
  /** Whether to enable tool use summary generation. */
  enabled: boolean;
  /** LLM provider to use for summary generation (typically a fast/cheap model). */
  provider: LLMProvider;
  /** Model ID for summary generation (e.g., a Haiku-class model). */
  modelId: string;
  /** Whether the session is non-interactive (e.g., headless/CI). */
  isNonInteractiveSession?: boolean;
  /** Optional error logging callback. */
  logError?: (errorId: string, error: Error) => void;
}

export type ToolInfo = {
  name: string;
  input: unknown;
  output: unknown;
};

export type GenerateToolUseSummaryParams = {
  tools: ToolInfo[];
  signal: AbortSignal;
  isNonInteractiveSession: boolean;
  lastAssistantText?: string;
};

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
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

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/**
 * Truncates a JSON value to a maximum length for the prompt.
 */
function truncateJson(value: unknown, maxLength: number): string {
  try {
    const str = jsonStringify(value);
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + "...";
  } catch {
    return "[unable to serialize]";
  }
}

/**
 * Generates a human-readable summary of completed tools.
 *
 * @param params - Parameters including tools executed and their results
 * @param config - SDK configuration for LLM provider and model
 * @returns A brief summary string, or null if generation fails
 */
export async function generateToolUseSummary(
  params: GenerateToolUseSummaryParams,
  config: ToolUseSummaryConfig,
): Promise<string | null> {
  const { tools, signal, isNonInteractiveSession, lastAssistantText } = params;

  if (!config.enabled || tools.length === 0) return null;

  try {
    // Build concise representation of tool execution
    const toolSummaries = tools
      .map((tool) => {
        const inputStr = truncateJson(tool.input, 300);
        const outputStr = truncateJson(tool.output, 300);
        return `Tool: ${tool.name}\nInput: ${inputStr}\nOutput: ${outputStr}`;
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
      enablePromptCaching: true,
      isNonInteractiveSession,
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
    return summaryText || null;
  } catch (rawError) {
    const error = toError(rawError);
    const errorId = "E_TOOL_USE_SUMMARY_GENERATION_FAILED";
    (error as any).cause = { errorId };
    config.logError?.(errorId, error);
    return null;
  }
}

/**
 * Creates a tool use summary message for SDK emission.
 */
export function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[],
): ToolUseSummaryMessage {
  return {
    type: "tool_use_summary",
    summary,
    precedingToolUseIds,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}
