# @klaus-ai/agent

通用 Agent 框架 SDK。注入 tools、skills、systemPrompt 即可构建 agent，无需再包一层。

## 安装

```bash
npm install @klaus-ai/agent
```

## 快速开始

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

// 订阅流式事件
agent.subscribe((event) => {
  if (event.type === "message_update" && event.event.type === "text") {
    process.stdout.write(event.event.text);
  }
});

const messages = await agent.prompt("Say hello");
```

## 架构

单包架构，15 个模块，零包装层。所有能力内置，通过 config 按需启用。

```
src/
├── core/           Agent + AgentLoop（嵌套双循环运行时）
├── llm/            Provider 注册中心 + 抽象层
├── providers/      5 个内置协议 Provider（Anthropic、OpenAI、OpenAI Responses、OpenAI Codex、Gemini）
├── tools/          工具执行器（顺序/并行）+ MCP 适配器
├── approval/       基于队列的审批系统
├── session/        JSONL 树形持久化，支持分支
├── compaction/     Token 估算 + LLM 摘要压缩
├── checkpoint/     检查点 + D-Mail 时间旅行
├── injection/      动态上下文注入 + 历史消息规范化
├── multi-agent/    LaborMarket 子 Agent 注册 + TaskExecutor
├── extensions/     事件驱动的插件系统
├── skills/         Markdown 技能发现 + 模板渲染
├── wire/           类型化异步事件通道，支持回放缓冲
├── background/     进程内异步任务管理器
├── planning/       两阶段规划 + 结构化 todo + nag 注入
└── utils/          ID 生成 + JSONL 工具
```

## 模块

### 核心 — Agent 循环

嵌套双循环执行引擎：

- 内循环：LLM 调用 → 工具执行 → steering 消息 → 重复直到没有工具调用
- 外循环：follow-up 消息 → 重新进入内循环

每一步集成：检查点 → 压缩检查 → 动态注入 → 历史规范化 → 扩展 context hook → LLM 流式调用 → 工具执行 → D-Mail 检查 → steering。

```typescript
const agent = createAgent({
  model: { provider: "anthropic", model: "claude-sonnet-4-20250514", maxContextTokens: 200000 },
  systemPrompt: "You are a helpful assistant.",
  tools: [...],
  maxStepsPerTurn: 50,        // 内循环最大迭代次数（默认 50）
  toolExecution: "parallel",   // "sequential" | "parallel"（默认 "parallel"）
});

// 发送 prompt
const messages = await agent.prompt("Hello");

// 无新输入继续执行
const more = await agent.continue();

// 运行中注入消息
agent.steer({ role: "user", content: "Focus on X" });   // 当前工具执行完成后注入
agent.followUp({ role: "user", content: "Also do Y" }); // 内循环结束后注入

// 中止
agent.abort();

// 清理资源
await agent.dispose();
```

### LLM Provider

Provider 无关的抽象层，内置 5 个协议 Provider。所有 Provider 支持流式输出、重试（3 次，指数退避）和扩展思考。通过自定义 `baseUrl` 即可接入任何兼容服务。

内置 Provider：`anthropic`、`openai`、`openai-responses`、`openai-codex`、`google`

```typescript
// 使用内置 Provider
const agent = createAgent({
  model: { provider: "openai", model: "gpt-4", maxContextTokens: 128000 },
  ...
});

// 通过自定义 baseUrl 接入兼容服务
const agent2 = createAgent({
  model: { provider: "openai", model: "my-model", maxContextTokens: 128000, baseUrl: "https://my-service/v1" },
  ...
});

// 注册完全自定义的 Provider
import { registerProvider } from "@klaus-ai/agent";
registerProvider("my-provider", (config) => new MyProvider(config.apiKey, config.baseUrl));
```

Provider 接口：

```typescript
interface LLMProvider {
  stream(options: LLMRequestOptions): AsyncIterable<AssistantMessageEvent>;
}

// 流式事件类型：text | tool_call_start | tool_call_delta | thinking | done | error
```

成本追踪 — 通过 `ModelConfig.cost` 提供每百万 token 的单价，agent 会在每次 `message_end` 事件中自动计算实际成本：

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
    console.log(`请求成本: $${event.usage.cost.total.toFixed(6)}`);
  }
});
```

### 标准消息格式

框架内部使用的 Provider 无关消息类型：

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

可通过 `CustomAgentMessages` 接口扩展自定义消息类型。

### 工具

