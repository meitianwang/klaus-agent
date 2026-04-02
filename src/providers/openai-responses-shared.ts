// Shared types and utilities for OpenAI Responses API providers (openai-responses, openai-codex)

import type { Message, ToolDefinition, ToolResultBlock } from "../llm/types.js";

// --- Types ---

export type ResponseInput = ResponseInputItem[];

export type ResponseInputItem =
  | { type: "message"; role: "user" | "assistant"; content: ResponseContent[] }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponseContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export interface ResponseTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: null;
}

// --- Message conversion ---

export function mapMessages(messages: Message[]): ResponseInput {
  const input: ResponseInput = [];

  for (const m of messages) {
    if (m.role === "user") {
      const content: ResponseContent[] = [];
      const toolResults: ResponseInputItem[] = [];
      if (typeof m.content === "string") {
        content.push({ type: "input_text", text: m.content });
      } else {
        for (const block of m.content) {
          if (block.type === "text") {
            content.push({ type: "input_text", text: block.text });
          } else if (block.type === "image") {
            const url = block.source.type === "url"
              ? block.source.url
              : `data:${block.source.mediaType};base64,${block.source.data}`;
            content.push({ type: "input_image", image_url: url });
          } else if (block.type === "tool_result") {
            const trb = block as ToolResultBlock;
            const output = typeof trb.content === "string"
              ? trb.content
              : trb.content.map((b) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n");
            toolResults.push({
              type: "function_call_output",
              call_id: trb.tool_use_id,
              output,
            });
          }
        }
      }
      // Emit tool results before any regular user content
      for (const tr of toolResults) {
        input.push(tr);
      }
      if (content.length > 0) {
        input.push({ type: "message", role: "user", content });
      }
    } else if (m.role === "assistant") {
      const content: ResponseContent[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          content.push({ type: "output_text", text: block.text });
        } else if (block.type === "tool_use") {
          // Flush accumulated text before the tool call
          if (content.length > 0) {
            input.push({ type: "message", role: "assistant", content: [...content] });
            content.length = 0;
          }
          input.push({
            type: "function_call",
            id: block.id,
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
      // Remaining text content
      if (content.length > 0) {
        input.push({ type: "message", role: "assistant", content });
      }
    }
  }

  return input;
}

export function mapTools(tools: ToolDefinition[]): ResponseTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: null,
  }));
}
