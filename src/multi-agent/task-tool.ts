// Built-in TaskTool — allows LLM to delegate work to subagents

import { Type, type TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, ToolExecutionContext } from "../tools/types.js";
import type { LaborMarket } from "./labor-market.js";
import type { TaskExecutor } from "./task-executor.js";

export function createTaskTool(laborMarket: LaborMarket, taskExecutor: TaskExecutor): AgentTool {
  return {
    name: "delegate_task",
    label: "Delegate Task",
    description: buildTaskToolDescription(laborMarket),
    parameters: Type.Object({
      subagent: Type.String({ description: "Name of the subagent to delegate to" }),
      prompt: Type.String({ description: "The task prompt for the subagent" }),
    }),

    async execute(
      toolCallId: string,
      params: { subagent: string; prompt: string },
      context: ToolExecutionContext,
    ): Promise<AgentToolResult> {
      const { subagent, prompt } = params;

      if (!laborMarket.has(subagent)) {
        const available = laborMarket.listAll().map((s) => s.name).join(", ");
        return {
          content: [{ type: "text", text: `Unknown subagent: "${subagent}". Available: ${available || "none"}` }],
        };
      }

      try {
        const result = await taskExecutor.execute(subagent, prompt);
        const responseText = result.lastAssistantMessage?.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n") ?? "(no response)";

        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Subagent error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  };
}

function buildTaskToolDescription(laborMarket: LaborMarket): string {
  const agents = laborMarket.listAll();
  if (agents.length === 0) {
    return "Delegate a task to a subagent.";
  }
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return `Delegate a task to a subagent. Available subagents:\n${list}`;
}
