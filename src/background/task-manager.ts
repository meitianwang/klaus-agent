// Background task manager — in-process async task execution

import { generateId } from "../utils/id.js";
import type { BackgroundTaskStatus, BackgroundTaskInfo, BackgroundTaskHandle, BackgroundTaskEvent } from "./types.js";

interface InternalTask {
  id: string;
  name: string;
  status: BackgroundTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: Error;
  abortController: AbortController;
}

export class BackgroundTaskManager {
  private _tasks = new Map<string, InternalTask>();
  private _onEvent?: (event: BackgroundTaskEvent) => void;

  constructor(onEvent?: (event: BackgroundTaskEvent) => void) {
    this._onEvent = onEvent;
  }

  spawn<T>(name: string, fn: (signal: AbortSignal) => Promise<T>): BackgroundTaskHandle<T> {
    const id = generateId();
    const abortController = new AbortController();
    const now = Date.now();

    const task: InternalTask = {
      id,
      name,
      status: "running",
      createdAt: now,
      startedAt: now,
      abortController,
    };

    this._tasks.set(id, task);
    this._onEvent?.({ type: "task_started", task: this._toInfo(task) });

    fn(abortController.signal).then(
      (result) => {
        task.status = "completed";
        task.completedAt = Date.now();
        task.result = result;
        try { this._onEvent?.({ type: "task_completed", task: this._toInfo(task), result }); } catch {}
      },
      (err) => {
        task.status = "failed";
        task.completedAt = Date.now();
        task.error = err instanceof Error ? err : new Error(String(err));
        try { this._onEvent?.({ type: "task_failed", task: this._toInfo(task), error: task.error.message }); } catch {}
      },
    );

    return this._toHandle<T>(task);
  }

  get(id: string): BackgroundTaskHandle | undefined {
    const task = this._tasks.get(id);
    return task ? this._toHandle(task) : undefined;
  }

  list(): BackgroundTaskInfo[] {
    return [...this._tasks.values()].map((t) => this._toInfo(t));
  }

  abort(id: string): boolean {
    const task = this._tasks.get(id);
    if (!task || task.status !== "running") return false;
    task.abortController.abort();
    return true;
  }

  abortAll(): void {
    for (const task of this._tasks.values()) {
      if (task.status === "running") {
        task.abortController.abort();
      }
    }
  }

  dispose(): void {
    this.abortAll();
    this._tasks.clear();
  }

  private _toInfo(task: InternalTask): BackgroundTaskInfo {
    return {
      id: task.id,
      name: task.name,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error?.message,
    };
  }

  private _toHandle<T>(task: InternalTask): BackgroundTaskHandle<T> {
    return {
      get id() { return task.id; },
      get name() { return task.name; },
      get status() { return task.status; },
      get result() { return task.result as T | undefined; },
      get error() { return task.error; },
      abort: () => task.abortController.abort(),
    };
  }
}
