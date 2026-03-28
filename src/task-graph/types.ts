// Task graph types — dependency-aware task DAG with background execution

export const TASK_GRAPH_TOOL_NAMES = {
  create: "task_create",
  depend: "task_depend",
  update: "task_update",
  list: "task_list",
  get: "task_get",
} as const;

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TaskNode {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  /** IDs of tasks that must complete before this one can start. */
  blockedBy: string[];
  /** IDs of tasks that this task blocks (reverse edges, maintained automatically). */
  blocks: string[];
  /** Agent or user assigned to this task. */
  owner: string;
  /** Result summary after completion/failure. */
  result?: string;
  /** Background execution handle ID, if running in background. */
  backgroundId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskGraphConfig {
  /** Directory for persisting task graph to disk. If omitted, in-memory only. */
  persistDir?: string;

  /** Maximum number of tasks. Default: 100. */
  maxTasks?: number;

  /**
   * Auto-inject completed background task results before each LLM call.
   * Default: true.
   */
  autoInjectResults?: boolean;
}

export interface CompletedTaskResult {
  taskId: string;
  subject: string;
  result: string;
  status: "completed" | "failed";
  unblockedTasks: string[];
}
