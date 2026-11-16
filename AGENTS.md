# AGENTS.md

本仓库是 TypeScript agent harness 库（dsh 机制复刻）+ Node 应用层 + React 前端。在此写码前先读 [CONTEXT.md](CONTEXT.md) 术语表与 [docs/design/2026-09-harness.md](docs/design/2026-09-harness.md)；架构级决定记录在 docs/adr/。

## 沟通
- 面向用户的叙述默认使用简体中文；代码、命令和技术标识保持英文。
- 先给影响与结论，再给行动、待决策和必要证据；没有对应内容就省略。
- 技术细节只保留对理解结论、判断风险或复现结果有帮助的部分。

1. 不要假设。不要隐藏困惑。主动暴露权衡取舍。
2. 只写解决当前问题的最小代码，不做任何推测性功能。
3. 只修改必须改的地方，只清理自己产生的问题。
4. 明确定义成功标准，验证通过前持续迭代。

## 分层结构（harness → app → web）
- 三层固定：`src/harness/` 纯库（零平台依赖）→ `src/app/` Node 应用层（HTTP、多用户、SQLite）→ `web/` React 前端。
- harness 层平台能力一律经 `src/harness/env.ts` 的 `PlatformEnv` / `FileIO` 注入；`node:sqlite`、`node:fs` 等只允许出现在 `src/app/`。
- app 层各 store（conversations / ledger / tasks / memory…）直接持有 DatabaseSync 做同步读写；全部 DDL 收敛在 `src/app/db.ts`，别处不写建表语句。
- 存量库迁移走 db.ts 的 ensureColumn / 重建表模式：幂等、包事务、启动时自动完成；换 CHECK 约束只能重建表。
- `server.ts` 路由只做参数校验、调 store、包响应；业务判断不写在路由里。
- 前端只经 HTTP + SSE 与 app 层通信，不直接碰数据库。

## 铁律（改 core 前自查）

1. **零平台依赖**：`src/harness/` 核心 import 任何 Node/RN/浏览器专属模块（fs、path、process、TextDecoder 等）都是违规——平台能力一律经 `src/harness/env.ts` 的 `PlatformEnv` / `FileIO` 注入。
2. **model-visible means logged**：任何发给模型的内容必须能从会话日志重建（`deriveMessages` 投影）。新增模型可见的东西 = 新增日志事件或在投影里确定性推导，二选一；`test/invariants.test.ts` 守护此不变量，改动投影必跑。
3. **tool_call/result 配对不可悬空**：任何路径（abort、Turn Budget 用尽、管线错误）离开 step 前，未回话的工具调用必须补合成 isError 结果。改循环时保持这一性质。
4. **错误归一边界**：adapter 之外的代码不允许出现厂商原始错误形态——一律 `LlmFailure`（`llm/errors.ts` 十码表）。新错误情形先归码，再谈处理。
5. **确定性测试**：测试零网络（mock adapter）、时钟/随机/退避全注入固定值。不许引入真实计时断言（毫秒级容差也不行）；超时类行为用小真实延迟 + 注入 sleep 测。

## 反过度工程 / 反防御性编程
- 信任内部代码与类型保证；类型已声明的不重复判空、不二次校验。
- 编写的代码寻求 fast-fail：出错就地崩溃，禁止捕获后吞掉，禁止 fallback 默认值。
- 禁止为「不可能发生」的场景添加错误处理、回退或空值检查。
- 用户请求参数校验在 server 路由入口完成；store / harness 收到的参数视为已校验，直接使用。
- 修复缺陷时直接修改原有逻辑；禁止在旧逻辑旁边加兼容分支、双写或开关。
- 测试与实现不用任何 mock 数据、假对象、只为通过测试的绕行手段欺骗结果（确定性测试的注入替身除外，那是铁律 5 的要求）。

