// Planning tools — todo management + phase switching

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../tools/types.js";
import type { PlanningManager } from "./planning-manager.js";
import { PLANNING_TOOL_NAMES } from "./types.js";
import type { TodoStatus } from "./types.js";

export function createPlanningTools(manager: PlanningManager): AgentTool[] {
  return [
    {
      name: PLANNING_TOOL_NAMES.todo,
      label: "Todo",
      description:
        "Manage your task list. Use this tool to plan work, track progress, and stay on track. " +
        "Only one todo can be in_progress at a time. Update todos frequently to reflect your current state.",
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique ID for the todo item." }),
            text: Type.String({ description: "Description of the task." }),
            status: Type.Union(
              [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
              { description: "Task status. Only one item can be in_progress at a time." },
            ),
          }),
          { description: "The full updated todo list (replaces previous list)." },
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { items: Array<{ id: string; text: string; status: TodoStatus }> },
      ): Promise<AgentToolResult> {
        const result = manager.updateTodos(params.items);
        return { content: [{ type: "text", text: result }] };
      },
    },
    {
      name: PLANNING_TOOL_NAMES.planMode,
      label: "Plan Mode",
      description:
        "Switch between planning and execution phases. " +
        "In planning phase, only read-only tools are available — use this time to analyze and create todos. " +
        "In execution phase, all tools are available and nag reminders will prompt you to update todos.",
      parameters: Type.Object({
        action: Type.Union(
          [Type.Literal("start_execution"), Type.Literal("switch_to_planning"), Type.Literal("status")],
          { description: "Action to perform." },
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { action: "start_execution" | "switch_to_planning" | "status" },
      ): Promise<AgentToolResult> {
        let result: string;
        switch (params.action) {
          case "start_execution":
            result = manager.startExecution();
            break;
          case "switch_to_planning":
            result = manager.switchToPlanning();
            break;
          case "status":
            result = manager.render();
            break;
        }
        return { content: [{ type: "text", text: result }] };
      },
    },
  ];
}
