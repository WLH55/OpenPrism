# AGENTS.md

本仓库是**纯 TypeScript agent harness 库**（dsh 机制复刻）。在此写码前先读 [CONTEXT.md](CONTEXT.md) 术语表与 [docs/design/2026-09-harness.md](docs/design/2026-09-harness.md)；架构级决定记录在 docs/adr/。

## 铁律（改 core 前自查）

1. **零平台依赖**：`src/harness/` 核心 import 任何 Node/RN/浏览器专属模块（fs、path、process、TextDecoder 等）都是违规——平台能力一律经 `src/harness/env.ts` 的 `PlatformEnv` / `FileIO` 注入。
2. **model-visible means logged**：任何发给模型的内容必须能从会话日志重建（`deriveMessages` 投影）。新增模型可见的东西 = 新增日志事件或在投影里确定性推导，二选一；`test/invariants.test.ts` 守护此不变量，改动投影必跑。
3. **tool_call/result 配对不可悬空**：任何路径（abort、Turn Budget 用尽、管线错误）离开 step 前，未回话的工具调用必须补合成 isError 结果。改循环时保持这一性质。
4. **错误归一边界**：adapter 之外的代码不允许出现厂商原始错误形态——一律 `LlmFailure`（`llm/errors.ts` 十码表）。新错误情形先归码，再谈处理。
5. **确定性测试**：测试零网络（mock adapter）、时钟/随机/退避全注入固定值。不许引入真实计时断言（毫秒级容差也不行）；超时类行为用小真实延迟 + 注入 sleep 测。

## 约定

- 注释与文档用中文；标识符英文。术语以 CONTEXT.md 为准，不发明同义词。
- 设计文档 §12 列出的与 dsh 的刻意差异是**有意的**，不要顺手"修复"或对齐 dsh。
- 与设计文档冲突的实现，要么改回设计，要么先更新设计文档并说明理由。
- `pnpm test` 与 `pnpm typecheck` 必须保持全绿后再交付；`src/agent/`（旧参考代码）已删除，勿复活。

## 常用命令

```bash
pnpm install      # 依赖仅 typescript + vitest（零运行时依赖）
pnpm test         # vitest 全量
pnpm typecheck    # tsc --noEmit
```
