// Background task types

export type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed";

export interface BackgroundTaskInfo {
  id: string;
  name: string;
  status: BackgroundTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface BackgroundTaskHandle<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly status: BackgroundTaskStatus;
  readonly result?: T;
  readonly error?: Error;
  abort(): void;
}

export type BackgroundTaskEvent =
  | { type: "task_started"; task: BackgroundTaskInfo }
  | { type: "task_completed"; task: BackgroundTaskInfo; result: unknown }
  | { type: "task_failed"; task: BackgroundTaskInfo; error: string };

export type TaskFactory = (args: unknown, signal: AbortSignal) => Promise<unknown>;
