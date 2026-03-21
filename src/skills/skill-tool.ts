// Built-in InvokeSkillTool — allows LLM to invoke discovered skills

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, ToolExecutionContext } from "../tools/types.js";
import type { Skill } from "./types.js";
import { renderSkillTemplate } from "./loader.js";

export function createInvokeSkillTool(skills: Skill[]): AgentTool {
  const skillMap = new Map(skills.map((s) => [s.name, s]));

  return {
    name: "invoke_skill",
    label: "Invoke Skill",
    description: buildSkillToolDescription(skills),
    parameters: Type.Object({
      skill: Type.String({ description: "Name of the skill to invoke" }),
      variables: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Template variables" })),
    }),

    async execute(
      toolCallId: string,
      params: { skill: string; variables?: Record<string, string> },
      context: ToolExecutionContext,
    ): Promise<AgentToolResult> {
      const skill = skillMap.get(params.skill);
      if (!skill) {
        const available = [...skillMap.keys()].join(", ");
        return {
          content: [{ type: "text", text: `Unknown skill: "${params.skill}". Available: ${available || "none"}` }],
        };
      }

      const rendered = params.variables
        ? renderSkillTemplate(skill.content, params.variables)
        : skill.content;

      return {
        content: [{ type: "text", text: rendered }],
      };
    },
  };
}

function buildSkillToolDescription(skills: Skill[]): string {
  if (skills.length === 0) {
    return "Invoke a skill by name.";
  }
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `Invoke a skill to get specialized instructions. Available skills:\n${list}`;
}
