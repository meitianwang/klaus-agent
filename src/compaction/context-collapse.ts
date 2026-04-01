// ContextCollapseManager — staged context summarization for granular overflow recovery.
//   - Proactively stages spans of messages for collapse when context usage hits ~90%
//   - Commits (applies) staged collapses when context hits ~95% or on 413 recovery
//   - recoverFromOverflow() drains all staged collapses on prompt-too-long errors
//   - applyCollapsesIfNeeded() proactively commits when context is high
//   - isWithheldPromptTooLong() determines if a 413 should be withheld for recovery
//
// Key difference from reactive compact (full summarization):
//   Context collapse is lighter-weight — it summarizes specific spans of older
//   messages while keeping the rest intact, preserving more granular context.

import type { AgentMessage, Message, UserMessage } from "../types.js";
import { estimateTokens } from "./compaction.js";

/** A span of messages identified for summarization. */
interface CollapseSpan {
  startIndex: number;   // Index in the message array where the span starts
  endIndex: number;     // Index where the span ends (exclusive)
  summary: string;      // Generated summary text
  tokensSaved: number;  // Tokens freed by this collapse
  committed: boolean;   // Whether this collapse has been applied
}

export interface ContextCollapseConfig {
  /** Maximum context tokens (same as compaction.maxContextTokens). */
  maxContextTokens: number;
  /** Threshold ratio (0-1) at which to stage collapses. Default: 0.90. */
  stageThreshold?: number;
  /** Threshold ratio (0-1) at which to commit staged collapses. Default: 0.95. */
  commitThreshold?: number;
  /** Summarizer function — generates a summary for a span of messages. */
  summarize: (messages: AgentMessage[]) => Promise<string>;
  /** Minimum span size (in messages) to consider for collapse. Default: 4. */
  minSpanSize?: number;
}

export interface CollapseResult {
  messages: Message[];
  committed: number;  // Number of collapses committed in this call
}

export class ContextCollapseManager {
  private spans: CollapseSpan[] = [];
  private readonly stageThreshold: number;
  private readonly commitThreshold: number;
  private readonly minSpanSize: number;

  constructor(private readonly config: ContextCollapseConfig) {
    this.stageThreshold = config.stageThreshold ?? 0.90;
    this.commitThreshold = config.commitThreshold ?? 0.95;
    this.minSpanSize = config.minSpanSize ?? 4;
  }

  /**
   * Determine if a prompt-too-long error should be withheld for collapse recovery.
   * Returns true if there are staged (uncommitted) collapses available to drain.
   */
  isWithheldPromptTooLong(): boolean {
    return this.spans.some((s) => !s.committed);
  }

  /**
   * Apply collapses if context usage is high enough. Called before autocompact.
   *
   * Two phases:
   * 1. Stage: if context > stageThreshold, identify new spans to collapse
   * 2. Commit: if context > commitThreshold, apply all staged collapses
   */
  async applyCollapsesIfNeeded(
    messagesForQuery: Message[],
    allMessages: AgentMessage[],
  ): Promise<CollapseResult> {
    const tokens = estimateTokens(messagesForQuery);
    const ratio = tokens / this.config.maxContextTokens;

    // Phase 1: Stage new collapses if above staging threshold
    if (ratio >= this.stageThreshold && !this.hasUncommittedSpans()) {
      await this.stageNewCollapses(allMessages);
    }

    // Phase 2: Commit if above commit threshold
    if (ratio >= this.commitThreshold && this.hasUncommittedSpans()) {
      return this.commitAllStaged(messagesForQuery, allMessages);
    }

    return { messages: messagesForQuery, committed: 0 };
  }

  /**
   * Drain all staged collapses as a 413 recovery mechanism.
   * Called when prompt-too-long error is withheld and collapse drain is attempted
   * before falling through to reactive compact.
   */
  async recoverFromOverflow(
    messagesForQuery: Message[],
    allMessages: AgentMessage[],
  ): Promise<CollapseResult> {
    if (!this.hasUncommittedSpans()) {
      return { messages: messagesForQuery, committed: 0 };
    }
    return this.commitAllStaged(messagesForQuery, allMessages);
  }

  /** Get stats for debugging. */
  getStats(): { stagedSpans: number; committedSpans: number; totalTokensSaved: number } {
    return {
      stagedSpans: this.spans.filter((s) => !s.committed).length,
      committedSpans: this.spans.filter((s) => s.committed).length,
      totalTokensSaved: this.spans.filter((s) => s.committed).reduce((sum, s) => sum + s.tokensSaved, 0),
    };
  }

