// Build session context by walking the branch from root to leaf

import type {
  SessionEntry,
  SessionMessageEntry,
  CompactionEntry,
  BranchSummaryEntry,
  SessionContext,
} from "./types.js";
import type { AgentMessage, UserMessage } from "../types.js";

export function buildSessionContext(branch: SessionEntry[]): SessionContext {
  const messages: AgentMessage[] = [];
  let compactionSummary: string | undefined;
  let compactionFirstKeptId: string | null = null;
  let pastCompactionCutoff = false;

  // First pass: find the latest compaction entry
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction") {
      compactionSummary = (entry as CompactionEntry).summary;
      compactionFirstKeptId = (entry as CompactionEntry).firstKeptEntryId;
      break;
    }
  }

  // If no compaction, include all messages
  if (!compactionFirstKeptId) {
    pastCompactionCutoff = true;
  }

  // Second pass: build messages
  for (const entry of branch) {
    // If we have a compaction, skip entries before the kept point
    if (!pastCompactionCutoff) {
      if (entry.type === "compaction" && (entry as CompactionEntry).firstKeptEntryId === compactionFirstKeptId) {
        // This is the compaction entry — inject summary and start keeping
        pastCompactionCutoff = true;
        if (compactionSummary) {
          const summaryMsg: UserMessage = {
            role: "user",
            content: `<compaction-summary>${compactionSummary}</compaction-summary>`,
          };
          messages.push(summaryMsg);
        }
        continue;
      }
      continue; // Skip pre-compaction entries
    }

    if (entry.type === "message") {
      messages.push((entry as SessionMessageEntry).message);
    } else if (entry.type === "branch_summary") {
      const summaryMsg: UserMessage = {
        role: "user",
        content: `[Branch summary] ${(entry as BranchSummaryEntry).summary}`,
      };
      messages.push(summaryMsg);
    }
    // checkpoint, model_change, thinking_level_change, custom — not included in LLM context
  }

  return { messages, compactionSummary };
}
