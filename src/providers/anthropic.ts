// Anthropic LLM provider

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
  StopReason,
  ToolResultBlock,
} from "../llm/types.js";
import { withRetry, RETRYABLE_PATTERNS, mapThinkingBudget } from "./shared.js";

// Anthropic SDK type extension not yet in published typings
interface ContentBlockDeltaSignature {
  type: "signature_delta";
  signature: string;
}

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
    const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, maxOutputTokensOverride, signal, systemPromptBlocks } = options;

    const thinkingBudget = mapThinkingBudget(thinkingLevel);

    const mappedMessages = messages.map((m) => {
      if (m.role === "assistant") {
        return { role: "assistant" as const, content: m.content.map(mapAssistantBlock) };
      }
      // user — may contain plain content, ToolResultBlock, or a mix
      return { role: "user" as const, content: typeof m.content === "string" ? m.content : m.content.map(mapContentBlock) };
    });

    // Apply cache_control breakpoints for prompt caching:
    // 1. System prompt (always cached)
    // 2. Last user/tool_result turn (cache recent context boundary)
    applyCacheBreakpoints(mappedMessages);

    // Use structured blocks if provided (cache-aware), otherwise wrap flat string
    const systemParam = systemPromptBlocks && systemPromptBlocks.length > 0
      ? systemPromptBlocks.map((b) => ({
          type: "text" as const,
          text: b.text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        }))
      : [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }];

    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxOutputTokensOverride ?? maxTokens ?? 8192,
      system: systemParam,
      messages: mappedMessages,
      stream: true,
      ...(tools?.length ? {
        tools: tools.map((t, i) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          // Cache breakpoint on the last tool definition — tools change rarely
          // relative to messages, so caching the tool block saves significant tokens.
          // This uses 1 of Anthropic's 4 available breakpoints.
          ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        })),
      } : {}),
      ...(thinkingBudget ? {
        thinking: { type: "enabled" as const, budget_tokens: thinkingBudget },
      } : {}),
    };

    const contentBlocks: AssistantContentBlock[] = [];
    const toolInputBuffers = new Map<number, string>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stopReason: StopReason | undefined;
    let messageId: string | undefined;

    const stream = this.client.messages.stream(params, { signal });

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "text") {
          contentBlocks.push({ type: "text", text: "" });
        } else if (block.type === "tool_use") {
          contentBlocks.push({ type: "tool_use", id: block.id, name: block.name, input: {} });
          toolInputBuffers.set(event.index, "");
          yield { type: "tool_use_start", id: block.id, name: block.name };
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
          if (block && block.type === "tool_use") {
            yield { type: "tool_use_delta", id: block.id, input: delta.partial_json };
          }
        } else if (delta.type === "thinking_delta") {
          const block = contentBlocks[event.index];
          if (block && block.type === "thinking") {
            block.thinking += delta.thinking;
          }
          yield { type: "thinking", thinking: delta.thinking };
        } else if ((delta as unknown as ContentBlockDeltaSignature).type === "signature_delta") {
          const sigDelta = delta as unknown as ContentBlockDeltaSignature;
          const block = contentBlocks[event.index];
          if (block && block.type === "thinking") {
            block.signature = (block.signature ?? "") + sigDelta.signature;
          }
        }
      } else if (event.type === "content_block_stop") {
        const block = contentBlocks[event.index];
        if (block && block.type === "tool_use") {
          const buf = toolInputBuffers.get(event.index) ?? "{}";
          try {
            block.input = JSON.parse(buf || "{}");
          } catch {
            block.input = {};
          }
          toolInputBuffers.delete(event.index);
          // Emit tool_use_end so the streaming tool executor can start
          // executing this tool immediately, before the full response completes.
          yield { type: "tool_use_end" as const, block: { ...block } };
        }
      } else if (event.type === "message_delta") {
        if (event.usage) {
          usage = {
            inputTokens: usage.inputTokens,
            outputTokens: event.usage.output_tokens,
            totalTokens: usage.inputTokens + event.usage.output_tokens,
          };
        }
        if (event.delta.stop_reason) {
          const r = event.delta.stop_reason;
          if (r === "end_turn" || r === "max_tokens" || r === "tool_use" || r === "stop_sequence") {
            stopReason = r;
          }
        }
      } else if (event.type === "message_start") {
        messageId = event.message.id;
        if (event.message.usage) {
          const u = event.message.usage;
          usage = {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            totalTokens: u.input_tokens + u.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens ?? undefined,
            cacheWriteTokens: u.cache_creation_input_tokens ?? undefined,
          };
        }
      }
    }

    const message: AssistantMessage = { role: "assistant", content: contentBlocks, ...(messageId && { id: messageId }), ...(stopReason && { stopReason }) };
    yield { type: "done", message, usage, stopReason };
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
  if (block.type === "tool_result") {
    const trb = block as unknown as ToolResultBlock;
    return {
      type: "tool_result" as const,
      tool_use_id: trb.tool_use_id,
      content: typeof trb.content === "string" ? trb.content : (trb.content as any[]).map(mapToolResultContent),
      ...(trb.is_error ? { is_error: true as const } : {}),
    };
  }
  return { type: "text", text: JSON.stringify(block) };
}

/**
 * Apply cache_control breakpoints to message array for prompt caching.
 * Marks the last user/tool_result turn boundary so Anthropic can cache
 * everything up to that point across requests.
 */
function applyCacheBreakpoints(messages: Array<{ role: string; content: any }>): void {
  // Find the last user-role message and mark its last content block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      lastBlock.cache_control = { type: "ephemeral" };
      break;
    }

    // String content — convert to array so we can attach cache_control
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      break;
    }
  }
}

function mapAssistantBlock(block: AssistantContentBlock): Anthropic.ContentBlockParam {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature ?? "" };
  }
  return { type: "text", text: JSON.stringify(block) };
}
