// Planning tools — todo management + phase switching

import { z } from "zod/v4";
import type { AgentTool, AgentToolResult, ToolResultBlockParam } from "../tools/types.js";
import { buildTool, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../tools/types.js";
import type { PlanningManager } from "./planning-manager.js";
import { PLANNING_TOOL_NAMES } from "./types.js";
import type { TodoStatus } from "./types.js";

export function createPlanningTools(manager: PlanningManager): AgentTool[] {
  return [
    buildTool({
      name: PLANNING_TOOL_NAMES.todo,
      async description() {
        return "Manage your task list. Use this tool to plan work, track progress, and stay on track. " +
          "Only one todo can be in_progress at a time. Update todos frequently to reflect your current state.";
      },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        items: z.array(
          z.strictObject({
            id: z.string().describe("Unique ID for the todo item."),
            text: z.string().describe("Description of the task."),
            status: z.union(
              [z.literal("pending"), z.literal("in_progress"), z.literal("completed")],
            ).describe("Task status. Only one item can be in_progress at a time."),
          }),
        ).describe("The full updated todo list (replaces previous list)."),
      }),
      async call(
        params: { items: Array<{ id: string; text: string; status: TodoStatus }> },
      ): Promise<AgentToolResult> {
        const result = manager.updateTodos(params.items);
        return { data: [{ type: "text", text: result }] };
      },
    }),
    buildTool({
      name: PLANNING_TOOL_NAMES.planMode,
      async description() {
        return "Switch between planning and execution phases. " +
          "In planning phase, only read-only tools are available — use this time to analyze and create todos. " +
          "In execution phase, all tools are available and nag reminders will prompt you to update todos.";
      },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        action: z.union(
          [z.literal("start_execution"), z.literal("switch_to_planning"), z.literal("status")],
        ).describe("Action to perform."),
      }),
      async call(
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
        return { data: [{ type: "text", text: result }] };
      },
    }),
  ];
}
