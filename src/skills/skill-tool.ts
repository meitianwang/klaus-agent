// Built-in InvokeSkillTool — allows LLM to invoke discovered skills

import { z } from "zod/v4";
import type { AgentTool, AgentToolResult, ToolResultBlockParam } from "../tools/types.js";
import { buildTool, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../tools/types.js";
import type { Skill } from "./types.js";
import { renderSkillTemplate } from "./loader.js";

export function createInvokeSkillTool(skills: Skill[]): AgentTool {
  const skillMap = new Map(skills.map((s) => [s.name, s]));

  return buildTool({
    name: "invoke_skill",
    async description() { return buildSkillToolDescription(skills); },
    async prompt() { return ""; },
    maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string): ToolResultBlockParam {
      return { type: "tool_result" as const, tool_use_id: toolUseID, content: typeof content === "string" ? content : JSON.stringify(content) };
    },
    renderToolUseMessage() { return null; },
    inputSchema: z.strictObject({
      skill: z.string().describe("Name of the skill to invoke"),
      variables: z.record(z.string(), z.string()).optional().describe("Template variables"),
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,

    async call(
      params: { skill: string; variables?: Record<string, string> },
    ): Promise<AgentToolResult> {
      const skill = skillMap.get(params.skill);
      if (!skill) {
        const available = [...skillMap.keys()].join(", ");
        return {
          data: [{ type: "text", text: `Unknown skill: "${params.skill}". Available: ${available || "none"}` }],
        };
      }

      const rendered = params.variables
        ? renderSkillTemplate(skill.content, params.variables)
        : skill.content;

      return {
        data: [{ type: "text", text: rendered }],
      };
    },
  }) as AgentTool;
}

function buildSkillToolDescription(skills: Skill[]): string {
  if (skills.length === 0) {
    return "Invoke a skill by name.";
  }
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `Invoke a skill to get specialized instructions. Available skills:\n${list}`;
}
