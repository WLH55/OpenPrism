# OpenPrism Harness

OpenPrism 分两层：底层是一个纯 TypeScript 的 agent harness（机制上完整复刻 dsh、零平台依赖、平台能力全部注入，已实现，79 测试全绿 + 真实厂商冒烟）；其上应用层已完成功能设计（docs/design/2026-09-app.md，Q1–Q9 收口），UI 设计待进行。本术语表分 Harness 与 App 两节；旧 App 领域语言见 git 历史（HEAD 0490371 的 CONTEXT.md）。

## Harness

**Harness**:
驱动 LLM 多轮工具循环的运行时机制总和——循环机器、错误与重试、上下文压缩、工具管线、会话日志。不含策略外围（审批、沙箱、subagent）。
_Avoid_: 框架、宿主、插件系统

**Turn**:
一次输入引发的完整处理周期：从收件箱认领消息开始，到不再欠任何模型请求为止。含零个或多个 Step。
_Avoid_: 会话、对话轮（单独使用时）

**Step**:
一次模型请求加上它发起的全部工具调用。持久化与计量的最小调度单位。
_Avoid_: 回合、迭代

**Inbox**:
Agent 的待处理输入队列，三条通道语义不同：**followup**（唤醒并开新 Turn，用户发言走这条）、**steer**（唤醒并插入当前 Turn 的下一步，中途改向）、**inject**（不唤醒，等下次请求自然捎带，静默上下文）。
_Avoid_: 消息列表、待办

**Session Log**:
追加式会话事件日志。铁律：凡模型见过的内容必须能从日志重建（model-visible means logged）。重放日志即恢复会话。
_Avoid_: 聊天记录、历史文件

**LlmFailure**:
所有厂商错误归一化后的中立错误事实，携带稳定 code（AUTH / QUOTA / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE / CONTEXT_WINDOW_EXCEEDED / INVALID_REQUEST / ABORTED）。全链路只认 code，不解析文案。
_Avoid_: 异常、错误消息（指这个词表时）

**isError**:
工具结果的失败标记。任何失败路径（工具体抛错、输出违约、超时、取消、被拦）都归一为带 code 的 isError 结果，模型永远收到合法的 tool/result。
_Avoid_: 错误文本、异常返回

**Agent**:
harness 驱动的一个会话实体：拥有专属 Inbox 与 Session Log，对外暴露 followup / steer / inject / cancel / whenIdle 与事件订阅。
_Avoid_: 助手、bot、模型

**PlatformEnv**:
harness 向宿主索要的全部平台能力（fetch、时钟、随机 id、文件 IO）。库本体零平台依赖的唯一例外边界。
_Avoid_: 环境变量、运行时（泛指时）

**LlmAdapter**:
厂商适配器接口：把中立请求翻成厂商协议、把厂商流翻回中立 chunk；错误必须归一为 LlmFailure。
_Avoid_: 客户端（泛指时）、SDK

**Surface（模型可见面）**:
从 Session Log 投影出的、真正发给模型的历史。压缩的替换对象，永远是日志的派生而非本体。
_Avoid_: 上下文（指投影时）、历史窗口

**遮蔽（Shadow）**:
被压缩替换掉的日志区间；重放时跳过，原文永不删除。
_Avoid_: 删除、清空

**替换代数（Replace Generation）**:
Surface 被区间替换的单调计数。只有它前进，上下文溢出的恢复重试才被允许——防止空转重放必然再溢出的请求。
_Avoid_: 版本号、重试计数

**压缩（Compaction）**:
两阶段缩容：先零成本裁剪超长工具结果，再用 LLM 摘要旧区间并整体替换 Surface。
_Avoid_: 截断、清理

**Turn 预算（Turn Budget）**:
单个 Turn 的 Step 上限（默认 32，可关）。用尽时补合成 isError 工具结果后收尾，保持历史协议合法。
_Avoid_: 速率限制、配额

**重试预算（Retry Budget）**:
可重试失败的有限计数，持久化于 Session Log，崩溃重启不重置；成功响应即清零。
_Avoid_: 重试次数（内存计数意）

**思维链（Reasoning）**:
reasoning 模型在正文之前输出的思考过程，随 assistant 消息落日志、经活体流增量下发；只用于展示，绝不回传模型（wire 映射剔除、压力计量不计）。
_Avoid_: 思考过程、reasoning_content（厂商字段名）

## App

应用层领域语言（功能设计 Q1–Q9 定型，详见 docs/design/2026-09-app.md）。与 harness 术语不冲突：应用概念在 harness 之上，两者是配置↔实例、数据↔日志的关系。

**智能体（Agent Persona）**:
应用层的个性化助手**配置** = 人设卡（自由 markdown）+ 能力绑定（工具开关/技能/MCP）+ 记忆注入（共享用户记忆）。一个智能体对应多个会话；与 harness 的 Agent（会话实体）是配置↔实例的关系。
_Avoid_: 助手、bot、角色（单独使用时）

**流水（Event）**:
记录"发生了什么"的生活事件：支出、心情、睡眠、运动……带时间 + 自由分类 + 可选数值/备注。账本三类原语之一。
_Avoid_: 记录（泛指）、日志条目

