// Agent loop — nested while loop with full integration
// session, compaction, checkpoint, injection, extension all wired in

import type {
  AgentMessage,
  AgentEvent,
  AgentHooks,
  Message,
  AssistantMessage,
  ToolResultMessage,
  ToolCallBlock,
  TokenUsage,
  UserMessage,
} from "../types.js";
import type { AgentTool } from "../tools/types.js";
import type { LLMProvider, LLMRequestOptions, ToolDefinition, AssistantMessageEvent } from "../llm/types.js";
import type { Approval } from "../approval/types.js";
import type { SessionManager } from "../session/session-manager.js";
import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import type { InjectionManager } from "../injection/injection-manager.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { CompactionConfig } from "../compaction/types.js";
import { executeToolCalls, type ToolCallResult } from "../tools/executor.js";
import { estimateTokens, shouldCompact, findCutPoint } from "../compaction/compaction.js";
import { normalizeHistory } from "../injection/history-normalizer.js";

export interface AgentLoopConfig {
  provider: LLMProvider;
  modelId: string;
  systemPrompt: string;
  tools: AgentTool[];
  approval: Approval;
  agentName: string;
  toolExecution: "sequential" | "parallel";
  maxStepsPerTurn: number;
  hooks?: AgentHooks;
  getSteeringMessages?: () => AgentMessage[];
  getFollowUpMessages?: () => AgentMessage[];
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;

  // Integrated modules (all optional)
  sessionManager?: SessionManager;
  checkpointManager?: CheckpointManager;
  injectionManager?: InjectionManager;
  extensionRunner?: ExtensionRunner;
  compaction?: CompactionConfig & { summarize?: (messages: AgentMessage[]) => Promise<string> };
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m): m is Message =>
    typeof m === "object" && m !== null && "role" in m &&
    (m.role === "user" || m.role === "assistant" || m.role === "tool_result")
  );
}

function toolsToDefinitions(tools: AgentTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as any,
  }));
}

function extractToolCalls(message: AssistantMessage): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === "tool_use");
}

function toolResultsToMessages(results: ToolCallResult[]): ToolResultMessage[] {
  return results.map((r) => ({
    role: "tool_result" as const,
    tool_use_id: r.toolCallId,
    content: r.result.content,
    is_error: r.isError || undefined,
  }));
}

