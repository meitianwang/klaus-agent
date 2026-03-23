// LLM provider registry

import { AnthropicProvider } from "../providers/anthropic.js";
import type { LLMProvider, LLMProviderFactory } from "./types.js";

const providers = new Map<string, LLMProviderFactory>();

providers.set("anthropic", (config) => new AnthropicProvider(config.apiKey, config.baseUrl));

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
