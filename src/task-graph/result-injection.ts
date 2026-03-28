// Auto-inject completed background task results before each LLM call

import type { DynamicInjectionProvider, DynamicInjection } from "../injection/types.js";
import type { AgentMessage } from "../types.js";
import type { TaskGraph } from "./task-graph.js";

export class TaskResultInjectionProvider implements DynamicInjectionProvider {
  constructor(private _graph: TaskGraph) {}

  async getInjections(_history: AgentMessage[]): Promise<DynamicInjection[]> {
    const completed = this._graph.drainCompleted();
    if (completed.length === 0) return [];

    const lines = completed.map((c) => {
      const status = c.status === "completed" ? "completed" : "FAILED";
      const unblocked = c.unblockedTasks.length > 0
        ? ` → unblocked: ${c.unblockedTasks.join(", ")}`
        : "";
      return `[task:${c.taskId}] ${c.subject} — ${status}: ${c.result}${unblocked}`;
    });

    return [
      {
        type: "task-results",
        content: `<background-results>\n${lines.join("\n")}\n</background-results>`,
      },
    ];
  }
}
