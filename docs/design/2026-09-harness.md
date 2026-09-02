# OpenPrism Harness 设计文档

日期：2026-09-02 ｜ 状态：已终审，H1–H5 全部实现（src/harness/，72 测试全绿）
前置决策：[ADR 0005（harness 先行）](../adr/0005-harness-first-foundation.md)、[ADR 0006（复刻范围）](../adr/0006-replication-scope.md)
术语：以根目录 [CONTEXT.md](../../CONTEXT.md) 为准。

## 1. 目标与边界

完整复刻 dsh（DeepSeek Harness）的 harness 能力为独立地基：**机制照抄，架构不抄**——不引入 Cordis 插件、瀑布事件、profile/bundle 体系，全部机制以直接函数注入与回调落地。

**做**：循环机器、错误与重试、上下文管理、工具管线、会话持久化、请求组装（六组，见 ADR 0006）。
**不做**：审批、沙箱、fs 写意图门、subagent、agent teams、Code Mode（回访条件见 ADR 0006）。

## 2. 形态：纯 TypeScript 库

- 零平台依赖：核心代码不 import 任何 Node/RN 专属模块；
- 平台能力收拢进 `PlatformEnv` 注入：`fetch`、`now()`、`randomUUID()`、文件 IO（`appendLine` / `readAll`）；
- 测试在 Node + vitest 里跑全套（mock adapter 注入），宿主将来接一份 env 实现即可运行。

```
src/harness/
├── core/       循环机器（turn/step 状态机、Inbox、cancel、Turn Budget）
├── llm/        LlmAdapter 接口 + OpenAI 兼容默认 adapter + LlmFailure 归一化
├── tools/      ToolDefinition 契约 + 注册表 + 执行管线
├── context/    token 计量 + 压力 + 两阶段压缩 + Surface 投影
├── session/    会话事件日志（词表、内存实现、JSONL 实现）
└── retry/      重试器（退避/抖动/Retry-After/预算持久化）
```

## 3. 循环机器（core）

三层状态机，对齐 dsh `agent.ts`：

```
kick()    外层：while (turn())——Inbox 有待处理就开新 Turn
└─ turn()  Turn 边界：turn/start → … → turn/end{reason}
   └─ step() 一次模型请求 + 其全部工具调用
```

- **Turn 结束原因**（结构化，五种 + 我们新增一种）：`completed | blocked | max-tokens | aborted | error | budget-exhausted`。max-tokens 粘性：一步撞顶后，后续正常步骤不得降级 Turn 结论。
- **Inbox 三通道**：`followup`（唤醒、开新 Turn）、`steer`（唤醒、插入当前 Turn 下一步）、`inject`（不唤醒、等下次请求捎带）。取消后到达的唤醒输入归入 `next-turn`，不加入已中止的活动。
- **abort 保留部分输出**：流被中止时，已收到的内容组装为 `interrupted: true` 的 assistant 消息落日志，再抛出。
- **Turn Budget（对 dsh 的唯一补强）**：`maxStepsPerTurn` 默认 32，可设 `Infinity` 等价 dsh 行为。用尽时：给未回话的工具调用补合成 isError 结果（`code: TURN_BUDGET`，文本 `Error: turn budget exhausted`），Turn 以 `budget-exhausted` 收尾，事件流告知宿主——保证历史协议合法（不存在悬空的 tool_calls）。
- **turn-stopping 检查点**：做成可选串行回调 `onTurnStopping`（无瀑布），Turn 自然停止前调用。

## 4. 错误与重试（llm + retry）

### 4.1 LlmFailure 码表（llm/errors）

适配器把一切厂商错误归一为 `LlmFailure { code, status?, retryAfterMs?, message }`：

| code | 来源 | 可重试 |
|---|---|---|
| `AUTH` | 401/403 | ❌ |
| `QUOTA` | 余额/配额文案 | ❌ |
| `RATE_LIMIT` | 429 | ✅ |
| `SERVER` | ≥500 | ✅ |
| `TIMEOUT` | 流空闲看门狗 | ✅ |
| `TRANSPORT` | fetch/SSE 断流 | ✅ |
| `EMPTY_RESPONSE` | 完成但无内容 | ✅ |
| `CONTEXT_WINDOW_EXCEEDED` | 400 + 溢出文案正则（4 类模式） | ❌（交压缩） |
| `INVALID_REQUEST` | 400/413 其他 | ❌ |
| `ABORTED` | 调用方取消 | ❌ |

### 4.2 重试器（retry/）

