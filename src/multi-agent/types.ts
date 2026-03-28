// Multi-agent types

import type { AgentTool } from "../tools/types.js";
import type { ModelConfig } from "../llm/types.js";

export interface SubagentConfig {
  name: string;
  systemPrompt: string | (() => string | Promise<string>);
  tools?: AgentTool[];
  description: string;
  /** Override the parent agent's model config. If omitted, inherits the parent's model. */
  model?: ModelConfig;
}
