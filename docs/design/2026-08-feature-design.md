# OpenPrism 功能设计纪要（2026-08，feat/design 分支）

> grill-with-docs 会话的持续记录：每个设计问题一条，含结论与理由。
> 术语表见 [CONTEXT.md](../../CONTEXT.md)；不可逆决策另立 [ADR](../adr/)。
> 依据：2026-08 竞品调研（GitHub / Reddit / HN / X / 知乎 / V2EX / 少数派 / 小红书 / 商业产品）。

## 决策进度

| # | 问题 | 状态 |
|---|---|---|
| Q1 | 产品定位 | ✅ 已确认 → ADR 0001 |
| Q2 | MVP 维度范围 | ✅ 默认采纳（可推翻） |
| Q3 | 数据架构（跨会话持久化） | ⏳ 提议中 |
| Q4 | 事件模型与纠错 | 待讨论 |
| Q5 | 采集管线 | 待讨论 |
| Q6 | 面板与视图 | 待讨论 |
| Q7 | 主动简报 | 待讨论 |
| Q8 | 连接器与远期 | 待讨论 |

## D1 产品定位（Q1）

**自用优先，按开源标准架构。** → [ADR 0001](../adr/0001-self-use-first-open-source-grade.md)

## D2 MVP 维度范围（Q2，默认采纳）

**双维度闭环：理财 + 情感。** 在现有 `expense`/`mood` 代码基础上，把这两个维度的全链路（录入 → 提取 → 纠错 → 面板 → 周报）做穿做透；事件模型与面板模板保持通用，第三个维度作为"少量代码就能加"的验证点。

理由：调研显示六维全铺的维护半径是同类项目弃坑首因；闭环深度（尤其是纠错回路）比覆盖广度更决定面板可信度。

## D3 数据架构（Q3，提议中，待确认）

**提议：会话日志为唯一事实源 + 可重建的全局物化事件库。**

- `openprism/*` 事件只写 dsh 会话日志（录入凭据永远在会话里，可溯源）；
- OpenPrism 订阅 `session/event`，把所有会话中的 `openprism/*` 事件镜像到全局 append-only 日志（`data/openprism/events.jsonl`，每行带 `sessionId` + `seq`）；
- 面板 / 周报 / 模型查询工具从全局日志折叠，不再看单会话；
- 提供 rebuild 命令从 dsh 会话日志全量重建全局日志（物化层永远是可丢的缓存语义）。

背景事实（探查 dsh 0.1.1-rc.2 得出）：dsh 的投影机制是每会话的（`ctx.sessionProjections` 按 session 折叠、cell 只活内存）；持久化由插件订阅 `session/event`/`session/flush` 负责；没有跨会话投影。

否决的备选：纯会话日志扫描（需解析 dsh 内部日志格式，预发布阶段无兼容承诺，耦合脆）；独立存储直写（破坏"录入即写会话日志"的重放语义，纠错时两个真源打架）。

## 附：参考项目功能映射（调研结论 → 抄什么）

| 模块 | 参考 | 具体抄的机制 |
|---|---|---|
| 全局沉淀层 | memU | 对话蒸馏成人类可读条目 + 来源链接（source-linked recall） |
| 全局沉淀层 | Basic Memory | 人机共写同一批本地文件（远期：Markdown 镜像） |
| 全局沉淀层 | screenpipe | 本地存储 + agent 可查的上下文端点 |
| 事件模型与纠错 | mem0 | 两阶段提取：LLM 提取候选 → ADD/UPDATE/DELETE/NOOP 决策（去重、冲突消解） |
| 事件模型与纠错 | Firefly III | 规则引擎（条件→动作）做确定性兜底 |
| 事件模型与纠错 | Graphiti | 事实生命周期（生效/失效时间），字段设计预留时间语义 |
| 采集管线 | DailyClaw | always-record（先落库再并行处理，采集不阻塞对话）；晚间自动生成日记；意图路由 |
| 采集管线 | Memex | 录入前资源准备（语音/图片先行）+ 多子 Agent 并行产出结构化卡片 |
| 采集管线 | OpenClaw | 模型面工具直录（现方案）；反面教训：token 成本要前置控制 |
| 面板与视图 | homepage | 面板 = 声明式配置 + 每数据源一个 widget 卡片包 |
| 面板与视图 | LifeOS (quanru) | 周期聚合视图：今日/本周/本月/今年切片 |
| 面板与视图 | Daniel Miessler LifeOS | 预装通用模板保证首屏可渲染（防空面板） |
| 面板与视图 | 心光 | 心情三色趋势、高频词云、异常提醒（情感面板直接对标） |
| 面板与视图 | Loop Habit / GitHub 热力图 | 记录密度热力图 |
| 主动简报 | DailyClaw / Khoj / 心光 | 每日自动日记 / 定时简报投递 / "AI 朋友每周来信" |
| 连接器（远期） | Home Assistant | integrations 声明式清单 + 社区商店 |
| 连接器（远期） | screenpipe | pipe 协议（插件 = 订阅数据流的独立应用 + 市场） |
| 连接器（远期） | Chatlog | 微信/QQ 聊天记录提取 + MCP（第一个连接器候选） |
| 连接器（远期） | Karakeep | 多入口 → 统一 inbox → AI 打标 + 规则兜底 |

优先级：MVP 抄 mem0 提取决策、DailyClaw always-record、LifeOS 周期视图、心光情感面板、homepage 声明式面板；中期 Firefly 规则引擎、自动周报、Graphiti 时间语义；远期 screenpipe 管线协议、HA 连接器生态、Chatlog 接入。整仓通读推荐：Memex（卡片 schema 设计）、DailyClaw（架构原则）。
