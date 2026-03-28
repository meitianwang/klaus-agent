// Session manager — JSONL tree with append, branch, navigate

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { generateId } from "../utils/id.js";
import { readJSONL, appendJSONL, writeJSONLHeader } from "../utils/jsonl.js";
import { buildSessionContext } from "./session-context-builder.js";
import type {
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  CompactionEntry,
  BranchSummaryEntry,
  ModelChangeEntry,
  ThinkingLevelChangeEntry,
  CheckpointEntry,
  CustomEntry,
  SessionTreeNode,
  SessionContext,
  SessionConfig,
} from "./types.js";
import type { AgentMessage } from "../types.js";

const SESSION_VERSION = 1;

export class SessionManager {
  private _entries: SessionEntry[] = [];
  private _entriesById = new Map<string, SessionEntry>();
  private _leafId: string | null = null;
  private _sessionId: string;
  private _filePath: string | null;
  private _persist: boolean;

  constructor(config?: SessionConfig) {
    this._persist = config?.persist ?? false;
    this._sessionId = config?.sessionId ?? generateId();

    if (this._persist && config?.directory) {
      mkdirSync(config.directory, { recursive: true });
      this._filePath = join(config.directory, `${this._sessionId}.jsonl`);
    } else {
      this._filePath = null;
    }
  }

  // --- Init ---

  private _initialized = false;

  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    if (this._filePath && existsSync(this._filePath)) {
      await this._load();
    } else if (this._filePath) {
      const header: SessionHeader = {
        type: "session",
        version: SESSION_VERSION,
        id: this._sessionId,
        timestamp: new Date().toISOString(),
      };
      await writeJSONLHeader(this._filePath, header);
    }
  }

  // --- Append operations ---

  async appendMessage(message: AgentMessage): Promise<string> {
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    return this._append(entry);
  }

  async appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<string> {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    return this._append(entry);
  }

  async appendBranchSummary(fromId: string, summary: string): Promise<string> {
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      fromId,
      summary,
    };
    return this._append(entry);
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    return this._append(entry);
  }

  async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
    const entry: ThinkingLevelChangeEntry = {
      type: "thinking_level_change",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    return this._append(entry);
  }

  async appendCheckpoint(checkpointId: number): Promise<string> {
    const entry: CheckpointEntry = {
      type: "checkpoint",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      checkpointId,
    };
    return this._append(entry);
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
    const entry: CustomEntry = {
      type: "custom",
      id: generateId(),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
      customType,
      data,
    };
    return this._append(entry);
  }

  // --- Tree navigation ---

  getLeafId(): string | null {
    return this._leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this._entriesById.get(id);
  }

  getEntries(): SessionEntry[] {
    return [...this._entries];
  }

  getBranch(fromId?: string | null): SessionEntry[] {
    const leafId = fromId ?? this._leafId;
    if (!leafId) return [];

    const branch: SessionEntry[] = [];
    let currentId: string | null = leafId;

    while (currentId) {
      const entry = this._entriesById.get(currentId);
      if (!entry) break;
      branch.unshift(entry);
      currentId = entry.parentId;
    }

    return branch;
  }

  getTree(): SessionTreeNode[] {
    // Build tree from entries
    const childrenMap = new Map<string | null, SessionEntry[]>();

    for (const entry of this._entries) {
      const parentId = entry.parentId;
      if (!childrenMap.has(parentId)) {
        childrenMap.set(parentId, []);
      }
      childrenMap.get(parentId)!.push(entry);
    }

    function buildNode(entry: SessionEntry): SessionTreeNode {
      const children = (childrenMap.get(entry.id) ?? []).map(buildNode);
      return { entry, children };
    }

    // Root entries have parentId === null
    const roots = childrenMap.get(null) ?? [];
    return roots.map(buildNode);
  }

  branch(branchFromId: string): void {
    if (!this._entriesById.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this._leafId = branchFromId;
  }

  // --- Context building ---

  buildSessionContext(): SessionContext {
    const branch = this.getBranch();
    return buildSessionContext(branch);
  }

  // --- Accessors ---

  getSessionId(): string {
    return this._sessionId;
  }

  // --- Internal ---

  private async _append(entry: SessionEntry): Promise<string> {
    this._entries.push(entry);
    this._entriesById.set(entry.id, entry);
    this._leafId = entry.id;

    if (this._filePath) {
      await appendJSONL(this._filePath, entry);
    }

    return entry.id;
  }

  private async _load(): Promise<void> {
    if (!this._filePath) return;

    const records = await readJSONL<SessionHeader | SessionEntry>(this._filePath);
    if (records.length === 0) return;

    // First record is header
    const header = records[0];
    if (header.type === "session") {
      this._sessionId = (header as SessionHeader).id;
    }

    // Rest are entries — validate required fields before accepting
    for (let i = 1; i < records.length; i++) {
      const entry = records[i];
      if (!this._isValidEntry(entry)) continue;
      this._entries.push(entry as SessionEntry);
      this._entriesById.set(entry.id, entry as SessionEntry);
      this._leafId = entry.id;
    }
  }

  private _isValidEntry(record: unknown): record is SessionEntry {
    if (!record || typeof record !== "object") return false;
    const r = record as Record<string, unknown>;
    return (
      typeof r.type === "string" &&
      typeof r.id === "string" &&
      typeof r.timestamp === "string"
    );
  }
}
