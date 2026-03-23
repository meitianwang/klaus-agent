// OpenAI Codex LLM provider
// Connects to ChatGPT's Codex backend via Responses API format.
// Requires a ChatGPT OAuth JWT token as apiKey.

import type {
  LLMProvider,
  LLMRequestOptions,
  AssistantMessageEvent,
  AssistantMessage,
  AssistantContentBlock,
  TokenUsage,
  ThinkingLevel,
  Message,
  ToolDefinition,
} from "../llm/types.js";
import { platform, release, arch } from "node:os";
import { mapMessages, mapTools } from "./openai-responses-shared.js";
import type { ResponseInput, ResponseTool } from "./openai-responses-shared.js";

// --- Configuration ---

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// --- Types ---

interface CodexRequestBody {
  model: string;
  store: boolean;
  stream: boolean;
  instructions: string;
  input: ResponseInput;
  tools?: ResponseTool[];
  tool_choice: "auto";
  parallel_tool_calls: boolean;
  temperature?: number;
  reasoning?: { effort: string; summary: string };
  text: { verbosity: string };
  include: string[];
  prompt_cache_key?: string;
  [key: string]: unknown;
}

// --- Provider ---

export class OpenAICodexProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.OPENAI_CODEX_TOKEN || "";
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
  }

  async *stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    yield* this._streamOnce(options);
  }

  private async *_streamOnce(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent> {
    const { model, systemPrompt, messages, tools, thinkingLevel, signal } = options;

    if (!this.apiKey) {
      throw new Error("No API key for openai-codex provider. Set OPENAI_CODEX_TOKEN or pass apiKey.");
    }

    const accountId = extractAccountId(this.apiKey);
    const body = buildRequestBody(model, systemPrompt, messages, tools, thinkingLevel);
    const headers = buildHeaders(accountId, this.apiKey);
    const url = resolveCodexUrl(this.baseUrl);

    // Fetch with retry for rate limits / transient errors
    let response: Response | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error("Request was aborted");

      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok) break;

        const errorText = await response.text();
        if (attempt < MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
          await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
          continue;
        }

        throw new Error(parseErrorMessage(response.status, errorText));
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message === "Request was aborted")) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
          await sleep(BASE_DELAY_MS * 2 ** attempt, signal);
          continue;
        }
        throw lastError;
      }
    }

    if (!response?.ok) throw lastError ?? new Error("Failed after retries");
    if (!response.body) throw new Error("No response body");

    // Parse SSE stream and map to AssistantMessageEvent
    const contentBlocks: AssistantContentBlock[] = [];
    const toolCalls = new Map<string, { id: string; name: string; args: string; callId: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for await (const event of mapCodexEvents(parseSSE(response))) {
      const type = event.type as string;

      // Text delta
      if (type === "response.output_text.delta") {
        const delta = (event as any).delta as string;
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
        const delta = (event as any).delta as string;
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
        const item = (event as any).item;
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
        const itemId = (event as any).item_id;
        const delta = (event as any).delta as string;
        if (itemId && delta) {
          const entry = toolCalls.get(itemId);
          if (entry) {
            entry.args += delta;
            yield { type: "tool_call_delta", id: entry.callId, input: delta };
          }
        }
      }

      // Response completed — extract usage
      if (type === "response.completed") {
        const resp = (event as any).response;
        if (resp?.usage) {
          usage = {
            inputTokens: resp.usage.input_tokens ?? 0,
            outputTokens: resp.usage.output_tokens ?? 0,
            totalTokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
            cacheReadTokens: resp.usage.input_tokens_details?.cached_tokens,
          };
        }
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

// --- JWT ---

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    // JWT uses base64url encoding; convert to standard base64 for atob
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("No chatgpt_account_id in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from Codex JWT token");
  }
}

// --- Request building ---

function resolveCodexUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function buildHeaders(accountId: string, token: string): Record<string, string> {
  const userAgent = `klaus-agent (${platform()} ${release()}; ${arch()})`;
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "chatgpt-account-id": accountId,
    "originator": "klaus",
    "OpenAI-Beta": "responses=experimental",
    "User-Agent": userAgent,
  };
}

function buildRequestBody(
  model: string,
  systemPrompt: string,
  messages: Message[],
  tools?: ToolDefinition[],
  thinkingLevel?: ThinkingLevel,
): CodexRequestBody {
  const body: CodexRequestBody = {
    model,
    store: false,
    stream: true,
    instructions: systemPrompt,
    input: mapMessages(messages),
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (tools?.length) {
    body.tools = mapTools(tools);
  }

  const effort = mapReasoningEffort(model, thinkingLevel);
  if (effort) {
    body.reasoning = { effort, summary: "auto" };
  }

  return body;
}


function mapReasoningEffort(modelId: string, level?: ThinkingLevel): string | undefined {
  if (!level || level === "off") return undefined;

  let effort: string = level;
  // Clamp per model, following pi-mono's logic
  const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) && effort === "minimal") {
    effort = "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") effort = "high";
  if (id === "gpt-5.1-codex-mini") {
    effort = effort === "high" || effort === "xhigh" ? "high" : "medium";
  }

  return effort;
}

// --- SSE parsing ---

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data);
            } catch { /* skip malformed JSON */ }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// --- Event mapping ---

async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;

    if (type === "error") {
      const code = (event as any).code || "";
      const message = (event as any).message || "";
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }

    if (type === "response.failed") {
      const msg = (event as any).response?.error?.message;
      throw new Error(msg || "Codex response failed");
    }

    // Normalize completion events
    if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
      yield { ...event, type: "response.completed" };
      return;
    }

    yield event;
  }
}

// --- Error handling ---

function isRetryableStatus(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function parseErrorMessage(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
    };
    const err = parsed?.error;
    if (err) {
      if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(err.code || err.type || "")) {
        const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        return `ChatGPT usage limit reached${plan}.${when}`.trim();
      }
      return err.message || raw;
    }
  } catch { /* not JSON */ }
  return `Codex request failed (${status}): ${raw.slice(0, 200)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Request was aborted")); return; }
    const onAbort = () => { clearTimeout(timeout); reject(new Error("Request was aborted")); };
    const timeout = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}
