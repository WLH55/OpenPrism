# OpenPrism Harness

> 纯 TypeScript agent harness 库——完整复刻 [dsh（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)的 harness 能力：**机制照抄，架构不抄**。

不做 Cordis 插件、瀑布事件、profile/bundle 体系，全部机制以直接函数注入与回调落地。核心代码零平台依赖（不 import 任何 Node/RN 专属模块），Node、React Native、浏览器各接一份 `PlatformEnv` 即可运行同一份 harness。

## 现状

H1–H5 五个批次全部实现，72 测试全绿，`tsc --noEmit` 零错误。下一步：功能设计 + UI 设计（见[路线图](#路线图)）。设计文档与决策记录见 [docs](#文档)。

## 快速上手

```ts
import { createAgent, createOpenAICompatAdapter } from "openprism";

// 1. 平台能力注入（Node 示例；RN/浏览器换一份实现即可）
const env = { fetch, now: Date.now, randomUUID: crypto.randomUUID };

// 2. OpenAI 兼容 adapter——DeepSeek / GLM / Qwen / Moonshot / OpenRouter 一词覆盖
const adapter = createOpenAICompatAdapter(env, {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-...", // 仅来自你的配置，库不存储、不上传
});

// 3. 建 Agent，开聊
const agent = createAgent({
  env,
  adapter,
  model: { provider: "deepseek", model: "deepseek-chat", contextWindow: 64_000 },
  systemPrompt: () => "你是一个助手。", // 每 step 重取——动态上下文的正缝
  tools: [
    {
      name: "echo",
      description: "回声",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      output: {
        schema: { type: "object", properties: { text: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
      },
      execute: async (args) => ({ text: String((args as { text?: string })?.text ?? "") }),
    },
  ],
});

agent.subscribe(console.log);   // 活体事件流（text-delta 只走这里，不落日志）
agent.followup("你好");          // 开新 Turn
agent.steer("顺便换个话题");      // 插入当前 Turn 的下一步
agent.inject("背景：用户在上海"); // 静默捎带，不唤醒
await agent.whenIdle();
```

持久化会话：把默认内存日志换成 JSONL（文件 IO 注入），重开后续排 seq、恢复重试预算与替换代数，接着聊：

```ts
import { createAgent, JsonlSessionLog } from "openprism";

const log = await JsonlSessionLog.open(fileIO, "session-a.jsonl"); // 每会话一个 Agent、一份日志
const agent = createAgent({ env, sessionLog: log, /* … */ });
```

## 六模块

| 模块 | 职责 |
|---|---|
| `src/harness/core` | 循环机器：kick→turn→step 三层状态机、Inbox 三通道（followup/steer/inject）、abort 保留部分输出、Turn Budget（默认 32，可设 Infinity）、请求组装与 `onRequest` 拦截 |
| `src/harness/llm` | LlmFailure 十码归一、OpenAI 兼容 adapter（SSE 流式、跨 chunk 工具累积、自写增量 UTF-8 解码防中文截断、流空闲看门狗）、mock adapter |
| `src/harness/session` | 九事件词表、内存/JSONL 双实现、`deriveMessages` 投影（遮蔽区间 + 裁剪）——model-visible means logged 的落点 |
| `src/harness/retry` | 指数退避 + 对称抖动、Retry-After 优先、重试预算从日志恢复（崩溃重启不重置） |
| `src/harness/tools` | canonical JSON 契约、七路失败全部 isError 化、Promise.race 硬超时、fail-closed 并发分类、有界滚动池（10） |
| `src/harness/context` | 启发式 token 计量、0.8 压力阈值、两阶段压缩（裁剪恒在投影 + LLM 摘要：KV 前缀复用、配对边界回退、事务提交、shrink 校验）、替换代数闸溢出重试 |

## 核心机制速览

- **Turn/Step 状态机**：一个 Turn = 完整处理一次输入（0+ 个 step），一个 step = 一次模型请求 + 其全部工具调用。Turn 结束原因结构化六种（completed/blocked/max-tokens/aborted/error/budget-exhausted），max-tokens 粘性。
- **会话日志是唯一真相**：发生过的一切落九类事件；模型可见历史由 `deriveMessages` 从日志投影，每条发出的请求都能从日志前缀重建（不变量测试守护）。
- **错误即 LlmFailure**：适配器边界之外不存在厂商原始错误；可重试码走退避重试，上下文溢出单独路由给压缩，且只有替换代数前进才允许重试一次。
- **工具永不悬空**：超时、取消、预算用尽、工具体抛错……全部归一为结构化 isError 结果，历史里不存在没有结果的 tool_call。

与 dsh 的六条刻意差异（无插件体系、消息粒度日志、Turn Budget、无审批/沙箱、仅 OpenAI 兼容 adapter、无 maintenance phase）见设计文档 §12——它们是有意的，不要"修复"。

## 开发

```bash
pnpm install
pnpm test        # vitest：196 个测试，零网络、时钟与随机全注入，确定性
pnpm typecheck   # tsc --noEmit
```

### 应用层存储（ADR 0008）

app 层（`src/app/`）以 SQLite 为唯一持久层（Node 内置 `node:sqlite`，**要求 Node ≥ 22.13**）：领域表建模
（users/sessions/ledger_entries/conversations/conversation_events/tasks/...），读路径按需 SQL 查询 +
活跃工作集缓存。旧版 JSONL 数据首次启动自动一次性导入（`data/*.jsonl` 原样保留不删除）；BYOK Key 以
AES-256-GCM 密文入库，主密钥在 `data/secret.key`。环境变量：`OP_DATA`（默认 `./data`）、`OP_PORT`（默认 8787）、
`OP_DB`（默认 `{OP_DATA}/openprism.db`）。备份请用 `VACUUM INTO`（WAL 模式下不要裸拷 `-wal` 伴生文件）。

## 文档

- [设计文档：2026-09 harness](docs/design/2026-09-harness.md)——现行权威规格（12 节）
- [ADR 0005：harness 先行](docs/adr/0005-harness-first-foundation.md)、[ADR 0006：复刻范围](docs/adr/0006-replication-scope.md)
- [CONTEXT.md](CONTEXT.md)——领域术语表（15 词条）
- 前史：[2026-08 插件路线纪要](docs/design/2026-08-feature-design.md)、[2026-09 移动端重写纪要](docs/design/2026-09-mobile-app.md)（均已推翻，保留为决策存档；对应代码在 git 历史）

## 路线图

1. ✅ harness 复刻（H1–H5）
2. ⏳ 功能设计 + UI 设计（基于本 harness 的应用层）
3. ⏳ 应用开发（含多会话管理、宿主 `PlatformEnv` 接入）
4. ⏳ 定时任务 / 无头场景（harness 已为此保持运行时无关；`inject` 通道与 `onRequest` 换路由已备好）
5. ⏳ 用户长期记忆（经 `systemPrompt()` 动态缝注入的 memory 模块，功能设计阶段定方案）
