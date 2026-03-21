// LaborMarket — fixed + dynamic subagent registry

import type { Agent } from "../core/agent.js";

interface SubagentEntry {
  agent: Agent;
  description: string;
}

export class LaborMarket {
  private _fixed = new Map<string, SubagentEntry>();
  private _dynamic = new Map<string, SubagentEntry>();

  addFixed(name: string, agent: Agent, description: string): void {
    if (this._fixed.has(name) || this._dynamic.has(name)) {
      throw new Error(`Subagent "${name}" already exists`);
    }
    this._fixed.set(name, { agent, description });
  }

  addDynamic(name: string, agent: Agent, description: string): void {
    if (this._fixed.has(name) || this._dynamic.has(name)) {
      throw new Error(`Subagent "${name}" already exists`);
    }
    this._dynamic.set(name, { agent, description });
  }

  get(name: string): Agent | undefined {
    return this._fixed.get(name)?.agent ?? this._dynamic.get(name)?.agent;
  }

  getDescription(name: string): string | undefined {
    return this._fixed.get(name)?.description ?? this._dynamic.get(name)?.description;
  }

  listAll(): { name: string; description: string; type: "fixed" | "dynamic" }[] {
    const result: { name: string; description: string; type: "fixed" | "dynamic" }[] = [];
    for (const [name, entry] of this._fixed) {
      result.push({ name, description: entry.description, type: "fixed" });
    }
    for (const [name, entry] of this._dynamic) {
      result.push({ name, description: entry.description, type: "dynamic" });
    }
    return result;
  }

  removeDynamic(name: string): boolean {
    return this._dynamic.delete(name);
  }

  has(name: string): boolean {
    return this._fixed.has(name) || this._dynamic.has(name);
  }
}
