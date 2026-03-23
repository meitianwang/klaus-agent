# @klaus-ai/agent

Universal agent framework SDK. Inject tools, skills, and systemPrompt to build your agent — no wrapper needed.

[中文文档](./README.zh-CN.md)

## Install

```bash
npm install @klaus-ai/agent
```

## Quick Start

```typescript
import { createAgent } from "@klaus-ai/agent";
import { Type } from "@sinclair/typebox";

const agent = createAgent({
  model: { provider: "anthropic", model: "claude-sonnet-4-20250514", maxContextTokens: 200000 },
  systemPrompt: "You are a helpful assistant.",
  tools: [
    {
      name: "echo",
      label: "Echo",
      description: "Echo back the input",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.text }] };
      },
    },
  ],
  approval: { yolo: true },
});

// Subscribe to streaming events
agent.subscribe((event) => {
  if (event.type === "message_update" && event.event.type === "text") {
    process.stdout.write(event.event.text);
  }
});

const messages = await agent.prompt("Say hello");
```

## Architecture

Single package, 14 modules, zero wrappers. All capabilities are built-in and opt-in via config.

```
src/
├── core/           Agent + AgentLoop (nested dual-loop runtime)
├── llm/            Provider registry + abstraction
├── providers/      5 built-in protocol providers (Anthropic, OpenAI, OpenAI Responses, OpenAI Codex, Gemini)
├── tools/          Tool executor (sequential/parallel) + MCP adapter
├── approval/       Queue-based approval system
├── session/        JSONL tree persistence with branching
├── compaction/     Token estimation + LLM summarization
├── checkpoint/     Checkpoint + D-Mail time travel
├── injection/      Dynamic context injection + history normalization
├── multi-agent/    LaborMarket subagent registry + TaskExecutor
├── extensions/     Event-driven plugin system
├── skills/         Markdown skill discovery + template rendering
├── wire/           Typed async event channel with replay buffer
├── background/     In-process async task manager
└── utils/          ID generation + JSONL helpers
```

## Modules

### Core — Agent Loop

Nested dual-loop execution engine:

- Inner loop: LLM call → tool execution → steering messages → repeat until no more tool calls
- Outer loop: follow-up messages → re-enter inner loop

Each step integrates: checkpoint → compaction check → dynamic injection → history normalization → extension context hook → LLM stream → tool execution → D-Mail check → steering.

```typescript
const agent = createAgent({
  model: { provider: "anthropic", model: "claude-sonnet-4-20250514", maxContextTokens: 200000 },
  systemPrompt: "You are a helpful assistant.",
  tools: [...],
  maxStepsPerTurn: 50,        // Max inner loop iterations (default: 50)
  toolExecution: "parallel",   // "sequential" | "parallel" (default: "parallel")
});

// Run a prompt
const messages = await agent.prompt("Hello");

// Continue without new input
const more = await agent.continue();

// Inject messages mid-run
agent.steer({ role: "user", content: "Focus on X" });   // Injected after current tool execution
agent.followUp({ role: "user", content: "Also do Y" }); // Injected after inner loop completes

// Abort
agent.abort();

// Cleanup
await agent.dispose();
```

### LLM Provider

Provider-agnostic abstraction with 5 built-in protocol providers. All providers support streaming, retry (3 attempts, exponential backoff), and extended thinking. Connect any compatible service by providing a custom `baseUrl`.

Built-in providers: `anthropic`, `openai`, `openai-responses`, `openai-codex`, `google`

```typescript
// Use any built-in provider
const agent = createAgent({
  model: { provider: "openai", model: "gpt-4", maxContextTokens: 128000 },
  ...
});

// Connect a compatible service via custom baseUrl
const agent2 = createAgent({
  model: { provider: "openai", model: "my-model", maxContextTokens: 128000, baseUrl: "https://my-service/v1" },
  ...
});

// Register a fully custom provider
import { registerProvider } from "@klaus-ai/agent";
registerProvider("my-provider", (config) => new MyProvider(config.apiKey, config.baseUrl));
```

Provider interface:

