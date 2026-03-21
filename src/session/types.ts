// Session persistence types — tree-based JSONL

import type { AgentMessage } from "../types.js";

// --- Session entry base ---

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

// --- Entry types ---

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface CheckpointEntry extends SessionEntryBase {
  type: "checkpoint";
  checkpointId: number;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export type SessionEntry =
  | SessionMessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CheckpointEntry
  | CustomEntry;

// --- Tree node ---

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}

// --- Session context (built from tree walk) ---

export interface SessionContext {
  messages: AgentMessage[];
  compactionSummary?: string;
}

// --- Session config ---

export interface SessionConfig {
  persist?: boolean;
  directory?: string;
  sessionId?: string;
}