**计划（Plan）**:
记录"打算做什么"：任意周期（日/周/月/年/最近 N 天/截止日）。两类：**习惯计划**（带 timesPerPeriod 每期配额，2026-09-30 习惯化）跨周期自动续期，day 按每日打卡次数计、week/month/year 按每期不同本地日数计，打满配额才算完成、跨期清零重开；**一次性计划**（无配额）只覆盖创建所在的那个周期，过期淡出；带截止日的单发事用 deadline。计划都是独立待办（2026-09-30 目标层级下线后不再有挂树/goalId 语义；历史行的 goalId 在投影层忽略，修订时剥离）。
_Avoid_: 待办、方向、阶段、项目、打卡点、里程碑（目标层概念已于 2026-09-30 下线，勿再使用）

**目标（Goal）**:
已移除的概念（2026-09-28 引入：方向/阶段/项目三层层级 + 里程碑挂树；2026-09-30 用户决策整体下线，SDD 2026-09-30_00-29）。账本里的历史 goal 行休眠保留（append-only，投影层不可见、不可写、不可作废）；plan 上的历史 goalId 字段同理。不要再提议建"方向/阶段/项目"。
_Avoid_: 任务清单、OKR

**打卡（Check-in）**:
对某条计划的执行申报：完成/部分/跳过，可带数值。与流水的区别：打卡证"打算做的做了没"，流水记"发生了什么"。
_Avoid_: 签到、勾选

**账本（Ledger）**:
每用户唯一一份的只追加生活数据日志（users/{uid}/life.jsonl）；流水/计划/打卡/更正全部追加于此，统计面板是账本的确定性折叠（零 token）。结构定死（骨架 schema 校验）、内容自由（分类/备注/attrs）。
_Avoid_: 数据库、表、文档（指本概念时）

**更正/作废（Correction / Void）**:
修改或删除账本条目的唯一方式——追加更正/作废事件而非原地改行，折叠时应用/滤掉；历史留痕、可反悔。计划修订 = 追加新版本 + void 旧行（planId 稳定）；历史 goal 行休眠不可作废（目标层级已下线）。
_Avoid_: 编辑、删除（指直接改行时）

**导出（Export）**:
把数据带走（2026-09-30 SDD 数据导出）：设置页「数据导出」两个下载——JSON 全量备份（/api/export/data.json，readAll 口径：含作废与休眠 goal 行，机器可读）+ Markdown 时间线（/api/export/data.md，active 口径：按日分组的生活记录 + 对话的用户/助手文本轮次，人读）。长期记忆另有 /api/memory/export。仅限本人数据。
_Avoid_: 备份（泛指云备份时）

**离线回合（Offline Turn）**:
定时任务到点、用户不在场时，以所属智能体身份开的一次同权聊天回合：可读账本、生成个性化消息、经工具落账，账本来源标记 schedule。
_Avoid_: 定时通知、后台任务、闹钟

**内置任务（Builtin Tasks）**:
每用户注册/启动自动种入的三个定时任务：每日简报（08:30）、每日晚间汇报（20:00）、每周复盘（周日 21:00，tz 默认东八区）。以普通任务身份运行（无独立机制），默认站内渠道、可改可关可删；种子一次性（users.builtins_seeded），删除不复活，提醒页模板可重建；确定性 id builtin-{kind}-{uid}。
_Avoid_: 系统任务、预置模板（指机制独立时）

**任务会话（Task Session）**:
一个定时任务 = 一个专属持久会话；每次到点投 followup 开新 Turn，用户对通知的回复也进该会话——纵向记忆、跨任务不串味。
_Avoid_: 通知模板、提醒记录

**BYOK（自带密钥）**:
模型 Key 一律由用户自己配置（baseURL + Key），平台永不提供/共享/代付；Key 只发往用户配置的 baseURL。
_Avoid_: 平台托管、共享 Key、代付

**分类即维度（Category-as-Dimension）**:
面板不预设人生维度，按用户实际记过的分类动态生成；统计面板的固定页只有"今天"与"成长"。"计划"页（目标层级管理页）已随目标层级于 2026-09-30 下线——计划管理的唯一入口是"今天"页四范围 tab（今天/本周/全部/已完成）。
_Avoid_: 六大维度、预设分类

**长期记忆（Memory）**:
跨会话、跨智能体共享的关于用户本人的持久事实。条目式（2026-09-10 WeKnora 化）：每条独立成行，kind（画像/偏好/事实/任务）× status（生效中/待确认/已被更新/已归档）× origin（显式/后台/手动）生命周期；矛盾用 supersede 链不删除；用户删除走墓碑（指纹防复活）；推断只进待确认永不注入。对话后约 90s 后台提取（决策制 add/update/delete），每晚整理；注入 = 常驻块 + 按当前话题的词法情境召回（<user_memory> 信封）；模型写入 = save_preference / search_memory 两工具。
_Avoid_: 上下文、会话历史（指本概念时）、L1/L2/L3 三层（已废弃的旧机制）
