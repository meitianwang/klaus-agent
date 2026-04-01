// OpenAI Responses API provider
// Uses the official OpenAI SDK's client.responses.create() for streaming.

import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
  ThinkingLevel,
} from "../llm/types.js";
import { withRetry, RETRYABLE_PATTERNS, mapReasoningEffort } from "./shared.js";
import { mapMessages, mapTools } from "./openai-responses-shared.js";

export class OpenAIResponsesProvider implements LLMProvider {
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

    const effort = mapReasoningEffort(thinkingLevel);

    const params: ResponseCreateParamsStreaming = {
      model,
      instructions: systemPrompt,
      input: mapMessages(messages) as ResponseCreateParamsStreaming["input"],
      stream: true,
      store: false,
      max_output_tokens: maxOutputTokensOverride ?? maxTokens ?? 8192,
      include: ["reasoning.encrypted_content"],
      ...(tools?.length ? {
        tools: mapTools(tools) as ResponseCreateParamsStreaming["tools"],
        tool_choice: "auto" as const,
      } : {}),
      ...(effort ? { reasoning: { effort, summary: "auto" as const } } : {}),
    };

    const contentBlocks: AssistantContentBlock[] = [];
    const toolCalls = new Map<string, { id: string; name: string; args: string; callId: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const stream = await this.client.responses.create(params, { signal });

    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
      const type = event.type;

      // Text delta
      if (type === "response.output_text.delta") {
        const delta = event.delta;
        if (delta) {
          if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== "text") {
            contentBlocks.push({ type: "text", text: "" });
          }
          const block = contentBlocks[contentBlocks.length - 1];
          if (block.type === "text") block.text += delta;
          yield { type: "text", text: delta };
        }
      }

      // Reasoning/thinking summary delta
      if (type === "response.reasoning_summary_text.delta") {
        const delta = event.delta;
        if (delta) {
          if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== "thinking") {
            contentBlocks.push({ type: "thinking", thinking: "" });
          }
          const block = contentBlocks[contentBlocks.length - 1];
          if (block.type === "thinking") block.thinking += delta;
          yield { type: "thinking", thinking: delta };
        }
      }

      // New output item (function call start)
      if (type === "response.output_item.added") {
        const item = event.item;
        if (item?.type === "function_call") {
          const id = item.id || item.call_id || `call_${toolCalls.size}`;
          const callId = item.call_id || id;
          const name = item.name || "";
          toolCalls.set(id, { id, name, args: "", callId });
          contentBlocks.push({ type: "tool_call", id: callId, name, input: {} });
          yield { type: "tool_call_start", id: callId, name };
        }
      }

      // Function call arguments delta
      if (type === "response.function_call_arguments.delta") {
        const itemId = event.item_id;
        const delta = event.delta;
        if (itemId && delta) {
          const entry = toolCalls.get(itemId);
          if (entry) {
            entry.args += delta;
            yield { type: "tool_call_delta", id: entry.callId, input: delta };
          }
        }
      }

      // Function call arguments complete — emit tool_call_end immediately
      if (type === "response.function_call_arguments.done") {
        const itemId = (event as any).item_id;
        if (itemId) {
          const entry = toolCalls.get(itemId);
          if (entry) {
            const block = contentBlocks.find((b) => b.type === "tool_call" && b.id === entry.callId);
            if (block && block.type === "tool_call") {
              try { block.input = JSON.parse(entry.args || "{}"); } catch { block.input = {}; }
              yield { type: "tool_call_end" as const, block: { ...block } };
            }
          }
        }
      }

      // Response completed or incomplete — extract usage
      if (type === "response.completed" || type === "response.incomplete") {
        const resp = event.response;
        if (resp?.usage) {
          usage = {
            inputTokens: resp.usage.input_tokens ?? 0,
            outputTokens: resp.usage.output_tokens ?? 0,
            totalTokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
            cacheReadTokens: resp.usage.input_tokens_details?.cached_tokens,
          };
        }
      }

      // Error / failure
      if (type === "error") {
        const err = (event as any).error;
        throw new Error(`OpenAI Responses error: ${err?.message || err?.code || JSON.stringify(event)}`);
      }
      if (type === "response.failed") {
        const resp = event.response;
        throw new Error(resp?.error?.message || "OpenAI Responses request failed");
      }
    }

    // Finalize tool call inputs
    for (const [, entry] of toolCalls) {
      const block = contentBlocks.find((b) => b.type === "tool_call" && b.id === entry.callId);
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
