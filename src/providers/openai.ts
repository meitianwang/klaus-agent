// OpenAI LLM provider

import OpenAI from "openai";
import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
  StopReason,
  Message,
  ToolResultBlock,
} from "../llm/types.js";
import { withRetry, RETRYABLE_PATTERNS, mapReasoningEffort } from "./shared.js";

// OpenAI o1/o3 reasoning content not yet in published typings
interface DeltaWithReasoning {
  reasoning_content?: string;
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
    const { model, systemPrompt, messages, tools, thinkingLevel, maxTokens, maxOutputTokensOverride, signal } = options;

    const reasoningEffort = mapReasoningEffort(thinkingLevel);

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        ...messages.flatMap((m) => {
          const mapped = mapMessage(m);
          return Array.isArray(mapped) ? mapped : [mapped];
        }),
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxOutputTokensOverride ?? maxTokens ?? 8192,
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
    let stopReason: StopReason | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const stream = await this.client.chat.completions.create(params, { signal });

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];

      if (choice?.finish_reason) {
        switch (choice.finish_reason) {
          case "stop":        stopReason = "end_turn"; break;
          case "length":      stopReason = "max_tokens"; break;
          case "tool_calls":  stopReason = "tool_use"; break;
        }
      }

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
        const reasoningContent = (delta as unknown as DeltaWithReasoning).reasoning_content;
        if (reasoningContent) {
          const thinking = reasoningContent;
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
              // A new tool call starting — finalize the previous one if any
              if (toolCalls.size > 0) {
                const prevIdx = idx - 1;
                const prevEntry = toolCalls.get(prevIdx);
                if (prevEntry) {
                  const prevBlock = contentBlocks.find((b) => b.type === "tool_use" && b.id === prevEntry.id);
                  if (prevBlock && prevBlock.type === "tool_use") {
                    try { prevBlock.input = JSON.parse(prevEntry.args || "{}"); } catch { prevBlock.input = {}; }
                    yield { type: "tool_use_end" as const, block: { ...prevBlock } };
                  }
                }
              }
              const id = tc.id ?? `call_${idx}`;
              const name = tc.function?.name ?? "";
              toolCalls.set(idx, { id, name, args: "" });
              contentBlocks.push({ type: "tool_use", id, name, input: {} });
              yield { type: "tool_use_start", id, name };
            }
            if (tc.function?.arguments) {
              const entry = toolCalls.get(idx)!;
              entry.args += tc.function.arguments;
              yield { type: "tool_use_delta", id: entry.id, input: tc.function.arguments };
            }
          }
        }
      }

      // Usage info (comes in the final chunk with stream_options.include_usage)
      if (chunk.usage) {
        const cachedTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens;
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
          ...(cachedTokens ? { cacheReadTokens: cachedTokens } : {}),
        };
      }
    }

    // Finalize tool use inputs and emit tool_use_end for the last tool
    for (const [, entry] of toolCalls) {
      const block = contentBlocks.find(
        (b) => b.type === "tool_use" && b.id === entry.id,
      );
      if (block && block.type === "tool_use") {
        try {
          block.input = JSON.parse(entry.args || "{}");
        } catch {
          block.input = {};
        }
      }
    }
    // Emit tool_use_end for the last tool (previous ones emitted during streaming)
    if (toolCalls.size > 0) {
      const lastIdx = Math.max(...toolCalls.keys());
      const lastEntry = toolCalls.get(lastIdx);
      if (lastEntry) {
        const lastBlock = contentBlocks.find((b) => b.type === "tool_use" && b.id === lastEntry.id);
        if (lastBlock && lastBlock.type === "tool_use") {
          yield { type: "tool_use_end" as const, block: { ...lastBlock } };
        }
      }
    }

    const message: AssistantMessage = { role: "assistant", content: contentBlocks, ...(stopReason && { stopReason }) };
    yield { type: "done", message, usage, stopReason };
  }
}

function mapMessage(m: Message): OpenAI.ChatCompletionMessageParam | OpenAI.ChatCompletionMessageParam[] {
  if (m.role === "user") {
    if (typeof m.content === "string") {
      return { role: "user", content: m.content };
    }
    // Separate tool_result blocks from regular content blocks
    const regularParts: OpenAI.ChatCompletionContentPart[] = [];
    const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];
    for (const block of m.content) {
      if (block.type === "tool_result") {
        const trb = block as ToolResultBlock;
        const output = typeof trb.content === "string"
          ? trb.content
          : trb.content.map((b) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n");
        toolResults.push({ role: "tool", tool_call_id: trb.tool_use_id, content: output });
      } else if (block.type === "text") {
        regularParts.push({ type: "text" as const, text: block.text });
      } else if (block.type === "image") {
        if (block.source.type === "url") {
          regularParts.push({ type: "image_url" as const, image_url: { url: block.source.url } });
        } else {
          regularParts.push({
            type: "image_url" as const,
            image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
          });
        }
      } else {
        regularParts.push({ type: "text" as const, text: JSON.stringify(block) });
      }
    }
    // If we have tool results, return them as separate messages
    if (toolResults.length > 0) {
      const msgs: OpenAI.ChatCompletionMessageParam[] = [...toolResults];
      if (regularParts.length > 0) {
        msgs.push({ role: "user", content: regularParts });
      }
      return msgs;
    }
    return { role: "user", content: regularParts };
  }

  // assistant
  let text = "";
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
  for (const b of m.content) {
    if (b.type === "text") {
      text += b.text;
    } else if (b.type === "tool_use") {
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
