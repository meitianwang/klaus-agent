// Kimi LLM provider (Anthropic Messages API compatible)

import { AnthropicProvider } from "./anthropic.js";

export class KimiProvider extends AnthropicProvider {
  constructor(apiKey?: string, baseUrl?: string) {
    super(
      apiKey ?? process.env.KIMI_API_KEY,
      baseUrl ?? "https://api.kimi.com/coding",
    );
  }
}
