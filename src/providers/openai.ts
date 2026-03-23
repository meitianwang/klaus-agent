// OpenAI LLM provider

import OpenAI from "openai";
import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
  ThinkingLevel,
  Message,
} from "../llm/types.js";
import { withRetry, RETRYABLE_PATTERNS } from "./shared.js";

function mapReasoningEffort(level?: ThinkingLevel): "low" | "medium" | "high" | undefined {
  if (!level || level === "off") return undefined;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  return "high";
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  async *stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    yield* withRetry(() => this._streamOnce(options), RETRYABLE_PATTERNS.openai);
  }

  private async *_streamOnce(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, signal } = options;

    const reasoningEffort = mapReasoningEffort(thinkingLevel);

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        ...messages.map((m) => mapMessage(m)),
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens ?? 8192,
      ...(tools?.length ? {
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };

    const contentBlocks: AssistantContentBlock[] = [];
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const stream = await this.client.chat.completions.create(params, { signal });

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];

      if (choice?.delta) {
        const delta = choice.delta;

        // Text
        if (delta.content) {
          if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== "text") {
            contentBlocks.push({ type: "text", text: "" });
          }
          const block = contentBlocks[contentBlocks.length - 1];
          if (block.type === "text") {
            block.text += delta.content;
          }
          yield { type: "text", text: delta.content };
        }

        // Reasoning/thinking content (o1/o3 series)
        if ((delta as any).reasoning_content) {
          const thinking = (delta as any).reasoning_content as string;
          if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== "thinking") {
            contentBlocks.push({ type: "thinking", thinking: "" });
          }
          const block = contentBlocks[contentBlocks.length - 1];
          if (block.type === "thinking") {
            block.thinking += thinking;
          }
          yield { type: "thinking", thinking };
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls.has(idx)) {
              // New tool call
              const id = tc.id ?? `call_${idx}`;
              const name = tc.function?.name ?? "";
              toolCalls.set(idx, { id, name, args: "" });
              contentBlocks.push({ type: "tool_call", id, name, input: {} });
              yield { type: "tool_call_start", id, name };
            }
            if (tc.function?.arguments) {
              const entry = toolCalls.get(idx)!;
              entry.args += tc.function.arguments;
              yield { type: "tool_call_delta", id: entry.id, input: tc.function.arguments };
            }
          }
        }
      }

      // Usage info (comes in the final chunk with stream_options.include_usage)
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    // Finalize tool call inputs
    for (const [, entry] of toolCalls) {
      const block = contentBlocks.find(
        (b) => b.type === "tool_call" && b.id === entry.id,
      );
      if (block && block.type === "tool_call") {
        try {
          block.input = JSON.parse(entry.args || "{}");
        } catch {
          block.input = {};
        }
      }
    }

    const message: AssistantMessage = { role: "assistant", content: contentBlocks };
    yield { type: "done", message, usage };
  }
}

function mapMessage(m: Message): OpenAI.ChatCompletionMessageParam {
  if (m.role === "user") {
    if (typeof m.content === "string") {
      return { role: "user", content: m.content };
    }
    const parts: OpenAI.ChatCompletionContentPart[] = m.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "image") {
        if (block.source.type === "url") {
          return { type: "image_url" as const, image_url: { url: block.source.url } };
        }
        return {
          type: "image_url" as const,
          image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
        };
      }
      return { type: "text" as const, text: JSON.stringify(block) };
    });
    return { role: "user", content: parts };
  }

  if (m.role === "assistant") {
    let text = "";
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        text += b.text;
      } else if (b.type === "tool_call") {
        toolCalls.push({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        });
      }
    }
    return {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  }

  // tool_result
  return {
    role: "tool",
    tool_call_id: m.toolCallId,
    content: typeof m.content === "string" ? m.content : m.content.map((b) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n"),
  };
}
