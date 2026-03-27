// Compaction types

export interface CompactionConfig {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  maxContextTokens?: number;
  customSummarizer?: CompactionSummarizer;

  /** Number of recent tool results to keep intact during micro compaction. Default: 3. */
  keepRecentToolResults?: number;
}

export interface CompactionSummarizer {
  summarize(messages: CompactionInput[], previousSummary?: string): Promise<string>;
}

export interface CompactionInput {
  role: string;
  content: string;
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CutPointResult {
  firstKeptIndex: number;
  isSplitTurn: boolean;
}
