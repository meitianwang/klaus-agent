// Task graph — dependency-aware DAG with background execution and auto-unlock

import { readFileSync, mkdirSync, existsSync } from "fs";
import { writeFile, rename } from "fs/promises";
import { join } from "path";
import { generateId } from "../utils/id.js";
import type { TaskNode, TaskStatus, TaskGraphConfig, CompletedTaskResult } from "./types.js";

export class TaskGraph {
  private _tasks = new Map<string, TaskNode>();
  private _config: TaskGraphConfig;
  private _completedQueue: CompletedTaskResult[] = [];
  private _backgroundAborts = new Map<string, AbortController>();

  constructor(config: TaskGraphConfig = {}) {
    this._config = config;
    if (config.persistDir) {
      mkdirSync(config.persistDir, { recursive: true });
      this._loadFromDisk();
    }
  }


  get(id: string): TaskNode | undefined {
    const task = this._tasks.get(id);
    return task ? { ...task, blockedBy: [...task.blockedBy], blocks: [...task.blocks] } : undefined;
  }

  listAll(): TaskNode[] {
    return [...this._tasks.values()].map((t) => ({
      ...t,
      blockedBy: [...t.blockedBy],
      blocks: [...t.blocks],
    }));
  }

  /** Tasks that are pending with no unfinished blockers. */
  listReady(): TaskNode[] {
    return this.listAll().filter(
      (t) => t.status === "pending" && t.blockedBy.length === 0,
    );
  }

  /** Tasks waiting on unfinished blockers. */
  listBlocked(): TaskNode[] {
    return this.listAll().filter(
      (t) => t.status === "pending" && t.blockedBy.length > 0,
    );
  }


  create(subject: string, description = ""): TaskNode {
    const max = this._config.maxTasks ?? 100;
    if (this._tasks.size >= max) {
      throw new Error(`Task limit reached: ${max}.`);
    }

    const node: TaskNode = {
      id: generateId(),
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._tasks.set(node.id, node);
    this._persist();
    return { ...node, blockedBy: [...node.blockedBy], blocks: [...node.blocks] };
  }

  /** Add a dependency: `taskId` is blocked by `blockedById`. */
  addDependency(taskId: string, blockedById: string): void {
    const task = this._require(taskId);
    const blocker = this._require(blockedById);

    if (task.blockedBy.includes(blockedById)) return;

    // Cycle detection: if blocker is (transitively) blocked by task, adding this edge creates a cycle
    if (this._isTransitivelyBlockedBy(blockedById, taskId)) {
      throw new Error(`Adding dependency ${blockedById} → ${taskId} would create a cycle.`);
    }

    task.blockedBy.push(blockedById);
    blocker.blocks.push(taskId);
    task.updatedAt = Date.now();
    blocker.updatedAt = Date.now();
    this._persist();
  }

  update(taskId: string, fields: { status?: TaskStatus; owner?: string; result?: string }): TaskNode {
    const task = this._require(taskId);

    if (fields.status !== undefined && fields.status !== task.status) {
      if (fields.status === "in_progress" && task.blockedBy.length > 0) {
        throw new Error(`Task ${taskId} is blocked by: ${task.blockedBy.join(", ")}`);
      }
      task.status = fields.status;

      if (fields.status === "completed" || fields.status === "failed") {
        task.result = fields.result ?? task.result;
        const unblocked = this._clearDependency(taskId);

        this._completedQueue.push({
          taskId,
          subject: task.subject,
          result: task.result ?? "",
          status: fields.status,
          unblockedTasks: unblocked,
        });
      }
    }

    if (fields.owner !== undefined) task.owner = fields.owner;
    // result is already set inside the completion branch above; only apply here for non-completion updates
    if (fields.result !== undefined && task.status !== "completed" && task.status !== "failed") {
      task.result = fields.result;
    }
    task.updatedAt = Date.now();
    this._persist();
    return { ...task, blockedBy: [...task.blockedBy], blocks: [...task.blocks] };
  }


  /**
   * Run an async function in the background for a task.
   * Auto-updates task status to in_progress/completed/failed.
   */
  runBackground(
    taskId: string,
    fn: (signal: AbortSignal) => Promise<string>,
  ): void {
    const task = this._require(taskId);
    if (task.blockedBy.length > 0) {
      throw new Error(`Task ${taskId} is blocked by: ${task.blockedBy.join(", ")}`);
    }

    const ac = new AbortController();
    const bgId = generateId();
    task.status = "in_progress";
    task.backgroundId = bgId;
    task.updatedAt = Date.now();
    this._backgroundAborts.set(bgId, ac);
    this._persist();

    fn(ac.signal).then(
      (result) => {
        this._backgroundAborts.delete(bgId);
        try { this.update(taskId, { status: "completed", result }); } catch { /* task may have been removed */ }
      },
      (err) => {
        this._backgroundAborts.delete(bgId);
        try {
          this.update(taskId, {
            status: "failed",
            result: err instanceof Error ? err.message : String(err),
          });
        } catch { /* task may have been removed */ }
      },
    );
  }

  abortBackground(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task?.backgroundId) return false;
    const ac = this._backgroundAborts.get(task.backgroundId);
    if (!ac) return false;
    ac.abort();
    return true;
  }