```typescript
interface LLMProvider {
  stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent>;
}

// Stream events: text | tool_call_start | tool_call_delta | thinking | done | error
```

Cost tracking — provide per-million-token pricing via `ModelConfig.cost`, and the agent automatically calculates actual dollar costs on each `message_end` event:

```typescript
const agent = createAgent({
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxContextTokens: 200000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  ...
});

agent.subscribe((event) => {
  if (event.type === "message_end" && event.usage?.cost) {
    console.log(`Request cost: $${event.usage.cost.total.toFixed(6)}`);
  }
});
```

### Canonical Message Format

Provider-agnostic message types used throughout the framework:

```typescript
type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage {
  role: "user";
  content: string | ContentBlock[];  // ContentBlock = TextContent | ImageContent
}

interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];   // TextBlock | ToolCallBlock | ThinkingBlock
}

interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}
```

Extensible via `CustomAgentMessages` interface for framework consumers to add custom message types.

### Tools

Tools use TypeBox schemas for parameter validation. The executor supports sequential and parallel modes with approval gating.

```typescript
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@klaus-ai/agent";

const readFile: AgentTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a file from disk",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  approvalAction: "file:read",  // Triggers approval unless yolo mode

  async execute(toolCallId, params, context) {
    // context.signal — AbortSignal
    // context.onUpdate — stream partial results
    // context.approval — approval interface
    // context.agentName — parent agent name
    const text = await fs.readFile(params.path, "utf-8");
    return { content: [{ type: "text", text }] };
  },
};
```

Parallel mode: approval and beforeToolCall hooks run sequentially (preflight), then all approved tools execute concurrently.

### Approval

Queue-based approval system with three modes:

```typescript
const agent = createAgent({
  approval: {
    yolo: true,                              // Auto-approve everything
    autoApproveActions: ["file:read"],        // Auto-approve specific actions
  },
  ...
});

// UI integration — pull pending requests and resolve them
const request = await agent.approval.fetchRequest();
// request: { id, toolCallId, sender, action, description }
agent.approval.resolve(request.id, "approve");             // One-time approve
agent.approval.resolve(request.id, "approve_for_session"); // Auto-approve this action going forward
agent.approval.resolve(request.id, "reject");

// Subagents share yolo/autoApproveActions state via approval.share()
```

### Thinking

Six-level extended thinking budget:

```typescript
const agent = createAgent({
  thinkingLevel: "medium",  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxContextTokens: 200000,
    capabilities: { thinking: true },
  },
  ...
});

// Change at runtime
agent.setThinkingLevel("high");
```

Token budgets: minimal=1024, low=4096, medium=10240, high=20480, xhigh=40960.

### Session Persistence

JSONL tree-based session storage with branching and restore.

```typescript
const agent = createAgent({
  session: {
    persist: true,
    directory: "./sessions",
    sessionId: "my-session",  // Optional, auto-generated if omitted
  },
  ...
});

// Access session tree
const tree = agent.session.getTree();
const branch = agent.session.getBranch();

// Branch from a specific entry
agent.session.branch(entryId);

// Entry types: message | compaction | branch_summary | model_change |
//              thinking_level_change | checkpoint | custom
```

Session file format: first line is a header `{ type: "session", version: 1, id, timestamp }`, followed by one JSON entry per line, each with `{ type, id, parentId, timestamp, ... }`.

### Compaction

Automatic context compression when token count exceeds threshold.

```typescript
const agent = createAgent({
  compaction: {
    enabled: true,
    maxContextTokens: 200000,   // Defaults to model.maxContextTokens
    reserveTokens: 16384,       // Reserve for output
    keepRecentTokens: 20000,    // Keep recent messages
    customSummarizer: mySummarizer,  // Optional custom summarizer
  },
  ...
});
```

Flow: estimate tokens → check threshold → find cut point (respects tool_result boundaries) → summarize discarded messages via LLM → replace with `<compaction-summary>` → persist to session.

Built-in `LLMSummarizer` uses the same provider to generate summaries. Supports incremental summarization with `previousSummary`.

### Checkpoint + D-Mail