工具使用 TypeBox schema 进行参数校验。执行器支持顺序和并行模式，带审批拦截。

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
  approvalAction: "file:read",  // 非 yolo 模式下触发审批

  async execute(toolCallId, params, context) {
    // context.signal — AbortSignal
    // context.onUpdate — 流式推送部分结果
    // context.approval — 审批接口
    // context.agentName — 父 Agent 名称
    const text = await fs.readFile(params.path, "utf-8");
    return { content: [{ type: "text", text }] };
  },
};
```

并行模式：审批和 beforeToolCall hook 顺序执行（预检），然后所有已批准的工具并发执行。

### 审批

基于队列的审批系统，三种模式：

```typescript
const agent = createAgent({
  approval: {
    yolo: true,                              // 自动批准所有操作
    autoApproveActions: ["file:read"],        // 自动批准指定操作
  },
  ...
});

// UI 集成 — 拉取待审批请求并处理
const request = await agent.approval.fetchRequest();
// request: { id, toolCallId, sender, action, description }
agent.approval.resolve(request.id, "approve");             // 单次批准
agent.approval.resolve(request.id, "approve_for_session"); // 本次会话内自动批准该操作
agent.approval.resolve(request.id, "reject");

// 子 Agent 通过 approval.share() 共享 yolo/autoApproveActions 状态
```

### 扩展思考

六级扩展思考预算：

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

// 运行时修改
agent.setThinkingLevel("high");
```

Token 预算：minimal=1024、low=4096、medium=10240、high=20480、xhigh=40960。

### 会话持久化

基于 JSONL 的树形会话存储，支持分支和恢复。

```typescript
const agent = createAgent({
  session: {
    persist: true,
    directory: "./sessions",
    sessionId: "my-session",  // 可选，省略时自动生成
  },
  ...
});

// 访问会话树
const tree = agent.session.getTree();
const branch = agent.session.getBranch();

// 从指定条目创建分支
agent.session.branch(entryId);

// 条目类型：message | compaction | branch_summary | model_change |
//           thinking_level_change | checkpoint | custom
```

会话文件格式：首行为 header `{ type: "session", version: 1, id, timestamp }`，后续每行一个 JSON 条目，包含 `{ type, id, parentId, timestamp, ... }`。

### 压缩

Token 数超过阈值时自动压缩上下文。

```typescript
const agent = createAgent({
  compaction: {
    enabled: true,
    maxContextTokens: 200000,   // 默认使用 model.maxContextTokens
    reserveTokens: 16384,       // 为输出预留的 token 数
    keepRecentTokens: 20000,    // 保留最近消息的 token 数
    customSummarizer: mySummarizer,  // 可选自定义摘要器
  },
  ...
});
```

流程：估算 token → 检查阈值 → 找到切割点（尊重 tool_result 边界）→ 通过 LLM 摘要被丢弃的消息 → 替换为 `<compaction-summary>` → 持久化到会话。

内置 `LLMSummarizer` 使用同一 Provider 生成摘要，支持基于 `previousSummary` 的增量摘要。

### 检查点 + D-Mail

通过 Steins;Gate 风格的 D-Mail 机制实现时间旅行。每个 Agent 循环步骤前自动创建检查点。

```typescript
const agent = createAgent({
  session: { persist: true, directory: "./sessions" },
  checkpoint: { enabled: true, enableDMail: true },
  ...
});

// 发送 D-Mail — 将会话树分支回目标检查点
agent.checkpoints.denwaRenji.sendDMail("Try a different approach", checkpointId);

// Agent 循环自动处理：
// 1. 工具执行后检测待处理的 D-Mail
// 2. 将会话树分支到目标检查点
// 3. 注入 D-Mail 内容作为 <dmail> 消息
// 4. 从该点继续执行
```

### 动态注入

在每次 LLM 调用前向消息流注入上下文，不修改持久化历史。

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

注入内容包装为 `<system-reminder type="...">` user 消息。历史规范化会合并相邻的 user 消息以维持合法的消息交替。

### 多 Agent

LaborMarket 注册中心，支持固定和动态子 Agent。LLM 通过内置 `delegate_task` 工具进行委派。

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

// 运行时动态注册子 Agent
agent.laborMarket.addDynamic("analyst", analystAgent, "Data analysis");
agent.laborMarket.removeDynamic("analyst");
```

子 Agent 共享父 Agent 的审批状态（yolo、autoApproveActions），但拥有独立的审批队列。子 Agent 事件会转发到父 Agent 的事件流。

### 扩展

事件驱动的插件系统，覆盖 Agent 生命周期、工具执行、LLM 请求、上下文、压缩、会话和后台任务共 18 种事件类型。

```typescript
import type { ExtensionFactory } from "@klaus-ai/agent";

