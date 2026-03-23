// MiniMax LLM provider (Anthropic Messages API compatible)

import { AnthropicProvider } from "./anthropic.js";

export class MiniMaxProvider extends AnthropicProvider {
  constructor(apiKey?: string, baseUrl?: string) {
    super(
      apiKey ?? process.env.MINIMAX_API_KEY,
      baseUrl ?? "https://api.minimaxi.com/anthropic",
    );
  }
}