Time-travel via the Steins;Gate-inspired D-Mail mechanism. Checkpoints are created before each agent loop step.

```typescript
const agent = createAgent({
  session: { persist: true, directory: "./sessions" },
  checkpoint: { enabled: true, enableDMail: true },
  ...
});

// Send a D-Mail — branches session tree back to target checkpoint
agent.checkpoints.denwaRenji.sendDMail("Try a different approach", checkpointId);

// The agent loop automatically:
// 1. Detects pending D-Mail after tool execution
// 2. Branches session tree to target checkpoint
// 3. Injects D-Mail content as <dmail> message
// 4. Continues execution from that point
```

### Dynamic Injection

Inject context into the message stream before each LLM call, without modifying the persistent history.

```typescript
const agent = createAgent({
  injection: [
    {
      async getInjections(history) {
        return [
          { type: "memory", content: "User prefers TypeScript" },
          { type: "context", content: `Current time: ${new Date().toISOString()}` },
        ];
      },
    },
  ],
  ...
});
```

Injections are wrapped as `<system-reminder type="...">` user messages. History normalization merges adjacent user messages to maintain valid message alternation.

### Multi-Agent

LaborMarket registry with fixed and dynamic subagents. The LLM delegates via the built-in `delegate_task` tool.

```typescript
const agent = createAgent({
  subagents: {
    researcher: {
      name: "researcher",
      systemPrompt: "You are a research assistant.",
      description: "Handles research tasks",
      tools: [searchTool],
    },
    writer: {
      name: "writer",
      systemPrompt: "You are a writing assistant.",
      description: "Handles writing tasks",
    },
  },
  ...
});

// Dynamic subagent registration at runtime
agent.laborMarket.addDynamic("analyst", analystAgent, "Data analysis");
agent.laborMarket.removeDynamic("analyst");
```

Subagents share the parent's approval state (yolo, autoApproveActions) but have independent approval queues. Subagent events are forwarded to the parent's event stream.

### Extensions

Event-driven plugin system with 18 event types across agent lifecycle, tool execution, LLM requests, context, compaction, session, and background tasks.

```typescript
import type { ExtensionFactory } from "@klaus-ai/agent";

const myExtension: ExtensionFactory = (api) => {
  // Register event handlers
  api.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + "\nExtra instructions." };
  });

  api.on("tool_call", (event) => {
    if (event.toolName === "dangerous_tool") {
      return { block: true, reason: "Not allowed" };
    }
  });

  api.on("before_provider_request", (event) => {
    return { messages: event.messages }; // Modify LLM request
  });

  api.on("context", (event) => {
    return { messages: [...event.messages, extraMsg] };
  });

  api.on("before_compact", (event) => {
    return { skip: true }; // Or provide custom summary
  });

  // Register tools
  api.registerTool(myTool);

  // Register commands
  api.registerCommand("my-command", async (args) => { ... });

  // Inject messages into the conversation
  api.sendMessage({ role: "user", content: "Injected by extension" });
};

const agent = createAgent({ extensions: [myExtension], ... });
```

Interceptable events (return values modify behavior): `before_agent_start`, `before_provider_request`, `tool_call`, `tool_result`, `context`, `before_compact`.

Notification events (fire-and-forget): `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_end`, `after_compact`, `session_start`, `session_switch`, `session_fork`, `task_started`, `task_completed`, `task_failed`.

### Skills

Markdown-based skill discovery with frontmatter parsing and template rendering.

```typescript
const agent = createAgent({
  skills: [{ directory: "./skills", pattern: ".md" }],
  ...
});
```

Skill file format (`./skills/review.md`):

```markdown
---
name: review
description: Code review checklist
---

Review the code for:
- Security: {{focus_area}}
- Performance issues
- Code style
```

The LLM invokes skills via the built-in `invoke_skill` tool with optional template variables.

### MCP (Model Context Protocol)

Connect to MCP servers and expose their tools to the agent.

