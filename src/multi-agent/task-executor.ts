// TaskExecutor — run subagent with isolated context, pipe approval back

import type { Agent } from "../core/agent.js";
import type { LaborMarket } from "./labor-market.js";
import type { AgentMessage, AgentEvent, AssistantMessage } from "../types.js";

export interface TaskResult {
  messages: AgentMessage[];
  lastAssistantMessage?: AssistantMessage;
}

export class TaskExecutor {
  constructor(
    private _laborMarket: LaborMarket,
    private _onEvent?: (subagentName: string, event: AgentEvent) => void,
  ) {}

  async execute(subagentName: string, prompt: string): Promise<TaskResult> {
    const agent = this._laborMarket.get(subagentName);
    if (!agent) {
      throw new Error(`Subagent "${subagentName}" not found`);
    }

    // Subscribe to subagent events and forward them
    let unsubscribe: (() => void) | undefined;
    if (this._onEvent) {
      const handler = this._onEvent;
      unsubscribe = agent.subscribe((event) => handler(subagentName, event));
    }

    try {
      const messages = await agent.prompt(prompt);

      // Extract last assistant message as the "result"
      let lastAssistantMessage: AssistantMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg && typeof msg === "object" && "role" in msg && (msg as any).role === "assistant") {
          lastAssistantMessage = msg as AssistantMessage;
          break;
        }
      }

      return { messages, lastAssistantMessage };
    } finally {
      unsubscribe?.();
    }
  }
}
