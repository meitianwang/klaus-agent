// Shared streaming utilities for LLM providers

import type { AssistantMessageEvent, ModelCost, TokenUsage, ThinkingLevel, UsageCost } from "../llm/types.js";

// Retryable error patterns common across providers
const COMMON_RETRYABLE = ["429", "500", "503", "ECONNRESET"];

export const RETRYABLE_PATTERNS: Record<string, string[]> = {
  anthropic: [...COMMON_RETRYABLE, "rate_limit", "overloaded", "529"],
  openai: [...COMMON_RETRYABLE, "rate_limit"],
  google: [...COMMON_RETRYABLE],
  codex: [...COMMON_RETRYABLE, "rate_limit", "usage_limit", "overloaded"],
};

export function isRetryableError(error: Error, patterns: string[]): boolean {
  return patterns.some((p) => error.message.includes(p));
}

/**
 * Wraps a streaming generator with exponential backoff retry logic.
 * Only retries on connection-level failures before streaming starts.
 */
export async function* withRetry(
  streamOnce: () => AsyncIterable<AssistantMessageEvent>,
  retryablePatterns: string[],
  maxRetries = 3,
): AsyncIterable<AssistantMessageEvent> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      yield* streamOnce();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryableError(lastError, retryablePatterns) || attempt === maxRetries) {
        yield { type: "error", error: lastError };
        return;
      }
    }
  }
}

/** Maps ThinkingLevel to token budget (shared by Anthropic and Gemini). */
export function mapThinkingBudget(level?: ThinkingLevel): number | undefined {
  if (!level || level === "off") return undefined;
  const budgets: Record<string, number> = {
    minimal: 1024,
    low: 4096,
    medium: 10240,
    high: 20480,
    xhigh: 40960,
  };
  return budgets[level];
}

/** Maps ThinkingLevel to OpenAI reasoning_effort (shared by OpenAI and OpenAI Responses). */
export function mapReasoningEffort(level?: ThinkingLevel): "low" | "medium" | "high" | undefined {
  if (!level || level === "off") return undefined;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  return "high";
}

/** Calculate actual dollar cost from token counts and per-million-token pricing. */
export function calculateCost(cost: ModelCost | undefined, usage: TokenUsage): UsageCost | undefined {
  if (!cost) return undefined;
  const input = (cost.input / 1_000_000) * usage.inputTokens;
  const output = (cost.output / 1_000_000) * usage.outputTokens;
  const cacheRead = ((cost.cacheRead ?? 0) / 1_000_000) * (usage.cacheReadTokens ?? 0);
  const cacheWrite = ((cost.cacheWrite ?? 0) / 1_000_000) * (usage.cacheWriteTokens ?? 0);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