const myExtension: ExtensionFactory = (api) => {
  // 注册事件处理器
  api.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + "\nExtra instructions." };
  });

  api.on("tool_call", (event) => {
    if (event.toolName === "dangerous_tool") {
      return { block: true, reason: "Not allowed" };
    }
  });

  api.on("before_provider_request", (event) => {
    return { messages: event.messages }; // 修改 LLM 请求
  });

  api.on("context", (event) => {
    return { messages: [...event.messages, extraMsg] };
  });

  api.on("before_compact", (event) => {
    return { skip: true }; // 或提供自定义摘要
  });

  // 注册工具
  api.registerTool(myTool);

  // 注册命令
  api.registerCommand("my-command", async (args) => { ... });

  // 向对话注入消息
  api.sendMessage({ role: "user", content: "Injected by extension" });
};

const agent = createAgent({ extensions: [myExtension], ... });
```

可拦截事件（返回值可修改行为）：`before_agent_start`、`before_provider_request`、`tool_call`、`tool_result`、`context`、`before_compact`。

通知事件（仅触发）：`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_end`、`after_compact`、`session_start`、`session_switch`、`session_fork`、`task_started`、`task_completed`、`task_failed`。

### Skills

基于 Markdown 的技能发现，支持 frontmatter 解析和模板渲染。

```typescript
const agent = createAgent({
  skills: [{ directory: "./skills", pattern: ".md" }],
  ...
});
```

技能文件格式（`./skills/review.md`）：

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

LLM 通过内置 `invoke_skill` 工具调用技能，支持可选的模板变量。

### MCP（Model Context Protocol）

连接 MCP 服务器，将其工具暴露给 Agent。

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

// 检查服务器状态
const statuses = agent.mcpAdapter.getStatuses();
// [{ name: "filesystem", status: "connected", tools: [...] }]
```

MCP 工具命名空间为 `{serverName}__{toolName}`，需通过 `mcp:{serverName}:{toolName}` action 审批。

### Wire（事件通道）

类型化异步发布/订阅事件通道，支持可选的回放缓冲。所有 Agent 事件自动发布到 Wire。

```typescript
const agent = createAgent({
  wire: { bufferSize: 100 },  // 缓冲最近 100 条消息供后续订阅者回放
  ...
});

// 订阅特定事件类型
agent.wire.on("tool_execution_end", (msg) => {
  console.log(`Tool ${msg.payload.toolName} completed`);
});

// 订阅所有事件
agent.wire.subscribe((msg) => {
  console.log(msg.type, msg.payload);
}, { replay: true });  // 回放缓冲消息

// 发布自定义事件
agent.wire.publish("custom_event", { data: "hello" });
```

### 后台任务

进程内异步任务执行，带生命周期事件。LLM 通过内置工具管理任务。

```typescript
const agent = createAgent({
  backgroundTasks: {
    factories: {
      build: async (args, signal) => {
        // 支持中止信号的长时间任务
        return { success: true };
      },
    },
  },
  ...
});

// 编程式访问
const handle = agent.backgroundTasks.spawn("my-task", async (signal) => {
  return await doWork(signal);
});

console.log(handle.status);  // "running" | "completed" | "failed"
handle.abort();
```

内置工具：`start_background_task`、`check_task_status`、`get_task_result`。

### Planning（两阶段 Todo）

可选的两阶段规划系统。结合结构化 todo 管理、阶段性工具访问控制和 nag 提醒。

```typescript
const agent = createAgent({
  planning: {
    readOnlyTools: ["read_file", "search"],  // 规划阶段可用的工具
    nagAfterRounds: 3,                        // 连续 N 轮不更新 todo 后注入提醒
    nagMessage: "<reminder>更新你的 todo。</reminder>",  // 自定义提醒文本
    maxTodos: 50,                             // todo 数量上限（默认 50）
  },
  ...
});

// 访问规划状态
console.log(agent.planning?.phase);  // "planning" | "executing"
console.log(agent.planning?.todos);  // readonly TodoItem[]
```

**工作流：**

1. Agent 启动后进入 **planning 阶段** — 只有 `readOnlyTools` + `todo` + `plan_mode` 工具可用
2. LLM 使用 `todo` 工具创建结构化计划（同一时间只允许一个 `in_progress` 项）
3. LLM 调用 `plan_mode({ action: "start_execution" })` 切换到 **execution 阶段**
4. 执行阶段所有工具可用；如果 LLM 连续 3+ 轮不更新 todo，自动注入 `<reminder>`
5. 随时可通过 `plan_mode({ action: "switch_to_planning" })` 切回规划阶段

内置工具：`todo`、`plan_mode`。

