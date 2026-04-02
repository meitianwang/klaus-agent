// Built-in background task tools — allows LLM to manage background tasks

import { z } from "zod/v4";
import type { AgentTool, AgentToolResult, ToolResultBlockParam } from "../tools/types.js";
import { buildTool, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../tools/types.js";
import type { BackgroundTaskManager } from "./task-manager.js";
import type { TaskFactory } from "./types.js";

export function createBackgroundTaskTools(
  manager: BackgroundTaskManager,
  factories?: Record<string, TaskFactory>,
): AgentTool[] {
  const tools: AgentTool[] = [
    buildTool({
      name: "check_task_status",
      async description() { return "Check the status of background tasks. If no task_id is provided, returns all tasks."; },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        task_id: z.string().optional().describe("Task ID to check. Omit to list all tasks."),
      }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call(params: { task_id?: string }): Promise<AgentToolResult> {
        if (params.task_id) {
          const handle = manager.get(params.task_id);
          if (!handle) {
            return { data: [{ type: "text", text: `No task found with ID: ${params.task_id}` }] };
          }
          return { data: [{ type: "text", text: JSON.stringify({ id: handle.id, name: handle.name, status: handle.status }, null, 2) }] };
        }
        const tasks = manager.list();
        if (tasks.length === 0) {
          return { data: [{ type: "text", text: "No background tasks." }] };
        }
        return { data: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      },
    }),
    buildTool({
      name: "get_task_result",
      async description() { return "Get the result of a completed background task."; },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        task_id: z.string().describe("Task ID to get the result for."),
      }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call(params: { task_id: string }): Promise<AgentToolResult> {
        const handle = manager.get(params.task_id);
        if (!handle) {
          return { data: [{ type: "text", text: `No task found with ID: ${params.task_id}` }] };
        }
        if (handle.status === "running") {
          return { data: [{ type: "text", text: `Task "${handle.name}" is still running.` }] };
        }
        if (handle.status === "failed") {
          return { data: [{ type: "text", text: `Task "${handle.name}" failed: ${handle.error?.message ?? "unknown error"}` }] };
        }
        const resultText = handle.result !== undefined ? JSON.stringify(handle.result, null, 2) : "(no result)";
        return { data: [{ type: "text", text: resultText }] };
      },
    }),
  ];

  if (factories && Object.keys(factories).length > 0) {
    const names = Object.keys(factories);
    const description = `Start a background task. Available tasks:\n${names.map((n) => `- ${n}`).join("\n")}`;

    tools.push(buildTool({
      name: "start_background_task",
      async description() { return description; },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        task_name: z.string().describe("Name of the task to start."),
        args: z.unknown().optional().describe("Arguments to pass to the task."),
      }),
      async call(params: { task_name: string; args?: unknown }): Promise<AgentToolResult> {
        const factory = factories[params.task_name];
        if (!factory) {
          const available = Object.keys(factories).join(", ");
          return { data: [{ type: "text", text: `Unknown task: "${params.task_name}". Available: ${available}` }] };
        }
        const handle = manager.spawn(params.task_name, (signal) => factory(params.args, signal));
        return { data: [{ type: "text", text: `Task started: ${handle.name} (ID: ${handle.id})` }] };
      },
    }));
  }

  return tools;
}
