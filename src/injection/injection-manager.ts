// Injection manager — collect injections from providers before each LLM step

import type { DynamicInjectionProvider, DynamicInjection } from "./types.js";
import type { AgentMessage, UserMessage } from "../types.js";

export class InjectionManager {
  private _providers: DynamicInjectionProvider[] = [];

  constructor(providers?: DynamicInjectionProvider[]) {
    if (providers) this._providers = [...providers];
  }

  addProvider(provider: DynamicInjectionProvider): void {
    this._providers.push(provider);
  }

  async collectInjections(history: AgentMessage[]): Promise<AgentMessage[]> {
    if (this._providers.length === 0) return [];

    const allInjections: DynamicInjection[] = [];
    for (const provider of this._providers) {
      const injections = await provider.getInjections(history);
      allInjections.push(...injections);
    }

    if (allInjections.length === 0) return [];

    // Wrap injections as user messages with system-reminder tags
    return allInjections.map((inj): UserMessage => ({
      role: "user",
      content: `<system-reminder type="${inj.type}">${inj.content}</system-reminder>`,
    }));
  }
}