- 策略默认：`maxRetries=5`、`initialDelayMs=500`、`maxDelayMs=10_000`、`jitterRatio=0.1`（对称抖动）；`retryableCodes = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`。
- 指数退避 `min(500 × 2^(n-1), 10s) × (1 - 0.1 + 0.2 × random())`；厂商 `Retry-After` 有效且 ≤ maxDelay 时直接采用且不加抖动。
- **重试预算持久化**：每次重试落 `llm/retry` 事件；恢复时从日志按 provider+model 计数，崩溃重启预算不重置；收到成功 assistant 消息即清零。
- **溢出单独路由**：`CONTEXT_WINDOW_EXCEEDED` 不进重试器，交压缩模块处理（§5），独立 `maxOverflowRetries=1` 预算；**只有替换代数前进才允许重试**，否则放行原始错误。

### 4.3 默认 adapter（llm/openai-compat）

OpenAI 兼容协议（覆盖 DeepSeek/GLM/Qwen/Moonshot/OpenRouter）：SSE 流式（`expo/fetch` 风格的注入 fetch，工具调用按 index 跨 chunk 累积、带状态 TextDecoder 防中文截断）+ 非流式；usage 从 `usage` chunk 归一（`prompt_tokens` 减去缓存命中为未缓存输入）。

## 5. 上下文管理（context/）

### 5.1 token 计量（双轨）

- **启发式**（实时压力判断）：chars/4 + 每内容块 4 + 每消息 role 开销 4；
- **精确 usage**（账单统计）：input / output / cacheRead（deepseek 缓存命中从 prompt_tokens 中减出）。

### 5.2 压力与触发

- `thresholdTokens = 0.8 × contextWindow`（窗口来自 adapter 模型信息，缺省可配）；每个 step 请求派生前测量，过阈触发压缩；失败仅告警不阻塞 Turn。
- 溢出错误强制触发（绕过阈值，保留尾部归零）。

### 5.3 两阶段压缩（先便宜后昂贵）

1. **裁剪**（零成本）：`tool/result` 文本 > 8192 字符 → 头 4096 + 尾 1024 + 占位符 `[... tool result middle pruned ...]`（按 Unicode code point 计量；非文本块不动）；
2. **摘要**（花 token）：保留尾部 `retainTokens = 0.16 × contextWindow`，从头部选可压缩区间，**边界回退至不切开 tool-call/result 配对**；摘要请求**复用会话前缀**（同 system + tools + 被压区间消息）以保 KV cache 命中，仅在末尾追加一条指令消息；输出结构化 Markdown（任务意图 / 关键概念 / 文件与代码 / 错误与修复 / 未竟事项 / 当前工作 / 下一步 / 关键上下文），要求精确保留路径、命令、错误串、数值。

### 5.4 事务与正确性

- `compaction/start` → 摘要 → **稳定性检查**（摘要期间 Surface 变更则放弃提交）→ `compaction/summary` 事件（含被遮蔽区间与摘要）+ checkpoint 消息整体替换区间 → `compaction/end`（失败也收尾）；
- **shrink 校验**：摘要估算 token 必须严格小于被遮蔽区间，否则抛错——压缩不许越压越大；
- **替换代数**：Surface 区间替换的单调计数，溢出恢复重试的闸门（§4.2）。

## 6. 工具管线（tools/）

### 6.1 ToolDefinition 契约

```ts
interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema            // 发给模型的 schema
  output: { schema: JsonSchema; render(args, value): ContentBlock[] }
  execute(args: unknown, ctx: ToolRunContext): Promise<unknown>   // 返回 canonical JSON
  timeoutMs?: number                // 自声明，无全局默认，绝不发给模型
  isConcurrencySafe?(args): boolean // 未声明/抛错/非 true 一律 exclusive（fail-closed）
  concludeTurn?: () => boolean      // 工具可主动结束 Turn（dsh 同款）
}
```

工具体返回 **canonical JSON value**（非文本块）——registry 负责 schema 校验与 `render`，UI 呈现与模型输入分离。

### 6.2 执行管线

`tool/call` 先落日志再执行 → 超时包装（派生 deadline 信号；超时返回 `Error: tool call timed out after Nms`，`code: TOOL_TIMEOUT`）→ 工具体 → **isError 归一化**：七种失败路径（工具体抛错 / 输出违约 / 快照失败 / 超时 / 取消前 / 取消后 / 管线自身抛错）全部收敛为 `{ isError: true, error: { message, code } }`，模型永远收到合法 `tool/result` → `tools/result` 冻结落日志。

### 6.3 并发调度

- 两态 executionMode：`parallel`（`isConcurrencySafe(args) === true` 精确判定）/ `exclusive`（单独成组即屏障）；
- 有界滚动池：`maxParallelToolCalls=10`，一个完成补一个；每组提交前**重新分类**（registry 变更影响未启动的调用）；
- 结果按模型给定顺序连续提交；abort 时未启动的调用合成 isError `ABORTED_BEFORE_DISPATCH` 结果。