  drainCompleted(): CompletedTaskResult[] {
    const results = [...this._completedQueue];
    this._completedQueue = [];
    return results;
  }


  render(): string {
    const tasks = this.listAll();
    if (tasks.length === 0) return "No tasks.";

    const lines = tasks.map((t) => {
      const icon = t.status === "completed" ? "[x]"
        : t.status === "failed" ? "[!]"
        : t.status === "in_progress" ? "[>]"
        : t.blockedBy.length > 0 ? "[~]"
        : "[ ]";
      const deps = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      return `${icon} ${t.id}: ${t.subject}${deps}`;
    });

    const done = tasks.filter((t) => t.status === "completed").length;
    const ready = tasks.filter((t) => t.status === "pending" && t.blockedBy.length === 0).length;
    return `Tasks: ${done}/${tasks.length} done, ${ready} ready\n${lines.join("\n")}`;
  }

  dispose(): void {
    for (const ac of this._backgroundAborts.values()) {
      ac.abort();
    }
    this._backgroundAborts.clear();
  }


  private _require(id: string): TaskNode {
    const task = this._tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  /** Remove completedId from all tasks' blockedBy. Returns IDs of newly unblocked tasks. */
  private _clearDependency(completedId: string): string[] {
    const completed = this._tasks.get(completedId);
    if (!completed) return [];

    const unblocked: string[] = [];
    for (const dependentId of completed.blocks) {
      const task = this._tasks.get(dependentId);
      if (!task) continue;
      const idx = task.blockedBy.indexOf(completedId);
      if (idx !== -1) {
        task.blockedBy.splice(idx, 1);
        if (task.blockedBy.length === 0 && task.status === "pending") {
          unblocked.push(task.id);
        }
      }
    }
    return unblocked;
  }

  /** Check if `taskId` is transitively blocked by `targetId`. */
  private _isTransitivelyBlockedBy(taskId: string, targetId: string): boolean {
    const visited = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = this._tasks.get(current);
      if (node) stack.push(...node.blockedBy);
    }
    return false;
  }

  private _persistPromise: Promise<void> = Promise.resolve();

  private _persist(): void {
    if (!this._config.persistDir) return;
    const dir = this._config.persistDir;
    const tasks = [...this._tasks.values()];
    this._persistPromise = this._persistPromise
      .then(() => {
        const data = JSON.stringify(tasks, null, 2);
        const target = join(dir, "tasks.json");
        const tmp = target + ".tmp";
        return writeFile(tmp, data, "utf-8").then(() => rename(tmp, target));
      })
      .catch(() => { /* persist failure is non-fatal */ });
  }

  private _loadFromDisk(): void {
    if (!this._config.persistDir) return;
    const filePath = join(this._config.persistDir, "tasks.json");
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (!Array.isArray(raw)) return;
      for (const entry of raw) {
        if (!this._isValidTaskNode(entry)) continue;
        this._tasks.set(entry.id, entry as TaskNode);
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  private static readonly _validStatuses = new Set(["pending", "in_progress", "completed", "failed"]);

  private _isValidTaskNode(entry: unknown): entry is TaskNode {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.id === "string" &&
      typeof e.subject === "string" &&
      typeof e.status === "string" &&
      TaskGraph._validStatuses.has(e.status as string) &&
      Array.isArray(e.blockedBy) &&
      Array.isArray(e.blocks) &&
      typeof e.createdAt === "number" &&
      typeof e.updatedAt === "number"
    );
  }
}
