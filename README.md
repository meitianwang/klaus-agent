# @klaus/agent

A universal agent framework SDK. Just inject tools, skills, and systemPrompt to build your agent — no wrapper needed.

通用 Agent 框架 SDK。注入 tools、skills、systemPrompt 即可构建 agent，无需再包一层。

## Install / 安装

```bash
npm install @klaus/agent
```

## Quick Start / 快速开始

```typescript
import { createAgent } from "@klaus/agent";
import { Type } from "@sinclair/typebox";

const echoTool = {
  name: "echo",
  label: "Echo",
  description: "Echo back the input",
  parameters: Type.Object({ text: Type.String() }),
  async execute(id, params) {
    return { content: [{ type: "text", text: params.text }] };
  },
};

const agent = createAgent({
  model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  systemPrompt: "You are a helpful assistant",
  tools: [echoTool],
  approval: { yolo: true },
});

agent.subscribe((event) => console.log(event.type));
const messages = await agent.prompt("hello");
```

## Features / 能力

| Module | Description | 说明 |
|--------|-------------|------|
| Agent Loop | Nested dual-loop with steering/follow-up | 嵌套双循环 + steering/follow-up |
| Approval | Queue-based approval, YOLO, auto-approve | 队列式审批、YOLO、auto-approve |
| Session | JSONL tree persistence, branching, restore | JSONL 树形持久化、分支、恢复 |
| Compaction | Token estimation, cut point, LLM summary | Token 估算、切割点、LLM 摘要 |
| Checkpoint | D-Mail time travel | D-Mail 时间旅行 |
| Injection | Dynamic injection + history normalization | 动态注入 + 历史归一化 |
| Multi-Agent | LaborMarket + built-in delegate_task tool | LaborMarket + 内置 delegate_task |
| Extension | Event subscription + tool registration | 事件订阅 + tool 注册 |
| Skills | Directory scanning + built-in invoke_skill tool | 目录扫描 + 内置 invoke_skill |
| MCP | Server connection + tool wrapping | 服务器连接 + 工具包装 |
| LLM | Anthropic provider with retry | Anthropic provider + 重试 |

## Full Example / 完整示例

```typescript
import { createAgent } from "@klaus/agent";

const agent = createAgent({
  model: { provider: "anthropic", model: "claude-sonnet-4-20250514", maxContextTokens: 200000 },
  systemPrompt: "You are a novel writing assistant",
  tools: [plotTool, characterTool, writeTool],

  // Approval / 审批
  approval: { yolo: true },

  // Session persistence / 会话持久化
  session: { persist: true, directory: "./sessions" },

  // Context compaction / 上下文压缩
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },

  // Checkpoint + D-Mail / 时间旅行
  checkpoint: { enabled: true, enableDMail: true },

  // Dynamic injection / 动态注入
  injection: [myInjectionProvider],

  // Extensions / 扩展
  extensions: [myExtension],

  // Sub-agents / 子 agent
  subagents: {
    researcher: {
      name: "researcher",
      systemPrompt: "You are a research assistant",
      description: "Handles research tasks",
    },
  },

  // Skills
  skills: [{ directory: "./skills" }],
});

const result = await agent.prompt("Help me outline a mystery novel");
```

## Architecture / 架构

Inspired by [Kimi](https://github.com/anthropics/kimi) and [Pi-Momo](https://github.com/anthropics/pi-momo), taking the best from both:

借鉴了 Kimi 和 Pi-Momo 两个项目的优点：

- From Kimi / 来自 Kimi: multi-agent orchestration, D-Mail, approval system, MCP integration
- From Pi-Momo / 来自 Pi-Momo: agent loop pattern, tree-based sessions, extension system, parallel tool execution

Key design decision: single package with all capabilities built-in. No need to build a `coding-agent` wrapper — the runtime is complete.

核心设计决策：单包内置所有能力。不需要再包一层 `coding-agent`，runtime 本身就是完整的。
