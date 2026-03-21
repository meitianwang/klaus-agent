// Multi-agent types

import type { AgentTool } from "../tools/types.js";

export interface SubagentConfig {
  name: string;
  systemPrompt: string | (() => string | Promise<string>);
  tools?: AgentTool[];
  description: string;
}