```typescript
const agent = createAgent({
  mcp: {
    servers: [
      {
        name: "filesystem",
        transport: { type: "stdio", command: "mcp-server-fs", args: ["--root", "/tmp"] },
        timeout: 30000,
      },
      {
        name: "web",
        transport: { type: "sse", url: "http://localhost:3001/sse" },
      },
    ],
    clientFactory: (config) => new MyMCPClient(config),
  },
  ...
});

// Check server statuses
const statuses = agent.mcpAdapter.getStatuses();
// [{ name: "filesystem", status: "connected", tools: [...] }]
```

MCP tools are namespaced as `{serverName}__{toolName}` and require approval via `mcp:{serverName}:{toolName}` action.

### Wire (Event Channel)

Typed async pub/sub event channel with optional replay buffer. All agent events are automatically published to the wire.

```typescript
const agent = createAgent({
  wire: { bufferSize: 100 },  // Buffer last 100 messages for late subscribers
  ...
});

// Subscribe to specific event types
agent.wire.on("tool_execution_end", (msg) => {
  console.log(`Tool ${msg.payload.toolName} completed`);
});

// Subscribe to all events
agent.wire.subscribe((msg) => {
  console.log(msg.type, msg.payload);
}, { replay: true });  // Replay buffered messages

// Publish custom events
agent.wire.publish("custom_event", { data: "hello" });
```

### Background Tasks

In-process async task execution with lifecycle events. The LLM manages tasks via built-in tools.

```typescript
const agent = createAgent({
  backgroundTasks: {
    factories: {
      build: async (args, signal) => {
        // Long-running task with abort support
        return { success: true };
      },
    },
  },
  ...
});

// Programmatic access
const handle = agent.backgroundTasks.spawn("my-task", async (signal) => {
  return await doWork(signal);
});

console.log(handle.status);  // "running" | "completed" | "failed"
handle.abort();
```

Built-in tools: `start_background_task`, `check_task_status`, `get_task_result`.

### Hooks

User-level hooks for transforming context and intercepting tool calls:

```typescript
const agent = createAgent({
  hooks: {
    // Transform messages before sending to LLM
    transformContext: async (messages) => {
      return messages.filter(m => ...);
    },
    // Custom message format conversion
    convertToLlm: (messages) => {
      return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool_result");
    },
    // Before/after tool execution
    beforeToolCall: async (ctx) => {
      // return { block: true, reason: "..." } to block
    },
    afterToolCall: async (ctx) => {
      // return { content, details, isError } to modify result
    },
  },
  ...
});
```

## Events

Subscribe to the agent event stream for real-time updates:

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "agent_end":           // { messages }
    case "turn_start":
    case "turn_end":            // { message, toolResults }
    case "message_start":       // { message }
    case "message_update":      // { message, event: text|tool_call_start|tool_call_delta|thinking|done }
    case "message_end":         // { message, usage }
    case "tool_execution_start":  // { toolCallId, toolName, args }
    case "tool_execution_update": // { toolCallId, toolName, partialResult }
    case "tool_execution_end":    // { toolCallId, toolName, result, isError }
    case "approval_request":    // { request }
    case "approval_response":   // { requestId, response }
    case "compaction_start":
    case "compaction_end":      // { summary }
    case "checkpoint":          // { id }
    case "dmail_received":      // { checkpoint, content }
    case "task_started":        // { taskId, taskName }
    case "task_completed":      // { taskId, taskName }
    case "task_failed":         // { taskId, taskName, error }
    case "error":               // { error }
  }
});
```

## Full Example

```typescript
import { createAgent } from "@klaus-ai/agent";
import { Type } from "@sinclair/typebox";

