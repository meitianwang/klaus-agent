// Tool orchestration — batch partitioning and orchestrated execution.
// Fully aligned with claude-code's toolOrchestration.ts.

import type { AgentTool, ToolExecutionContext, CanUseToolFn } from "./types.js";
import { findToolByName } from "./types.js";
import type { ToolUseBlock, AssistantMessage, Message } from "../llm/types.js";
import {
  runToolUse,
  type MessageUpdateLazy,
} from "./executor.js";

function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || "", 10) || 10
  );
}

export type MessageUpdate = {
  message?: Message;
  newContext: ToolExecutionContext;
};

export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolExecutionContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext;
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    currentContext,
  )) {
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolExecutionContext) => ToolExecutionContext)[]
      > = {};
      // Run read-only batch concurrently
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier;
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = [];
          }
          queuedContextModifiers[toolUseID]!.push(modifyContext);
        }
        yield {
          message: update.message,
          newContext: currentContext,
        };
      }
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id];
        if (!modifiers) {
          continue;
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext);
        }
      }
      yield { newContext: currentContext };
    } else {
      // Run non-read-only batch serially
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.newContext) {
          currentContext = update.newContext;
        }
        yield {
          message: update.message,
          newContext: currentContext,
        };
      }
    }
  }
}

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] };

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolExecutionContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name);
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input);
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data));
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false;
          }
        })()
      : false;
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse);
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] });
    }
    return acc;
  }, []);
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolExecutionContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext;

  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    );
    for await (const update of runToolUse(
      toolUse,
      findAssistantMessage(assistantMessages, toolUse.id),
      canUseTool,
      currentContext,
    )) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext);
      }
      yield {
        message: update.message,
        newContext: currentContext,
      };
    }
    markToolUseAsComplete(toolUseContext, toolUse.id);
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolExecutionContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      toolUseContext.setInProgressToolUseIDs(prev =>
        new Set(prev).add(toolUse.id),
      );
      yield* runToolUse(
        toolUse,
        findAssistantMessage(assistantMessages, toolUse.id),
        canUseTool,
        toolUseContext,
      );
      markToolUseAsComplete(toolUseContext, toolUse.id);
    }),
    getMaxToolUseConcurrency(),
  );
}

function markToolUseAsComplete(
  toolUseContext: ToolExecutionContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev);
    next.delete(toolUseID);
    return next;
  });
}

/**
 * Find the assistant message that contains a specific tool_use block.
 * SDK uses flat message format: msg.content is the content array directly.
 */
function findAssistantMessage(
  assistantMessages: AssistantMessage[],
  toolUseId: string,
): AssistantMessage {
  return assistantMessages.find(_ =>
    (_.content as any[]).some(
      (_: any) => _.type === "tool_use" && _.id === toolUseId,
    ),
  )!;
}

// ---------------------------------------------------------------------------
// all() — concurrency-limited async generator merger
// Aligned with claude-code's utils/generators.ts all() using Promise.race pattern.
// ---------------------------------------------------------------------------

type QueuedGenerator<A> = {
  done: boolean | void;
  value: A | void;
  generator: AsyncGenerator<A, void>;
  promise: Promise<QueuedGenerator<A>>;
};

// Run all generators concurrently up to a concurrency cap, yielding values as they come in
async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise,
      }));
    return promise;
  };
  const waiting = [...generators];
  const promises = new Set<Promise<QueuedGenerator<A>>>();

  // Start initial batch up to concurrency cap
  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!;
    promises.add(next(gen));
  }

  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises);
    promises.delete(promise);

    if (!done) {
      promises.add(next(generator));
      // TODO: Clean this up
      if (value !== undefined) {
        yield value;
      }
    } else if (waiting.length > 0) {
      // Start a new generator when one finishes
      const nextGen = waiting.shift()!;
      promises.add(next(nextGen));
    }
  }
}

// ---------------------------------------------------------------------------
// Back-compat exports — kept for existing callers
// ---------------------------------------------------------------------------

/** @deprecated Use MessageUpdate directly. */
export type OrchestratedUpdate = MessageUpdate;

/**
 * Back-compat config object used by runToolsOrchestrated().
 * New callers should prefer runTools() directly.
 */
export interface OrchestratedToolConfig {
  tools: AgentTool[];
  canUseTool: CanUseToolFn;
  toolUseContext: ToolExecutionContext;
  assistantMessage: AssistantMessage;
  allBaseTools?: readonly AgentTool[];
  setInProgressToolUseIDs?: (updater: (prev: Set<string>) => Set<string>) => void;
}

/** @deprecated Use runTools() directly. */
export async function* runToolsOrchestrated(
  toolCalls: ToolUseBlock[],
  config: OrchestratedToolConfig,
): AsyncGenerator<MessageUpdate, void> {
  yield* runTools(
    toolCalls,
    [config.assistantMessage],
    config.canUseTool,
    config.toolUseContext,
  );
}

/**
 * Exported partitionToolCalls for external callers.
 * Accepts either ToolExecutionContext (matching claude-code) or AgentTool[] for back-compat.
 */
export { partitionToolCalls };
