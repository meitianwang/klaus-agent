// Planning module types — two-phase planning + structured todo tracking

export const PLANNING_TOOL_NAMES = {
  todo: "todo",
  planMode: "plan_mode",
} as const;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export type PlanPhase = "planning" | "executing";

export interface PlanningState {
  phase: PlanPhase;
  todos: TodoItem[];
  roundsSinceTodoUpdate: number;
}

export interface PlanningConfig {
  /**
   * Tool names allowed during the planning phase (read-only tools).
   * If omitted or empty, all tools are available during planning
   * (phase separation is advisory only via system prompt).
   */
  readOnlyTools?: string[];

  /** Number of rounds without a todo update before injecting a nag reminder. Default: 3. */
  nagAfterRounds?: number;

  /** Custom nag reminder text. */
  nagMessage?: string;

  /** Maximum number of todo items. Default: 50. */
  maxTodos?: number;
}
