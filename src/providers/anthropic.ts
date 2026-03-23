// Anthropic LLM provider

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
} from "../llm/types.js";
import { withRetry, RETRYABLE_PATTERNS, mapThinkingBudget } from "./shared.js";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  async *stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    yield* withRetry(() => this._streamOnce(options), RETRYABLE_PATTERNS.anthropic);
  }

  private async *_streamOnce(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, signal } = options;

    const thinkingBudget = mapThinkingBudget(thinkingLevel);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens ?? 8192,
      system: systemPrompt,
      messages: messages.map((m) => {
        if (m.role === "user") {
          return { role: "user" as const, content: typeof m.content === "string" ? m.content : m.content.map(mapContentBlock) };
        }
        if (m.role === "assistant") {
          return { role: "assistant" as const, content: m.content.map(mapAssistantBlock) };
        }
        // tool_result
        return {
          role: "user" as const,
          content: [{
            type: "tool_result" as const,
            tool_use_id: m.toolCallId,
            content: typeof m.content === "string" ? m.content : m.content.map(mapToolResultContent),
            ...(m.isError ? { is_error: true as const } : {}),
          }],
        };
      }),
      stream: true,
      ...(tools?.length ? {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      } : {}),
      ...(thinkingBudget ? {
        thinking: { type: "enabled" as const, budget_tokens: thinkingBudget },
      } : {}),
    };

    const contentBlocks: AssistantContentBlock[] = [];
    const toolInputBuffers = new Map<number, string>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const stream = this.client.messages.stream(params, { signal });

    for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") {
            contentBlocks.push({ type: "text", text: "" });
          } else if (block.type === "tool_use") {
            contentBlocks.push({ type: "tool_call", id: block.id, name: block.name, input: {} });
            toolInputBuffers.set(event.index, "");
            yield { type: "tool_call_start", id: block.id, name: block.name };
          } else if (block.type === "thinking") {
            contentBlocks.push({ type: "thinking", thinking: "" });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            const block = contentBlocks[event.index];
            if (block && block.type === "text") {
              block.text += delta.text;
            }
            yield { type: "text", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            const buf = (toolInputBuffers.get(event.index) ?? "") + delta.partial_json;
            toolInputBuffers.set(event.index, buf);
            const block = contentBlocks[event.index];
            if (block && block.type === "tool_call") {
              yield { type: "tool_call_delta", id: block.id, input: delta.partial_json };
            }
          } else if (delta.type === "thinking_delta") {
            const block = contentBlocks[event.index];
            if (block && block.type === "thinking") {
              block.thinking += delta.thinking;
            }
            yield { type: "thinking", thinking: delta.thinking };
          }
        } else if (event.type === "content_block_stop") {
          const block = contentBlocks[event.index];
          if (block && block.type === "tool_call") {
            const buf = toolInputBuffers.get(event.index) ?? "{}";
            try {
              block.input = JSON.parse(buf || "{}");
            } catch {
              block.input = {};
            }
            toolInputBuffers.delete(event.index);
          }
        } else if (event.type === "message_delta") {
          if (event.usage) {
            usage = {
              inputTokens: usage.inputTokens,
              outputTokens: event.usage.output_tokens,
              totalTokens: usage.inputTokens + event.usage.output_tokens,
            };
          }
        } else if (event.type === "message_start") {
          if (event.message.usage) {
            usage = {
              inputTokens: event.message.usage.input_tokens,
              outputTokens: event.message.usage.output_tokens,
              totalTokens: event.message.usage.input_tokens + event.message.usage.output_tokens,
              cacheReadTokens: (event.message.usage as any).cache_read_input_tokens,
              cacheWriteTokens: (event.message.usage as any).cache_creation_input_tokens,
            };
          }
        }
      }

    const message: AssistantMessage = { role: "assistant", content: contentBlocks };
    yield { type: "done", message, usage };
  }
}

function mapToolResultContent(block: { type: string; [key: string]: any }): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (block.type === "image" && block.source?.type === "base64") {
    return {
      type: "image",
      source: { type: "base64", media_type: block.source.mediaType, data: block.source.data },
    };
  }
  if (block.type === "image" && block.source?.type === "url") {
    return { type: "image", source: { type: "url", url: block.source.url } };
  }
  return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block) };
}

function mapContentBlock(block: { type: string; [key: string]: any }): Anthropic.ContentBlockParam {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    if (block.source.type === "base64") {
      return {
        type: "image",
        source: { type: "base64", media_type: block.source.mediaType, data: block.source.data },
      };
    }
    return { type: "image", source: { type: "url", url: block.source.url } };
  }
  return { type: "text", text: JSON.stringify(block) };
}

function mapAssistantBlock(block: AssistantContentBlock): Anthropic.ContentBlockParam {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_call") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, signature: "" };
  }
  return { type: "text", text: JSON.stringify(block) };
}
