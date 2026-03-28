// Task graph tools — CRUD + dependency management + background execution

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../tools/types.js";
import type { TaskGraph } from "./task-graph.js";
import { TASK_GRAPH_TOOL_NAMES } from "./types.js";
import type { TaskStatus, TaskNode } from "./types.js";

export function createTaskGraphTools(graph: TaskGraph): AgentTool[] {
  return [
    {
      name: TASK_GRAPH_TOOL_NAMES.create,
      label: "Create Task",
      description:
        "Create a new task in the task graph. Tasks start as pending. " +
        "Use task_depend to set up dependency ordering.",
      parameters: Type.Object({
        subject: Type.String({ description: "Short title for the task." }),
        description: Type.Optional(Type.String({ description: "Detailed description." })),
      }),
      async execute(_id, params: { subject: string; description?: string }): Promise<AgentToolResult> {
        const task = graph.create(params.subject, params.description);
        return text(`Created task ${task.id}: ${task.subject}\n\n${graph.render()}`);
      },
    },
    {
      name: TASK_GRAPH_TOOL_NAMES.depend,
      label: "Add Task Dependency",
      description:
        "Add a dependency: task_id cannot start until blocked_by_id completes. " +
        "Rejects if this would create a cycle.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task that is blocked." }),
        blocked_by_id: Type.String({ description: "Task that must complete first." }),
      }),
      async execute(_id, params: { task_id: string; blocked_by_id: string }): Promise<AgentToolResult> {
        graph.addDependency(params.task_id, params.blocked_by_id);
        return text(`Dependency added: ${params.task_id} blocked by ${params.blocked_by_id}\n\n${graph.render()}`);
      },
    },
    {
      name: TASK_GRAPH_TOOL_NAMES.update,
      label: "Update Task",
      description:
        "Update a task's status, owner, or result. " +
        "Setting status to 'completed' auto-unblocks dependent tasks. " +
        "Cannot start a task that has unfinished blockers.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID." }),
        status: Type.Optional(Type.Union(
          [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("failed")],
          { description: "New status." },
        )),
        owner: Type.Optional(Type.String({ description: "Assign to an agent or user." })),
        result: Type.Optional(Type.String({ description: "Result summary." })),
      }),
      async execute(_id, params: { task_id: string; status?: string; owner?: string; result?: string }): Promise<AgentToolResult> {
        const task = graph.update(params.task_id, {
          status: params.status as TaskStatus | undefined,
          owner: params.owner,
          result: params.result,
        });
        return text(`Updated task ${task.id}\n\n${graph.render()}`);
      },
    },
    {
      name: TASK_GRAPH_TOOL_NAMES.list,
      label: "List Tasks",
      description: "List all tasks with their status, dependencies, and progress.",
      parameters: Type.Object({
        filter: Type.Optional(Type.Union(
          [Type.Literal("all"), Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("in_progress"), Type.Literal("completed")],
          { description: "Filter tasks by category. Default: all." },
        )),
      }),
      async execute(_id, params: { filter?: string }): Promise<AgentToolResult> {
        let tasks: TaskNode[];
        switch (params.filter) {
          case "ready": tasks = graph.listReady(); break;
          case "blocked": tasks = graph.listBlocked(); break;
          case "in_progress": tasks = graph.listAll().filter((t) => t.status === "in_progress"); break;
          case "completed": tasks = graph.listAll().filter((t) => t.status === "completed"); break;
          default: tasks = graph.listAll();
        }
        if (tasks.length === 0) return text(`No tasks matching filter: ${params.filter ?? "all"}`);
        if (!params.filter || params.filter === "all") return text(graph.render());
        const lines = tasks.map((t) => `${t.id}: ${t.subject} [${t.status}]`);
        return text(`${params.filter}: ${tasks.length} task(s)\n${lines.join("\n")}`);
      },
    },
    {
      name: TASK_GRAPH_TOOL_NAMES.get,
      label: "Get Task",
      description: "Get detailed information about a specific task.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID." }),
      }),
      async execute(_id, params: { task_id: string }): Promise<AgentToolResult> {
        const task = graph.get(params.task_id);
        if (!task) return text(`Task not found: ${params.task_id}`);
        return text(JSON.stringify(task, null, 2));
      },
    },
  ];
}

function text(t: string): AgentToolResult {
  return { content: [{ type: "text", text: t }] };
}