export async function runAgentLoop(
  initialMessages: AgentMessage[],
  config: AgentLoopConfig,
): Promise<AgentMessage[]> {
  const allMessages: AgentMessage[] = [...initialMessages];
  const { onEvent, sessionManager, checkpointManager, injectionManager, extensionRunner, compaction } = config;

  // Merge extension-registered tools with config tools
  const allTools = extensionRunner
    ? [...config.tools, ...extensionRunner.getRegisteredTools()]
    : config.tools;

  onEvent({ type: "agent_start" });
  await extensionRunner?.emitSimple("agent_start");

  try {
    // Outer loop: follow-up messages
    let hasFollowUp = true;
    while (hasFollowUp && !config.signal.aborted) {
      hasFollowUp = false;

      // Inner loop: tool calls + steering
      let hasMoreWork = true;
      let stepCount = 0;

      while (hasMoreWork && !config.signal.aborted) {
        hasMoreWork = false;

        if (stepCount >= config.maxStepsPerTurn) break;
        stepCount++;

        // --- Checkpoint (before each step) ---
        if (checkpointManager) {
          const cp = await checkpointManager.checkpoint();
          onEvent({ type: "checkpoint", id: cp.checkpointId });
        }

        // --- Compaction check ---
        if (compaction?.enabled !== false && compaction?.maxContextTokens) {
          const tokens = estimateTokens(allMessages);
          const reserve = compaction.reserveTokens ?? 16384;
          if (shouldCompact(tokens, compaction.maxContextTokens, reserve)) {
            onEvent({ type: "compaction_start" });

            // Let extensions intercept
            const extResult = await extensionRunner?.emitBeforeCompact({ messages: allMessages });
            if (!extResult?.skip) {
              const keepTokens = compaction.keepRecentTokens ?? 20000;
              const cutPoint = findCutPoint(allMessages, keepTokens);

              if (cutPoint.firstKeptIndex > 0) {
                const toDiscard = allMessages.slice(0, cutPoint.firstKeptIndex);
                const toKeep = allMessages.slice(cutPoint.firstKeptIndex);

                let summary = extResult?.summary ?? "";
                if (!summary && compaction.summarize) {
                  summary = await compaction.summarize(toDiscard);
                }

                // Replace messages: summary + kept
                allMessages.length = 0;
                if (summary) {
                  const summaryMsg: UserMessage = {
                    role: "user",
                    content: `<compaction-summary>${summary}</compaction-summary>`,
                  };
                  allMessages.push(summaryMsg);
                }
                allMessages.push(...toKeep);

                // Persist compaction to session
                // Append compaction entry as boundary marker, then re-append
                // kept messages after it so buildSessionContext picks them up
                if (sessionManager) {
                  await sessionManager.appendCompaction(summary, sessionManager.getLeafId() ?? "", tokens);
                  for (const msg of toKeep) {
                    await sessionManager.appendMessage(msg);
                  }
                }

                onEvent({ type: "compaction_end", summary });
              }
            }
          }
        }

        // --- Dynamic injections ---
        let contextMessages = [...allMessages];
        if (injectionManager) {
          const injections = await injectionManager.collectInjections(allMessages);
          if (injections.length > 0) {
            contextMessages.push(...injections);
          }
        }

        // --- History normalization ---
        contextMessages = normalizeHistory(contextMessages);

        // --- Extension context hook ---
        if (extensionRunner) {
          const ctxResult = await extensionRunner.emitContext({ messages: contextMessages });
          if (ctxResult?.messages) {
            contextMessages = ctxResult.messages;
          }
        }

        // --- Extension pending messages ---
        if (extensionRunner) {
          const extMsgs = extensionRunner.drainPendingMessages();
          if (extMsgs.length > 0) {
            allMessages.push(...extMsgs);
            contextMessages.push(...extMsgs);
          }
        }

        onEvent({ type: "turn_start" });
        await extensionRunner?.emitSimple("turn_start");

        // --- Transform context (user hook) ---
        if (config.hooks?.transformContext) {
          contextMessages = await config.hooks.transformContext(contextMessages);
        }

        // --- Convert to LLM messages ---
        const convertToLlm = config.hooks?.convertToLlm ?? defaultConvertToLlm;
        const llmMessages = convertToLlm(contextMessages);

        // --- Stream LLM response ---
        const toolDefs = toolsToDefinitions(allTools);
        const requestOptions: LLMRequestOptions = {
          model: config.modelId,
          systemPrompt: config.systemPrompt,
          messages: llmMessages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          signal: config.signal,
        };

        let assistantMessage: AssistantMessage | null = null;
        let usage: TokenUsage | undefined;
        let messageStartEmitted = false;

        for await (const event of config.provider.stream(requestOptions)) {
          if (event.type === "done") {
            assistantMessage = event.message;
            usage = event.usage;
            onEvent({ type: "message_end", message: event.message, usage: event.usage });
            await extensionRunner?.emitSimple("message_end", { message: event.message });
          } else if (event.type === "error") {
            onEvent({ type: "error", error: event.error });
            throw event.error;
          } else {
            if (!messageStartEmitted && (event.type === "text" || event.type === "tool_call_start" || event.type === "thinking")) {
              const partial: AssistantMessage = { role: "assistant", content: [] };
              onEvent({ type: "message_start", message: partial });
              await extensionRunner?.emitSimple("message_start", { message: partial });
              messageStartEmitted = true;
            }
            const partial: AssistantMessage = { role: "assistant", content: [] };
            onEvent({ type: "message_update", message: partial, event });
          }
        }

        if (!assistantMessage) {
          break;
        }

        allMessages.push(assistantMessage);
        await sessionManager?.appendMessage(assistantMessage);

        // --- Tool calls ---
        const toolCalls = extractToolCalls(assistantMessage);
        const toolResults: ToolResultMessage[] = [];

        if (toolCalls.length > 0) {
          const results = await executeToolCalls(toolCalls, {
            tools: allTools,
            mode: config.toolExecution,
            approval: config.approval,
            agentName: config.agentName,
            signal: config.signal,
            beforeToolCall: async (ctx) => {
              // Extension hook first
              const extResult = await extensionRunner?.emitToolCall({
                toolName: ctx.toolName,
                toolCallId: ctx.toolCallId,
                args: ctx.args,
              });
              if (extResult?.block) return extResult;
              // Then user hook
              return config.hooks?.beforeToolCall?.(ctx);
            },
            afterToolCall: async (ctx) => {
              // Extension hook first
              const extResult = await extensionRunner?.emitToolResult({
                toolName: ctx.toolName,
                toolCallId: ctx.toolCallId,
                args: ctx.args,
                result: ctx.result,
                isError: ctx.isError,
              });
              // Then user hook
              const hookResult = await config.hooks?.afterToolCall?.(ctx);
              return hookResult ?? extResult ?? undefined;
            },
            onEvent: (e) => onEvent(e),
          });

          const resultMessages = toolResultsToMessages(results);
          toolResults.push(...resultMessages);
          allMessages.push(...resultMessages);

          // Persist tool results to session
          for (const rm of resultMessages) {
            await sessionManager?.appendMessage(rm);
          }

          hasMoreWork = true;
        }

        onEvent({ type: "turn_end", message: assistantMessage, toolResults });
        await extensionRunner?.emitSimple("turn_end", { message: assistantMessage });

        // --- D-Mail check (after tool execution) ---
        if (checkpointManager) {
          const dmailContent = await checkpointManager.handleDMail();
          if (dmailContent) {
            // Get the checkpoint ID the D-Mail targeted
            const lastCheckpoint = checkpointManager.getAllCheckpoints();
            const targetCheckpointId = lastCheckpoint.length > 0 ? lastCheckpoint[lastCheckpoint.length - 1].checkpointId : 0;
            onEvent({ type: "dmail_received", checkpoint: targetCheckpointId, content: dmailContent });

            // Rebuild allMessages from session context after branch
            if (sessionManager) {
              const ctx = sessionManager.buildSessionContext();
              allMessages.length = 0;
              allMessages.push(...ctx.messages);
            }

            // Inject D-Mail as system message
            const dmailMsg: UserMessage = {
              role: "user",
              content: `<dmail>${dmailContent}</dmail>`,
            };
            allMessages.push(dmailMsg);
            await sessionManager?.appendMessage(dmailMsg);

            hasMoreWork = true;
            continue;
          }
        }

        // --- Steering messages ---
        if (config.getSteeringMessages) {
          const steering = config.getSteeringMessages();
          if (steering.length > 0) {
            allMessages.push(...steering);
            for (const sm of steering) {
              await sessionManager?.appendMessage(sm);
            }
            hasMoreWork = true;
          }
        }
      }

      // --- Follow-up messages ---
      if (config.getFollowUpMessages) {
        const followUps = config.getFollowUpMessages();
        if (followUps.length > 0) {
          allMessages.push(...followUps);
          for (const fm of followUps) {
            await sessionManager?.appendMessage(fm);
          }
          hasFollowUp = true;
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) {
      onEvent({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  onEvent({ type: "agent_end", messages: allMessages });
  await extensionRunner?.emitSimple("agent_end", { messages: allMessages });
  return allMessages;
}
