// Volcengine (Doubao) LLM provider (OpenAI Chat Completions API compatible)

import { OpenAIProvider } from "./openai.js";

export class VolcengineProvider extends OpenAIProvider {
  constructor(apiKey?: string, baseUrl?: string) {
    super(
      apiKey ?? process.env.VOLCENGINE_API_KEY,
      baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3",
    );
  }
}
