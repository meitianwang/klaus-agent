// DenwaRenji — D-Mail state machine (from Kimi, adapted to tree sessions)

import type { DMail } from "./types.js";

export class DenwaRenji {
  private _pendingDMail: DMail | null = null;
  private _checkpointCount = 0;

  sendDMail(message: string, checkpointId: number): void {
    if (checkpointId < 0 || checkpointId >= this._checkpointCount) {
      throw new Error(
        `Invalid checkpoint ID ${checkpointId}. Valid range: 0-${this._checkpointCount - 1}`,
      );
    }
    this._pendingDMail = { message, checkpointId };
  }

  setCheckpointCount(n: number): void {
    this._checkpointCount = n;
  }

  getCheckpointCount(): number {
    return this._checkpointCount;
  }

  fetchPendingDMail(): DMail | null {
    const dmail = this._pendingDMail;
    this._pendingDMail = null;
    return dmail;
  }

  hasPendingDMail(): boolean {
    return this._pendingDMail !== null;
  }
}
