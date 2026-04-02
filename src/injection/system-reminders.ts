// Built-in system-reminder providers — declarative injection framework
//
// These providers implement common reminder patterns:
// - Tool usage reminders (e.g., "You haven't used TodoWrite recently")
// - Periodic context injection (e.g., current date, git status)
// - One-shot context (e.g., conversation-start environment info)
// - Conditional reminders based on conversation state

import type { AgentMessage, Message, ToolUseBlock } from "../types.js";
import type { DynamicInjection, DynamicInjectionProvider } from "./types.js";

/**
 * Reminder that fires when a specific tool hasn't been used for N turns.
 * Reminder that fires when a specific tool hasn't been used for N turns.
 */
export interface ToolUsageReminderConfig {
  /** Tool name to monitor. */
  toolName: string;
  /** Number of assistant turns without using the tool before firing. */
  turnsThreshold: number;
  /** Reminder content (plain text, will be wrapped in system-reminder tags). */
  content: string;
  /** Optional: only fire if a condition is met (e.g., check if todos exist). */
  condition?: (history: AgentMessage[]) => boolean;
}

export class ToolUsageReminderProvider implements DynamicInjectionProvider {
  private _config: ToolUsageReminderConfig;

  constructor(config: ToolUsageReminderConfig) {
    this._config = config;
  }

  async getInjections(history: AgentMessage[]): Promise<DynamicInjection[]> {
    if (this._config.condition && !this._config.condition(history)) {
      return [];
    }

    // Count assistant turns since the tool was last used
    let turnsSinceUse = 0;
    let foundUse = false;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (!msg || typeof msg !== "object" || !("role" in msg)) continue;
      const m = msg as Message;

      if (m.role === "assistant") {
        // Check if this assistant message used the tool
        const usedTool = m.content.some(
          (b) => (b as ToolUseBlock).type === "tool_use" && (b as ToolUseBlock).name === this._config.toolName,
        );
        if (usedTool) {
          foundUse = true;
          break;
        }
        turnsSinceUse++;
      }
    }

    // Only fire if: tool has been used before (or history is long enough) and threshold exceeded
    if (turnsSinceUse >= this._config.turnsThreshold && (foundUse || turnsSinceUse >= this._config.turnsThreshold * 2)) {
      return [{ type: "tool-usage-reminder", content: this._config.content }];
    }

    return [];
  }
}

/**
 * Provider that injects content every N turns.
 * Useful for periodic reminders like "current date" or "workspace status".
 */
export interface PeriodicReminderConfig {
  /** Unique type identifier for this reminder. */
  type: string;
  /** Inject every N assistant turns. 1 = every turn. */
  interval: number;
  /** Content to inject (string or dynamic function). */
  content: string | (() => string | Promise<string>);
}

export class PeriodicReminderProvider implements DynamicInjectionProvider {
  private _config: PeriodicReminderConfig;
  private _callCount = 0;

  constructor(config: PeriodicReminderConfig) {
    this._config = config;
  }

  async getInjections(): Promise<DynamicInjection[]> {
    this._callCount++;
    if (this._callCount % this._config.interval !== 0 && this._callCount !== 1) {
      return [];
    }

    const content = typeof this._config.content === "function"
      ? await this._config.content()
      : this._config.content;

    return content ? [{ type: this._config.type, content }] : [];
  }
}

/**
 * Provider that injects content only on the first turn of the conversation.
 * Useful for environment info, git status snapshots, etc.
 */
export class OneShotReminderProvider implements DynamicInjectionProvider {
  private _type: string;
  private _content: string | (() => string | Promise<string>);
  private _fired = false;

  constructor(type: string, content: string | (() => string | Promise<string>)) {
    this._type = type;
    this._content = content;
  }

  async getInjections(): Promise<DynamicInjection[]> {
    if (this._fired) return [];
    this._fired = true;

    const content = typeof this._content === "function"
      ? await this._content()
      : this._content;

    return content ? [{ type: this._type, content }] : [];
  }
}

/**
 * Provider that injects based on a custom condition evaluated each turn.
 * Most flexible option — condition receives full history.
 */
export interface ConditionalReminderConfig {
  type: string;
  condition: (history: AgentMessage[]) => boolean;
  content: string | ((history: AgentMessage[]) => string | Promise<string>);
}

export class ConditionalReminderProvider implements DynamicInjectionProvider {
  private _config: ConditionalReminderConfig;

  constructor(config: ConditionalReminderConfig) {
    this._config = config;
  }

  async getInjections(history: AgentMessage[]): Promise<DynamicInjection[]> {
    if (!this._config.condition(history)) return [];

    const content = typeof this._config.content === "function"
      ? await this._config.content(history)
      : this._config.content;

    return content ? [{ type: this._config.type, content }] : [];
  }
}