## 7. 会话日志（session/）

### 7.1 九事件词表（消息粒度）

| 事件 | 载荷 |
|---|---|
| `turn/start` / `turn/end` | turn 序号；结束原因（§3） |
| `user/message` | 消息 + 进入通道（followup/steer/inject） |
| `assistant/message` | 完整消息 + usage + interrupted? |
| `tool/call` / `tool/result` | id/name/args；id/isError/content/code |
| `llm/retry` | attempt、code、delayMs（预算恢复源） |
| `compaction/summary` | 被遮蔽区间 [startSeq, endSeq] + 摘要 |
| `request/header` | provider/model/system 指纹/工具表指纹（仅变更时记） |

刻意不记：`assistant/chunk`（流式动画还原，不值手机写盘成本）、`step/start|end`（可从消息序列推导）。

### 7.2 接口与实现

```ts
interface SessionLog { append(event): seq; readAll(): Event[]; subscribe(cb): () => void }
```

内存实现为默认（测试零依赖）；JSONL 文件实现走注入的文件 IO；宿主可换任意载体。`deriveMessages()` 从日志投影模型可见历史（跳过遮蔽区间）——**model-visible means logged** 是被不变量测试守护的铁律。

## 8. 请求组装（core 内）

- 每次请求经 `onRequest` 可选回调（拦截点，可改路由——无头场景换便宜模型不动循环）；
- 配置指纹变更时落 `request/header`（排错"换模型后行为变了"有据可查）；
- system prompt 由宿主以 `systemPrompt: () => string` 动态提供，每 step 重取（延续"无启动快照过期"设计）。

## 9. 公共 API 草案

```ts
createAgent({
  env: PlatformEnv,                    // fetch/now/randomUUID/文件IO
  sessionLog: SessionLog,              // 默认内存实现
  adapter: LlmAdapter,                 // 默认 OpenAI 兼容
  model: { provider, model, contextWindow?, maxTokens? },
  systemPrompt: () => string,
  tools: ToolDefinition[],
  maxStepsPerTurn?: number,            // 默认 32
  retry?: Partial<RetryPolicy>,
  compaction?: Partial<CompactionConfig>,
  onRequest?, onTurnStopping?,
}) => Agent

Agent = {
  followup(text) / steer(text) / inject(text)
  cancel(opts?)                        // 默认清 Inbox
  whenIdle(): Promise<void>
  compact(): Promise<void>             // 手动压缩（要求 idle）
  subscribe(cb): () => void            // 活体事件流（text-delta 不落日志，只走这里）
  status: 'idle' | 'running'
}
```

## 10. 测试策略（零网络、确定性）

1. **Mock LlmAdapter**：脚本化返回文本/工具调用序列/各 code 失败/usage——不发网络；
2. 时钟与随机注入固定值——退避、抖动、预算恢复可精确断言；
3. 六层测试面对应六模块：循环（turn/step/三通道/abort 部分保留/预算用尽）、重试（白名单/退避数学/Retry-After/崩溃恢复）、压缩（压力/裁剪规则/摘要/替换代数只进不退）、管线（超时/isError 全路径/schema 违约）、日志（词表/重放投影/遮蔽）、**不变量**（随机事件序列下，每条发出的请求都能从日志重建）；
4. 真实厂商冒烟：环境变量门控，默认不跑。

## 11. 开发批次

| 批 | 内容 | 验收 |
|---|---|---|
| H1 | session（词表/内存实现/投影）+ core 循环（状态机/三通道/abort/预算） | 循环层测试全绿 |
| H2 | llm（LlmFailure + OpenAI 兼容 adapter + mock adapter） | 码表与流式累积测试 |
| H3 | retry（策略/预算持久化/溢出路由） | 重试层测试全绿 |
| H4 | tools（注册表/管线/isError/超时/并发池） | 管线层测试全绿 |
| H5 | context（计量/压力/裁剪/摘要/替换代数）+ 不变量测试 | 全量测试 + 真实冒烟 |

## 12. 与 dsh 的刻意差异（诚实清单）

1. 无 Cordis 插件/瀑布/profile——机制直接以注入与回调落地（ADR 0006）；
2. 日志消息粒度，不记 chunk、不记 step 边界；
3. Turn Budget 默认 32——dsh 无上限，我们加了一道可关闭的库级保险；
4. 无审批/沙箱/写意图门/subagent（ADR 0006 回访条件）；
5. 适配器只做 OpenAI 兼容一种（dsh 有 deepseek/pi-ai 多厂商 adapter；我们以 OpenAI 兼容一词覆盖主流）；
6. 无 maintenance phase 独立态——手动压缩直接要求 idle（简化，可后补）。
