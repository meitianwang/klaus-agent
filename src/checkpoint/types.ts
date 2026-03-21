// Checkpoint and D-Mail types

export interface CheckpointConfig {
  enabled?: boolean;
  enableDMail?: boolean;
}

export interface DMail {
  message: string;
  checkpointId: number;
}

export interface CheckpointInfo {
  checkpointId: number;
  entryId: string;
}