const agent = createAgent({
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxContextTokens: 200000,
    capabilities: { vision: true, thinking: true },
  },
  systemPrompt: "You are a coding assistant.",
  tools: [readFileTool, writeFileTool, searchTool],
  thinkingLevel: "medium",
  toolExecution: "parallel",
  maxStepsPerTurn: 30,

  approval: { autoApproveActions: ["file:read", "search"] },

  session: { persist: true, directory: "./sessions" },
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  checkpoint: { enabled: true, enableDMail: true },

  injection: [memoryProvider, contextProvider],
  extensions: [loggingExtension, guardExtension],

  subagents: {
    researcher: {
      name: "researcher",
      systemPrompt: "You research topics thoroughly.",
      description: "Research assistant",
      tools: [searchTool],
    },
  },

  skills: [{ directory: "./skills" }],

  mcp: {
    servers: [{ name: "fs", transport: { type: "stdio", command: "mcp-fs" } }],
    clientFactory: (config) => new MCPClient(config),
  },

  wire: { bufferSize: 100 },
  backgroundTasks: { factories: { build: buildTaskFactory } },

  hooks: {
    transformContext: async (msgs) => msgs,
    beforeToolCall: async (ctx) => {},
    afterToolCall: async (ctx) => {},
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.event.type === "text") {
    process.stdout.write(event.event.text);
  }
});

await agent.prompt("Help me refactor the auth module");
await agent.dispose();
```

## API Reference

### `createAgent(config): Agent`

| Config | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `model` | `ModelConfig` | yes | — | Provider, model ID, maxContextTokens, capabilities |
| `systemPrompt` | `string \| () => string` | yes | — | Static or dynamic system prompt |
| `tools` | `AgentTool[]` | yes | — | Tool definitions with TypeBox schemas |
| `approval` | `ApprovalConfig` | no | `{}` | yolo, autoApproveActions |
| `thinkingLevel` | `ThinkingLevel` | no | `"off"` | Extended thinking budget |
| `toolExecution` | `"sequential" \| "parallel"` | no | `"parallel"` | Tool execution mode |
| `maxStepsPerTurn` | `number` | no | `50` | Max inner loop iterations |
| `hooks` | `AgentHooks` | no | — | transformContext, convertToLlm, beforeToolCall, afterToolCall |
| `session` | `SessionConfig` | no | — | persist, directory, sessionId |
| `compaction` | `CompactionConfig` | no | — | enabled, reserveTokens, keepRecentTokens, customSummarizer |
| `checkpoint` | `CheckpointConfig` | no | — | enabled, enableDMail |
| `injection` | `DynamicInjectionProvider[]` | no | — | Dynamic context providers |
| `extensions` | `ExtensionFactory[]` | no | — | Plugin factories |
| `subagents` | `Record<string, SubagentConfig>` | no | — | Named subagent configs |
| `skills` | `SkillSource[]` | no | — | Skill directories |
| `mcp` | `{ servers, clientFactory }` | no | — | MCP server configs |
| `wire` | `{ bufferSize }` | no | `{ bufferSize: 0 }` | Event channel config |
| `backgroundTasks` | `{ factories }` | no | — | Background task factories |
| `provider` | `LLMProvider` | no | — | Custom LLM provider (bypasses registry) |

### `Agent` Instance

| Method / Property | Description |
|-------------------|-------------|
| `prompt(input)` | Send input and run the agent loop. Returns all messages. |
| `continue()` | Re-enter the loop without new input. |
| `steer(message)` | Inject a message after current tool execution. |
| `followUp(message)` | Inject a message after inner loop completes. |
| `abort()` | Abort the current run. |
| `subscribe(fn)` | Subscribe to events. Returns unsubscribe function. |
| `dispose()` | Cleanup all resources. |
| `state` | Current `AgentState` (systemPrompt, model, tools, messages, isRunning). |
| `approval` | `Approval` instance. |
| `session` | `SessionManager` (if configured). |
| `checkpoints` | `CheckpointManager` (if configured). |
| `extensions` | `ExtensionRunner` (if configured). |
| `injections` | `InjectionManager` (if configured). |
| `laborMarket` | `LaborMarket` (if subagents configured). |
| `mcpAdapter` | `MCPAdapter` (if MCP configured). |
| `wire` | `Wire` event channel (always available). |
| `backgroundTasks` | `BackgroundTaskManager` (if configured). |
| `setSystemPrompt(prompt)` | Update system prompt. |
| `setModel(model)` | Update model config. |
| `setTools(tools)` | Replace tools (not while running). |
| `setThinkingLevel(level)` | Update thinking level (not while running). |