如果 `readOnlyTools` 未配置或为空，规划阶段所有工具仍可用（阶段分离仅通过工具描述建议模型遵守）。

### Hooks

用户级 hook，用于转换上下文和拦截工具调用：

```typescript
const agent = createAgent({
  hooks: {
    // 发送给 LLM 前转换消息
    transformContext: async (messages) => {
      return messages.filter(m => ...);
    },
    // 自定义消息格式转换
    convertToLlm: (messages) => {
      return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool_result");
    },
    // 工具执行前/后拦截
    beforeToolCall: async (ctx) => {
      // return { block: true, reason: "..." } 可阻止执行
    },
    afterToolCall: async (ctx) => {
      // return { content, details, isError } 可修改结果
    },
  },
  ...
});
```

## 事件

订阅 Agent 事件流获取实时更新：

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

## 完整示例

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
  planning: { readOnlyTools: ["read_file", "search"], nagAfterRounds: 3 },

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

## API 参考

### `createAgent(config): Agent`

| 配置项 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `model` | `ModelConfig` | 是 | — | Provider、模型 ID、maxContextTokens、capabilities |
| `systemPrompt` | `string \| () => string` | 是 | — | 静态或动态系统提示词 |
| `tools` | `AgentTool[]` | 是 | — | 使用 TypeBox schema 的工具定义 |
| `approval` | `ApprovalConfig` | 否 | `{}` | yolo、autoApproveActions |
| `thinkingLevel` | `ThinkingLevel` | 否 | `"off"` | 扩展思考预算 |
| `toolExecution` | `"sequential" \| "parallel"` | 否 | `"parallel"` | 工具执行模式 |
| `maxStepsPerTurn` | `number` | 否 | `50` | 内循环最大迭代次数 |
| `hooks` | `AgentHooks` | 否 | — | transformContext、convertToLlm、beforeToolCall、afterToolCall |
| `session` | `SessionConfig` | 否 | — | persist、directory、sessionId |
| `compaction` | `CompactionConfig` | 否 | — | enabled、reserveTokens、keepRecentTokens、customSummarizer |
| `checkpoint` | `CheckpointConfig` | 否 | — | enabled、enableDMail |
| `injection` | `DynamicInjectionProvider[]` | 否 | — | 动态上下文 Provider |
| `extensions` | `ExtensionFactory[]` | 否 | — | 插件工厂 |
| `subagents` | `Record<string, SubagentConfig>` | 否 | — | 命名子 Agent 配置 |
| `skills` | `SkillSource[]` | 否 | — | 技能目录 |
| `mcp` | `{ servers, clientFactory }` | 否 | — | MCP 服务器配置 |
| `wire` | `{ bufferSize }` | 否 | `{ bufferSize: 0 }` | 事件通道配置 |
| `backgroundTasks` | `{ factories }` | 否 | — | 后台任务工厂 |
| `planning` | `PlanningConfig` | 否 | — | 两阶段规划，含 todo 管理和 nag 提醒 |
| `provider` | `LLMProvider` | 否 | — | 自定义 LLM Provider（绕过注册中心） |

### `Agent` 实例

| 方法 / 属性 | 说明 |
|-------------|------|
| `prompt(input)` | 发送输入并运行 Agent 循环，返回所有消息。 |
| `continue()` | 无新输入重新进入循环。 |
| `steer(message)` | 当前工具执行完成后注入消息。 |
| `followUp(message)` | 内循环结束后注入消息。 |
| `abort()` | 中止当前运行。 |
| `subscribe(fn)` | 订阅事件，返回取消订阅函数。 |
| `dispose()` | 清理所有资源。 |
| `state` | 当前 `AgentState`（systemPrompt、model、tools、messages、isRunning）。 |
| `approval` | `Approval` 实例。 |
| `session` | `SessionManager`（需配置）。 |
| `checkpoints` | `CheckpointManager`（需配置）。 |
| `extensions` | `ExtensionRunner`（需配置）。 |
| `injections` | `InjectionManager`（需配置）。 |
| `laborMarket` | `LaborMarket`（需配置子 Agent）。 |
| `mcpAdapter` | `MCPAdapter`（需配置 MCP）。 |
| `wire` | `Wire` 事件通道（始终可用）。 |
| `backgroundTasks` | `BackgroundTaskManager`（需配置）。 |
| `planning` | `PlanningManager`（需配置）。 |
| `setSystemPrompt(prompt)` | 更新系统提示词。 |
| `setModel(model)` | 更新模型配置。 |
| `setTools(tools)` | 替换工具（运行中不可调用）。 |
| `setThinkingLevel(level)` | 更新思考级别（运行中不可调用）。 |
