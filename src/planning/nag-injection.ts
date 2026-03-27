// Nag injection provider — reminds model to update todos when it hasn't for N rounds

import type { DynamicInjectionProvider, DynamicInjection } from "../injection/types.js";
import type { AgentMessage } from "../types.js";
import type { PlanningManager } from "./planning-manager.js";

export class PlanningNagProvider implements DynamicInjectionProvider {
  constructor(private _manager: PlanningManager) {}

  async getInjections(_history: AgentMessage[]): Promise<DynamicInjection[]> {
    if (!this._manager.shouldNag()) return [];

    // Reset after check so the next nag waits another N rounds.
    // Kept here (not in shouldNag) so shouldNag() stays side-effect-free.
    this._manager.resetRoundCounter();

    return [
      {
        type: "planning-nag",
        content: this._manager.getNagMessage(),
      },
    ];
  }
}
