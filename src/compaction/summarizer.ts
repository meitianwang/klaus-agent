// LLM-based summarization for compaction

import type { LLMProvider, LLMRequestOptions, AssistantMessage } from "../llm/types.js";
import type { AgentMessage } from "../types.js";
import type { CompactionSummarizer, CompactionInput } from "./types.js";
import { isToolResultMessage, getToolResultContent } from "../utils/messages.js";

const SUMMARIZE_PROMPT = `You are a conversation summarizer. Summarize the following conversation history concisely, preserving:
- Key decisions and outcomes
- Important context and facts established
- Current state of any ongoing tasks
- Tool calls made and their results (briefly)

Be concise but thorough. Use bullet points. Do not include greetings or filler.`;

const UPDATE_PROMPT = `You are a conversation summarizer. You have a previous summary and new conversation to incorporate.

Previous summary:
{previous_summary}

Merge the new conversation into the summary, preserving all important context. Remove outdated information that has been superseded.`;

export class LLMSummarizer implements CompactionSummarizer {
  constructor(
    private provider: LLMProvider,
    private modelId: string,
  ) {}

  async summarize(messages: CompactionInput[], previousSummary?: string): Promise<string> {
    const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

    const systemPrompt = previousSummary
      ? UPDATE_PROMPT.replace("{previous_summary}", previousSummary)
      : SUMMARIZE_PROMPT;

    const options: LLMRequestOptions = {
      model: this.modelId,
      systemPrompt,
      messages: [{ role: "user", content: `Summarize this conversation:\n\n${conversationText}` }],
      maxTokens: 2048,
    };

    let result = "";
    for await (const event of this.provider.stream(options)) {
      if (event.type === "done") {
        const textBlocks = event.message.content.filter((b) => b.type === "text");
        result = textBlocks.map((b) => (b as { text: string }).text).join("");
      }
    }

    return result;
  }
}

export function agentMessagesToCompactionInput(messages: AgentMessage[]): CompactionInput[] {
  const results: CompactionInput[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !("role" in msg)) continue;
    const m = msg as any;

    if (m.role === "user") {
      // Check if this is a tool result message
      if (isToolResultMessage(m)) {
        const content = getToolResultContent(m);
        const text = typeof content === "string"
          ? content
          : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        results.push({ role: "tool_result", content: text.slice(0, 500) });
      } else {
        const text = typeof m.content === "string"
          ? m.content
          : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        results.push({ role: "user", content: text });
      }
    } else if (m.role === "assistant") {
      const text = (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      const toolCalls = (m.content ?? []).filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
      const suffix = toolCalls.length ? ` [tools: ${toolCalls.join(", ")}]` : "";
      results.push({ role: "assistant", content: text + suffix });
    }
  }
  return results;
}