## 代码密度与抽取标准
本仓库代码由人类逐行审查，改动体积直接决定审查负担，控制体积是硬要求。
- service 主流程按线性步骤直叙写到几十行是正常状态（参照 `conversations.ts` 的 `assemble`、`memory-extract.ts` 的提取面）；禁止为了缩短方法把线性步骤拆成一次性私有方法。
- 抽取方法仅限两种情况之一：被两处以上调用；本身是一段完整独立的计算块（参照 `persona.ts` 的 `disciplineFor`）。两者都不满足时保持内联。
- 共用函数接管分支后，重新判断原私有方法是否还有存在必要；无调用方即删。
- 新增代码前先读同层现有文件，结构、密度、命名向现有代码看齐；新增抽象层、工具类、包装类需要用户事先同意。
- 一次改动只包含当前任务的内容；顺手重构、扩大格式化范围、改无关命名都不做。

## 测试与验证
- 不要为可逆、影响小、只是复述实现的改动写测试。
- 跑与本次改动相称的测试：改投影必跑 `test/invariants.test.ts`，改循环必跑 harness 相关套件；全量 `pnpm test` 交付前必须绿。
- 测试结果以真实执行为准：以命令退出码判定通过与否，报告时附上命令、退出码、用例数；命令未执行或用例数为 0，禁止声称测试通过。
- 收尾删掉本次产生、之后用不上的临时文件（部署归档、中间产物）。
- 唯一例外：`test/smoke.test.ts` 是真实厂商冒烟，需要环境变量提供真实 Key 才跑，不计入常规全绿口径。

## AI 开发护栏
- 写代码与评审代码分开：改动完成后、提交人工审查前，开子 agent 评审，只提供改动文件与本文件，不带生成代码过程的对话历史；子 agent 只输出问题清单，不修改代码。
- 修复循环封顶：修同一个缺陷最多 3 轮，仍未解决就停下，写明现象、已尝试的方向与失败原因，交人决定后续；禁止继续重试。
- 发现文档或代码有错误时，更新并消除错误痕迹，不保留错误记录、不加「无 xx」标注。
- 提交信息用中文长句直述：改了什么、为什么、测试与验证证据（参照 git log 现有风格）。
- 用户指出错误 A 后，只基于「A 是错的」继续工作，不复读 A 为什么错。


## 约定
- 注释与文档用中文；标识符英文。术语以 CONTEXT.md 为准，不发明同义词。
- 设计文档 §12 列出的与 dsh 的刻意差异是**有意的**，不要顺手改掉。
- 与设计文档冲突的实现，要么改回设计，要么先更新设计文档并说明理由。
- `src/agent/`（旧参考代码）已删除，勿复活。
- 会话 cid 约定：聊天会话 = cid；定时提醒会话 = `feed:<uid>:<agentId|default>`（每伙伴一个）。

## 编码规范
### 命名规范
- **类/组件**: 大驼峰（PascalCase），如 `SqliteSessionLog`、`MemoryExtractor`、web 组件 `AgentWizard.tsx`
- **函数/方法/变量**: 小驼峰（camelCase），如 `ensureTaskFeed`、`deriveMessages`
- **常量**: 全大写下划线，如 `SCHEMA_VERSION`、`TASK_FEED_CID_PREFIX`
- **app 层文件名**: 小写连字符，如 `memory-extract.ts`、`session-log.ts`；测试同名前缀 `app-*.test.ts`
### 代码组织
- 顶层函数/类之间空一行；函数内部按逻辑段落组织，段落间不铺空行充数。
- 注释密度向邻近代码看齐：讲清「为什么」与日期锚点（如 `// 2026-09-30 习惯化`），不复述代码。

## 常用命令
```bash
pnpm install      # devDependencies 仅 typescript + vitest 等（零运行时依赖）
pnpm test         # vitest 全量
pnpm typecheck    # tsc --noEmit
pnpm build:web    # 前端构建（部署在服务器上跑）
pnpm dev:server   # 本地起 app 层
pnpm dev:web      # 本地起前端
```