  private hasUncommittedSpans(): boolean {
    return this.spans.some((s) => !s.committed);
  }

  /**
   * Identify spans of older messages to collapse and generate summaries.
   * Strategy: find contiguous tool-use turns (assistant + tool_result pairs)
   * in the older portion of the conversation and summarize them.
   */
  private async stageNewCollapses(allMessages: AgentMessage[]): Promise<void> {
    // Only consider the first 60% of messages as candidates for collapse
    const candidateEnd = Math.floor(allMessages.length * 0.6);
    if (candidateEnd < this.minSpanSize) return;

    // Find spans of tool-use turns (assistant with tool_call + tool_result pairs)
    let spanStart = -1;
    let i = 0;

    while (i < candidateEnd) {
      const msg = allMessages[i] as Message;
      if (!msg || typeof msg !== "object" || !("role" in msg)) {
        i++;
        continue;
      }

      // Look for assistant messages with tool calls
      if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((b: any) => b.type === "tool_call")) {
        if (spanStart === -1) spanStart = i;
        // Skip past the tool_result messages that follow
        i++;
        while (i < candidateEnd) {
          const next = allMessages[i] as Message;
          if (next && typeof next === "object" && "role" in next && next.role === "tool_result") {
            i++;
          } else {
            break;
          }
        }
      } else {
        // Non-tool-call message — if we have a span, end it
        if (spanStart !== -1 && (i - spanStart) >= this.minSpanSize) {
          await this.stageSpan(allMessages, spanStart, i);
          spanStart = -1;
        } else if (spanStart !== -1) {
          // Span too small, reset
          spanStart = -1;
        }
        i++;
      }
    }

    // Close any trailing span
    if (spanStart !== -1 && (candidateEnd - spanStart) >= this.minSpanSize) {
      await this.stageSpan(allMessages, spanStart, candidateEnd);
    }
  }

  private async stageSpan(allMessages: AgentMessage[], start: number, end: number): Promise<void> {
    // Don't re-stage overlapping spans
    for (const existing of this.spans) {
      if (start < existing.endIndex && end > existing.startIndex) return;
    }

    const spanMessages = allMessages.slice(start, end);
    const tokensBefore = estimateTokens(spanMessages);

    try {
      const summary = await this.config.summarize(spanMessages);
      if (!summary) return;

      const summaryTokens = Math.ceil(summary.length / 4);
      const tokensSaved = tokensBefore - summaryTokens;
      if (tokensSaved <= 0) return; // Not worth collapsing

      this.spans.push({
        startIndex: start,
        endIndex: end,
        summary,
        tokensSaved,
        committed: false,
      });
    } catch {
      // Non-critical — don't stage if summarization fails
    }
  }

  /**
   * Commit all staged (uncommitted) collapses to the message array.
   * Returns the new messages with collapsed spans replaced by summaries.
   */
  private commitAllStaged(
    messagesForQuery: Message[],
    allMessages: AgentMessage[],
  ): CollapseResult {
    const uncommitted = this.spans.filter((s) => !s.committed).sort((a, b) => a.startIndex - b.startIndex);
    if (uncommitted.length === 0) {
      return { messages: messagesForQuery, committed: 0 };
    }

    // Build new message array with collapsed spans replaced by summaries.
    // Work on allMessages indices — messagesForQuery is a filtered view, so
    // we rebuild from allMessages and re-filter.
    const result: AgentMessage[] = [];
    let cursor = 0;

    for (const span of uncommitted) {
      // Keep messages before this span
      for (let j = cursor; j < span.startIndex && j < allMessages.length; j++) {
        result.push(allMessages[j]);
      }
      // Insert summary in place of the span
      result.push({
        role: "user",
        content: `<collapsed>${span.summary}</collapsed>`,
      } as UserMessage);
      cursor = span.endIndex;
      span.committed = true;
    }

    // Keep messages after the last span
    for (let j = cursor; j < allMessages.length; j++) {
      result.push(allMessages[j]);
    }

    // Re-derive messagesForQuery from the new allMessages
    const newMessagesForQuery = result.filter((m): m is Message =>
      typeof m === "object" && m !== null && "role" in m &&
      (m.role === "user" || m.role === "assistant" || m.role === "tool_result")
    );

    return { messages: newMessagesForQuery, committed: uncommitted.length };
  }
}
