// Dynamic injection types

import type { AgentMessage } from "../types.js";

export interface DynamicInjection {
  type: string;
  content: string;
}

export interface DynamicInjectionProvider {
  getInjections(history: AgentMessage[]): Promise<DynamicInjection[]>;
}
