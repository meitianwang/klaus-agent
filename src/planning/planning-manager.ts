// Planning manager — two-phase planning with structured todo tracking

import type { TodoItem, TodoStatus, PlanPhase, PlanningState, PlanningConfig } from "./types.js";
import { PLANNING_TOOL_NAMES } from "./types.js";
import { generateId } from "../utils/id.js";

export class PlanningManager {
  private _state: PlanningState;
  private _config: PlanningConfig;
  private _allowedInPlanning: ReadonlySet<string>;

  constructor(config: PlanningConfig = {}) {
    this._config = config;
    const allowed = new Set(config.readOnlyTools ?? []);
    allowed.add(PLANNING_TOOL_NAMES.todo);
    allowed.add(PLANNING_TOOL_NAMES.planMode);
    this._allowedInPlanning = allowed;
    this._state = {
      phase: "planning",
      todos: [],
      roundsSinceTodoUpdate: 0,
    };
  }

  get phase(): PlanPhase {
    return this._state.phase;
  }

  get todos(): readonly Readonly<TodoItem>[] {
    return this._state.todos;
  }

  get roundsSinceTodoUpdate(): number {
    return this._state.roundsSinceTodoUpdate;
  }

  get config(): Readonly<PlanningConfig> {
    return this._config;
  }

  /** Pre-built set of tool names allowed during planning phase. */
  get allowedInPlanning(): ReadonlySet<string> {
    return this._allowedInPlanning;
  }

  // --- Phase control ---

  startExecution(): string {
    if (this._state.todos.length === 0) {
      throw new Error("Cannot start execution: no todos defined. Create a plan first.");
    }
    this._state.phase = "executing";
    this.resetRoundCounter();
    return `Switched to execution phase. ${this._state.todos.length} todo(s) to complete.\n\n${this.render()}`;
  }

  switchToPlanning(): string {
    this._state.phase = "planning";
    this.resetRoundCounter();
    return `Switched to planning phase. Tools restricted to read-only.\n\n${this.render()}`;
  }

  // --- Todo CRUD ---

  updateTodos(items: Array<{ id: string; text: string; status: TodoStatus }>): string {
    const max = this._config.maxTodos ?? 50;
    if (items.length > max) {
      throw new Error(`Too many todos: ${items.length} exceeds limit of ${max}.`);
    }

    let inProgressCount = 0;
    const validated: TodoItem[] = [];

    for (const item of items) {
      const status = item.status ?? "pending";
      if (status === "in_progress") inProgressCount++;
      validated.push({
        id: item.id || generateId(),
        text: item.text,
        status,
      });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one todo can be in_progress at a time.");
    }

    this._state.todos = validated;
    this.resetRoundCounter();
    return this.render();
  }

  // --- Render ---

  render(): string {
    if (this._state.todos.length === 0) {
      return `[phase: ${this._state.phase}] No todos.`;
    }

    const lines = this._state.todos.map((t) => {
      const icon = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      return `${icon} ${t.id}: ${t.text}`;
    });

    const done = this._state.todos.filter((t) => t.status === "completed").length;
    const total = this._state.todos.length;

    return `[phase: ${this._state.phase}] Progress: ${done}/${total}\n${lines.join("\n")}`;
  }

  // --- Nag tracking ---

  /** Call once per agent loop step (after tool execution). */
  tickRound(): void {
    this._state.roundsSinceTodoUpdate++;
  }

  /** Reset the round counter (called when the model updates todos). */
  resetRoundCounter(): void {
    this._state.roundsSinceTodoUpdate = 0;
  }

  shouldNag(): boolean {
    if (this._state.phase !== "executing") return false;
    if (this._state.todos.length === 0) return false;
    const threshold = this._config.nagAfterRounds ?? 3;
    return this._state.roundsSinceTodoUpdate >= threshold;
  }

  getNagMessage(): string {
    return this._config.nagMessage ?? "<reminder>Update your todos to reflect current progress.</reminder>";
  }
}
