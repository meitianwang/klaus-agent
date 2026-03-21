// Built-in background task tools — allows LLM to manage background tasks

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, ToolExecutionContext } from "../tools/types.js";
import type { BackgroundTaskManager } from "./task-manager.js";
import type { TaskFactory } from "./types.js";

export function createBackgroundTaskTools(
  manager: BackgroundTaskManager,
  factories?: Record<string, TaskFactory>,
): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "check_task_status",
      label: "Check Task Status",
      description: "Check the status of background tasks. If no task_id is provided, returns all tasks.",
      parameters: Type.Object({
        task_id: Type.Optional(Type.String({ description: "Task ID to check. Omit to list all tasks." })),
      }),
      async execute(_toolCallId: string, params: { task_id?: string }): Promise<AgentToolResult> {
        if (params.task_id) {
          const handle = manager.get(params.task_id);
          if (!handle) {
            return { content: [{ type: "text", text: `No task found with ID: ${params.task_id}` }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ id: handle.id, name: handle.name, status: handle.status }, null, 2) }] };
        }
        const tasks = manager.list();
        if (tasks.length === 0) {
          return { content: [{ type: "text", text: "No background tasks." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      },
    },
    {
      name: "get_task_result",
      label: "Get Task Result",
      description: "Get the result of a completed background task.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID to get the result for." }),
      }),
      async execute(_toolCallId: string, params: { task_id: string }): Promise<AgentToolResult> {
        const handle = manager.get(params.task_id);
        if (!handle) {
          return { content: [{ type: "text", text: `No task found with ID: ${params.task_id}` }] };
        }
        if (handle.status === "running") {
          return { content: [{ type: "text", text: `Task "${handle.name}" is still running.` }] };
        }
        if (handle.status === "failed") {
          return { content: [{ type: "text", text: `Task "${handle.name}" failed: ${handle.error?.message ?? "unknown error"}` }] };
        }
        const resultText = handle.result !== undefined ? JSON.stringify(handle.result, null, 2) : "(no result)";
        return { content: [{ type: "text", text: resultText }] };
      },
    },
  ];

  if (factories && Object.keys(factories).length > 0) {
    const names = Object.keys(factories);
    const description = `Start a background task. Available tasks:\n${names.map((n) => `- ${n}`).join("\n")}`;

    tools.push({
      name: "start_background_task",
      label: "Start Background Task",
      description,
      parameters: Type.Object({
        task_name: Type.String({ description: "Name of the task to start." }),
        args: Type.Optional(Type.Unknown({ description: "Arguments to pass to the task." })),
      }),
      async execute(_toolCallId: string, params: { task_name: string; args?: unknown }): Promise<AgentToolResult> {
        const factory = factories[params.task_name];
        if (!factory) {
          const available = Object.keys(factories).join(", ");
          return { content: [{ type: "text", text: `Unknown task: "${params.task_name}". Available: ${available}` }] };
        }
        const handle = manager.spawn(params.task_name, (signal) => factory(params.args, signal));
        return { content: [{ type: "text", text: `Task started: ${handle.name} (ID: ${handle.id})` }] };
      },
    });
  }

  return tools;
}
