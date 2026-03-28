// Google Gemini LLM provider

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Content, Part, FunctionDeclaration } from "@google/generative-ai";
import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
  Message,
} from "../llm/types.js";
import { generateId } from "../utils/id.js";
import { withRetry, RETRYABLE_PATTERNS, mapThinkingBudget } from "./shared.js";

export class GeminiProvider implements LLMProvider {
  private client: GoogleGenerativeAI;
  private baseUrl?: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new GoogleGenerativeAI(apiKey || process.env.GOOGLE_API_KEY || "");
    this.baseUrl = baseUrl;
  }

  async *stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    yield* withRetry(() => this._streamOnce(options), RETRYABLE_PATTERNS.google);
  }

  private async *_streamOnce(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    const { model: modelId, systemPrompt, messages, tools, thinkingLevel, maxTokens, signal } = options;

    const thinkingBudget = mapThinkingBudget(thinkingLevel);

    const genModel = this.client.getGenerativeModel(
      {
        model: modelId,
        systemInstruction: systemPrompt,
        ...(tools?.length ? {
          tools: [{
            functionDeclarations: tools.map((t): FunctionDeclaration => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as any,
            })),
          }],
        } : {}),
        generationConfig: {
          maxOutputTokens: maxTokens ?? 8192,
          ...(thinkingBudget ? {
            thinkingConfig: { thinkingBudget },
          } as Record<string, unknown> : {}),
        },
      },
      this.baseUrl ? { baseUrl: this.baseUrl } : undefined,
    );

    const contents = mapMessages(messages);
    const result = await genModel.generateContentStream({ contents }, { signal });

    const contentBlocks: AssistantContentBlock[] = [];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for await (const chunk of result.stream) {
      const text = chunk.text?.();
      if (text) {
        if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== "text") {
          contentBlocks.push({ type: "text", text: "" });
        }
        const block = contentBlocks[contentBlocks.length - 1];
        if (block.type === "text") {
          block.text += text;
        }
        yield { type: "text", text };
      }

      // Function calls (Gemini returns them complete, not streamed)
      const fnCalls = chunk.functionCalls?.();
      if (fnCalls) {
        for (const fc of fnCalls) {
          const id = generateId();
          const input = (fc.args ?? {}) as Record<string, unknown>;
          contentBlocks.push({ type: "tool_call", id, name: fc.name, input });
          yield { type: "tool_call_start", id, name: fc.name };
          yield { type: "tool_call_delta", id, input: JSON.stringify(input) };
        }
      }

      // Usage
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
        };
      }
    }

    const message: AssistantMessage = { role: "assistant", content: contentBlocks };
    yield { type: "done", message, usage };
  }
}

function mapMessages(messages: Message[]): Content[] {
  const contents: Content[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const parts: Part[] = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else {
        for (const block of m.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "image" && block.source.type === "base64") {
            parts.push({
              inlineData: { mimeType: block.source.mediaType, data: block.source.data },
            });
          }
        }
      }
      contents.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const parts: Part[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_call") {
          parts.push({
            functionCall: { name: block.name, args: block.input },
          });
        } else if (block.type === "thinking") {
          parts.push({ text: block.thinking });
        }
      }
      contents.push({ role: "model", parts });
    } else {
      // tool_result → functionResponse
      // Need to find the tool name from previous assistant messages
      const toolName = findToolName(messages, m.toolCallId) ?? "unknown";
      const responseContent = typeof m.content === "string"
        ? m.content
        : m.content.map((b) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n");
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: toolName,
            response: { content: responseContent },
          },
        }],
      });
    }
  }

  return contents;
}

function findToolName(messages: Message[], toolCallId: string): string | undefined {
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const block of m.content) {
        if (block.type === "tool_call" && block.id === toolCallId) {
          return block.name;
        }
      }
    }
  }
  return undefined;
}
