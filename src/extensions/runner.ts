// Extension runner — event dispatch, tool registration, lifecycle

import type {
  ExtensionFactory,
  ExtensionAPI,
  ExtensionEventType,
  ExtensionHandler,
  ExtensionEventMap,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  ContextEvent,
  ContextEventResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  CommandHandler,
} from "./types.js";
import type { AgentTool } from "../tools/types.js";
import type { AgentMessage } from "../types.js";
import type { TSchema } from "@sinclair/typebox";

interface RegisteredExtension {
  handlers: Map<ExtensionEventType, ExtensionHandler<any>[]>;
  tools: AgentTool[];
  commands: Map<string, CommandHandler>;
}

export class ExtensionRunner {
  private _extensions: RegisteredExtension[] = [];
  private _pendingMessages: AgentMessage[] = [];

  async loadExtensions(factories: ExtensionFactory[]): Promise<void> {
    for (const factory of factories) {
      const ext: RegisteredExtension = {
        handlers: new Map(),
        tools: [],
        commands: new Map(),
      };

      const api: ExtensionAPI = {
        on: <E extends ExtensionEventType>(event: E, handler: ExtensionHandler<E>) => {
          if (!ext.handlers.has(event)) ext.handlers.set(event, []);
          ext.handlers.get(event)!.push(handler);
        },
        registerTool: <TParams extends TSchema>(tool: AgentTool<TParams>) => {
          ext.tools.push(tool as AgentTool);
        },
        registerCommand: (name: string, handler: CommandHandler) => {
          ext.commands.set(name, handler);
        },
        sendMessage: (message: AgentMessage) => {
          this._pendingMessages.push(message);
        },
      };

      await factory(api);
      this._extensions.push(ext);
    }
  }

  // Collect all tools registered by extensions
  getRegisteredTools(): AgentTool[] {
    return this._extensions.flatMap((ext) => ext.tools);
  }

  // Collect all commands
  getCommand(name: string): CommandHandler | undefined {
    for (const ext of this._extensions) {
      const handler = ext.commands.get(name);
      if (handler) return handler;
    }
    return undefined;
  }

  // Drain pending messages from extensions
  drainPendingMessages(): AgentMessage[] {
    const msgs = [...this._pendingMessages];
    this._pendingMessages = [];
    return msgs;
  }

  // --- Event emission ---

  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | void> {
    return this._emit("tool_call", event);
  }

  async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | void> {
    return this._emit("tool_result", event);
  }

  async emitContext(event: ContextEvent): Promise<ContextEventResult | void> {
    return this._emit("context", event);
  }

  async emitBeforeCompact(event: BeforeCompactEvent): Promise<BeforeCompactResult | void> {
    return this._emit("before_compact", event);
  }

  async emitSimple(eventType: ExtensionEventType, payload?: any): Promise<void> {
    await this._emit(eventType, payload);
  }

  // --- Internal ---

  private async _emit<E extends ExtensionEventType>(
    eventType: E,
    payload: ExtensionEventMap[E]["payload"],
  ): Promise<ExtensionEventMap[E]["result"]> {
    let lastResult: any;

    for (const ext of this._extensions) {
      const handlers = ext.handlers.get(eventType);
      if (!handlers) continue;

      for (const handler of handlers) {
        const result = await handler(payload);
        if (result !== undefined && result !== null) {
          lastResult = result;
        }
      }
    }

    return lastResult;
  }
}
