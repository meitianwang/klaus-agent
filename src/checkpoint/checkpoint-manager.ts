// Checkpoint manager — creates checkpoints in session tree, handles D-Mail revert

import type { SessionManager } from "../session/session-manager.js";
import type { CheckpointInfo } from "./types.js";
import { DenwaRenji } from "./dmail.js";

export class CheckpointManager {
  private _checkpoints: CheckpointInfo[] = [];
  private _nextId = 0; // Global counter, never resets after D-Mail
  private _denwaRenji = new DenwaRenji();

  constructor(private _session: SessionManager) {}

  get denwaRenji(): DenwaRenji {
    return this._denwaRenji;
  }

  async checkpoint(): Promise<CheckpointInfo> {
    const checkpointId = this._nextId++;
    const entryId = await this._session.appendCheckpoint(checkpointId);

    const info: CheckpointInfo = { checkpointId, entryId };
    this._checkpoints.push(info);
    this._denwaRenji.setCheckpointCount(this._checkpoints.length);

    return info;
  }

  getCheckpoint(checkpointId: number): CheckpointInfo | undefined {
    return this._checkpoints.find((cp) => cp.checkpointId === checkpointId);
  }

  getAllCheckpoints(): CheckpointInfo[] {
    return [...this._checkpoints];
  }

  /**
   * Handle D-Mail: branch from the target checkpoint and inject the message.
   * Returns the D-Mail content if one was pending, null otherwise.
   */
  async handleDMail(): Promise<string | null> {
    const dmail = this._denwaRenji.fetchPendingDMail();
    if (!dmail) return null;

    const checkpoint = this._checkpoints.find((cp) => cp.checkpointId === dmail.checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${dmail.checkpointId} not found`);
    }

    // Branch session tree back to checkpoint entry
    this._session.branch(checkpoint.entryId);

    // Remove checkpoints after the target (keep target itself)
    const targetIdx = this._checkpoints.indexOf(checkpoint);
    this._checkpoints.length = targetIdx + 1;
    this._denwaRenji.setCheckpointCount(this._checkpoints.length);

    return dmail.message;
  }
}
