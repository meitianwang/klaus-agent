// Built-in TaskTool — allows LLM to delegate work to subagents

import { z } from "zod/v4";
import type { AgentTool, AgentToolResult, ToolResultBlockParam } from "../tools/types.js";
import { buildTool, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../tools/types.js";
import type { LaborMarket } from "./labor-market.js";
import type { TaskExecutor } from "./task-executor.js";

export function createTaskTool(laborMarket: LaborMarket, taskExecutor: TaskExecutor): AgentTool {
  return buildTool({
    name: "delegate_task",
    async description() { return buildTaskToolDescription(laborMarket); },
    async prompt() { return ""; },
    maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
      return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
    },
    renderToolUseMessage() { return null; },
    inputSchema: z.strictObject({
      subagent: z.string().describe("Name of the subagent to delegate to"),
      prompt: z.string().describe("The task prompt for the subagent"),
    }),

    async call(
      params: { subagent: string; prompt: string },
    ): Promise<AgentToolResult> {
      const { subagent, prompt } = params;

      if (!laborMarket.has(subagent)) {
        const available = laborMarket.listAll().map((s) => s.name).join(", ");
        return {
          data: [{ type: "text", text: `Unknown subagent: "${subagent}". Available: ${available || "none"}` }],
        };
      }

      try {
        const result = await taskExecutor.execute(subagent, prompt);
        const responseText = result.lastAssistantMessage?.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n") ?? "(no response)";

        return {
          data: [{ type: "text", text: responseText }],
        };
      } catch (err) {
        return {
          data: [{ type: "text", text: `Subagent error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  }) as AgentTool;
}

function buildTaskToolDescription(laborMarket: LaborMarket): string {
  const agents = laborMarket.listAll();
  if (agents.length === 0) {
    return "Delegate a task to a subagent.";
  }
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return `Delegate a task to a subagent. Available subagents:\n${list}`;
}
