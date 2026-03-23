// LLM provider registry

import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { OpenAICodexProvider } from "../providers/openai-codex.js";
import { GeminiProvider } from "../providers/google.js";
import { MiniMaxProvider } from "../providers/minimax.js";
import { KimiProvider } from "../providers/kimi.js";
import { VolcengineProvider } from "../providers/volcengine.js";
import type { LLMProvider, LLMProviderFactory } from "./types.js";

const providers = new Map<string, LLMProviderFactory>();

// Built-in providers
providers.set("anthropic", (c) => new AnthropicProvider(c.apiKey, c.baseUrl));
providers.set("openai", (c) => new OpenAIProvider(c.apiKey, c.baseUrl));
providers.set("openai-codex", (c) => new OpenAICodexProvider(c.apiKey, c.baseUrl));
providers.set("google", (c) => new GeminiProvider(c.apiKey, c.baseUrl));
providers.set("minimax", (c) => new MiniMaxProvider(c.apiKey, c.baseUrl));
providers.set("kimi", (c) => new KimiProvider(c.apiKey, c.baseUrl));
providers.set("volcengine", (c) => new VolcengineProvider(c.apiKey, c.baseUrl));

// Protocol-compatible proxies — user provides baseUrl to connect any compatible service
providers.set("openai-compatible", (c) => new OpenAIProvider(c.apiKey, c.baseUrl));
providers.set("anthropic-compatible", (c) => new AnthropicProvider(c.apiKey, c.baseUrl));
providers.set("gemini-compatible", (c) => new GeminiProvider(c.apiKey, c.baseUrl));

export function registerProvider(name: string, factory: LLMProviderFactory): void {
  providers.set(name, factory);
}

export function resolveProvider(config: { provider: string; apiKey?: string; baseUrl?: string }): LLMProvider {
  const factory = providers.get(config.provider);
  if (!factory) {
    throw new Error(`Unknown LLM provider: ${config.provider}. Register it with registerProvider().`);
  }
  return factory(config);
}
