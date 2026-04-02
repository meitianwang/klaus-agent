// Task graph tools — CRUD + dependency management + background execution

import { z } from "zod/v4";
import type { AgentTool, AgentToolResult, ToolResultBlockParam } from "../tools/types.js";
import { buildTool, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../tools/types.js";
import type { TaskGraph } from "./task-graph.js";
import { TASK_GRAPH_TOOL_NAMES } from "./types.js";
import type { TaskStatus, TaskNode } from "./types.js";

export function createTaskGraphTools(graph: TaskGraph): AgentTool[] {
  return [
    buildTool({
      name: TASK_GRAPH_TOOL_NAMES.create,
      async description() {
        return "Create a new task in the task graph. Tasks start as pending. " +
          "Use task_depend to set up dependency ordering.";
      },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        subject: z.string().describe("Short title for the task."),
        description: z.string().optional().describe("Detailed description."),
      }),
      async call(params: { subject: string; description?: string }): Promise<AgentToolResult> {
        const task = graph.create(params.subject, params.description);
        return text(`Created task ${task.id}: ${task.subject}\n\n${graph.render()}`);
      },
    }),
    buildTool({
      name: TASK_GRAPH_TOOL_NAMES.depend,
      async description() {
        return "Add a dependency: task_id cannot start until blocked_by_id completes. " +
          "Rejects if this would create a cycle.";
      },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        task_id: z.string().describe("Task that is blocked."),
        blocked_by_id: z.string().describe("Task that must complete first."),
      }),
      async call(params: { task_id: string; blocked_by_id: string }): Promise<AgentToolResult> {
        graph.addDependency(params.task_id, params.blocked_by_id);
        return text(`Dependency added: ${params.task_id} blocked by ${params.blocked_by_id}\n\n${graph.render()}`);
      },
    }),
    buildTool({
      name: TASK_GRAPH_TOOL_NAMES.update,
      async description() {
        return "Update a task's status, owner, or result. " +
          "Setting status to 'completed' auto-unblocks dependent tasks. " +
          "Cannot start a task that has unfinished blockers.";
      },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        task_id: z.string().describe("Task ID."),
        status: z.union(
          [z.literal("pending"), z.literal("in_progress"), z.literal("completed"), z.literal("failed")],
        ).optional().describe("New status."),
        owner: z.string().optional().describe("Assign to an agent or user."),
        result: z.string().optional().describe("Result summary."),
      }),
      async call(params: { task_id: string; status?: string; owner?: string; result?: string }): Promise<AgentToolResult> {
        const task = graph.update(params.task_id, {
          status: params.status as TaskStatus | undefined,
          owner: params.owner,
          result: params.result,
        });
        return text(`Updated task ${task.id}\n\n${graph.render()}`);
      },
    }),
    buildTool({
      name: TASK_GRAPH_TOOL_NAMES.list,
      async description() { return "List all tasks with their status, dependencies, and progress."; },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        filter: z.union(
          [z.literal("all"), z.literal("ready"), z.literal("blocked"), z.literal("in_progress"), z.literal("completed")],
        ).optional().describe("Filter tasks by category. Default: all."),
      }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call(params: { filter?: string }): Promise<AgentToolResult> {
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
    }),
    buildTool({
      name: TASK_GRAPH_TOOL_NAMES.get,
      async description() { return "Get detailed information about a specific task."; },
      async prompt() { return ""; },
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
        return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
      },
      renderToolUseMessage() { return null; },
      inputSchema: z.strictObject({
        task_id: z.string().describe("Task ID."),
      }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call(params: { task_id: string }): Promise<AgentToolResult> {
        const task = graph.get(params.task_id);
        if (!task) return text(`Task not found: ${params.task_id}`);
        return text(JSON.stringify(task, null, 2));
      },
    }),
  ] as AgentTool[];
}

function text(t: string): AgentToolResult {
  return { data: [{ type: "text", text: t }] };
}
