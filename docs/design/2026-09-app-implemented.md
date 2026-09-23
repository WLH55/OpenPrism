# OpenPrism 应用功能实现汇报（2026-09，feat/design-standalone 分支）

> 交付视角的现状文档：每个功能给「实现原理 → 代码位置 → 怎么实现」，与设计纪要 [2026-09-app.md](2026-09-app.md)（D1–D11 决策）逐条对照，是「决策 → 落地」的映射。
> 术语表见 [CONTEXT.md](../../CONTEXT.md)；harness 地基见 [2026-09-harness.md](2026-09-harness.md)。
> 版本基线：截至 `53599ae`（web UI 全量对齐原型）+ 2026-09-04 增补（模型侧任务 CRUD + 账本修正工具），`pnpm typecheck` 0 错误、`pnpm test` 190 全绿。

## 总览

OpenPrism 现在是**自托管的生活记录助理应用**，叠加在纯 TS agent 引擎（`src/harness/`）之上：

- `src/app/`——独立 Node 应用：`node:http` 零运行时依赖的 JSON API + SSE 流式 + `web/dist` 静态托管；登录/多用户沙盒；账本；会话池；定时任务调度。
- `web/`——React 18 + Vite + Tailwind v3 前端，壳子与配色对齐 `prototype/index.html`（深林墨绿·成长 / 森林夜色双主题）。

全应用一条主线贯穿：**账本只追加、面板 = 确定性折叠（0 token）、模型只能经工具写数据、Key 只以密文落盘**。

| 批次 | 提交 | 内容 |
|---|---|---|
| 批次 1 | `2c2e926` | 服务器核心 + 登录注册 + 聊天/今天/设置 + 四录入工具 + BYOK |
| 批次 2 | `500a85e` | 多智能体三段配置 + 会话切换伙伴 + 技能/MCP + 长期记忆三层 |
| 批次 3 | `4084faf` | 定时任务（离线回合/任务会话/补跑不补吵）+ 站内通知 |
| 批次 4 | `b12a5d8` | 盘面/成长面板 + 分类合并归档 + 公网硬化 |
| UI 对齐 | `53599ae` | web 全量对齐原型（侧栏壳子/分段控件/toggle/SVG 折线/热力图/火柴棍） |
| 修复 | `c746b6c` | 静态页登录前可访问（登录页无需登录，认证门只管 `/api/*`） |

---

## 一、核心原语（跨批次的骨架）

### 1. 账本 Ledger——唯一数据原语
- **原理**：一切"记录"（流水/计划/打卡/作废）都是 `users/{uid}/life.jsonl` 的**只追加事件**，带 `seq` 递增与 `ts`。**更正回路 = 追加一条 `void` 引用 `targetSeq`**，不原地改写——历史永远可审计，作废只是折叠层剔除。
- **代码**：`src/app/ledger.ts`（四类记录 `FlowRecord`/`PlanRecord`/`CheckinRecord`/`VoidRecord`）。
- **实现**：`append` 走**串行写队列**（并发 append 不交错、单条失败不卡队列）；`activeRecords()` 折叠剔除被作废目标；启动全量载入内存、崩溃半行跳过；同 uid 恒同一实例（缓存于 `main.ts`）。

### 2. 面板 = 确定性折叠
- **原理**：今天/盘面/成长全部是账本内存数据的纯函数折叠，**0 token、0 模型调用**。
- **代码**：`src/app/fold.ts`（`todayView` / `categoryView` / `progressView` / `listCategories`），路由在 `src/app/server.ts`。
- **实现**：时间语义统一 `tzOffsetMinutes`（UTC 加多少分钟得当地，如中国 +480）；计划是否覆盖"今天"由 `planScopeCoversToday` 决定（day=同日 / week=当地周一为一周之始 / month·year 比对年月 / ndays=滚动窗口 / deadline=截止日未过）；`streakDays` 连续到今天没记则从昨天起算；近 30 天序列**缺日补零**（折线与热力图共用）。分类即维度——目录从实际记过的流水动态长出，**零预置、零配置**（用户价值观：不做任何预设模板）。

### 3. 同源铁律：模型只能经工具写账本
- **原理**：写入类工具（`record_flow`/`create_plan`/`checkin_plan`/`void_flow`/`cancel_plan`）`isConcurrencySafe: false`，并发严格排队；`render` 产出人话文本回执，UI 与模型共用同一句文案。
- **代码**：`src/app/tools.ts`；纪律写死在系统提示词（`src/app/persona.ts` 的 `DISCIPLINE`）。
- **实现**：agent 来源记录带 `actor`（会话 cid + 当前伙伴名），归属可追溯；UI 是另一写入方（`source: "ui"`）。**2026-09-04 补修正回路**：`void_flow`（按 seq 作废流水，修正 = 作废后重记）、`cancel_plan`（按 planId 作废计划）；`query_ledger` flows 输出带 seq 作引用凭据——聊天更正与面板编辑共用同一 void 原语。

### 4. BYOK Key 密封铁律
- **原理**：API Key **只以 AES-256-GCM 密文落盘**（`model.json` 的 `keyEnc`），主密钥 32B 落 `data/secret.key`（gitignore）。明文只在内存短暂存在、只发往用户配置的 baseURL；接口永不回传 Key（`GET /api/model` 只给 `hasKey` 布尔）。
- **代码**：`src/app/secretbox.ts`（`seal`/`open`/`loadOrCreateMasterKey`/配置原子写 tmp+rename）。
- **实现**：adapter 工厂每次调用现读配置（`main.ts` 的 `adapterFactory`）——改设置下一回合即生效，无需重启/清池；`/api/model/test` 发一次 1-token 非流式 `ping`（默认实现 `server.ts`；测试注入 fake 零网络）。

### 5. 认证与会话
- **原理**：scrypt 慢哈希（N=16384,r=8,p=1）+ `timingSafeEqual` 常量时间比较；会话令牌 = 48 hex 随机数，内存 Map + 事件流持久化（重启重放恢复，不掉线）。
- **代码**：`src/app/auth.ts`；用户注册表 = 追加式 JSONL `users.jsonl`；注册即建 `users/{uid}/` 沙盒（uid 一律 UUID，不进路径，无遍历风险）。
- **实现**：认证限速器按「IP+用户名」60s 窗口 10 次（`server.ts`）；Cookie `HttpOnly; SameSite=Lax`；登录门只管 `/api/*`，登录页/静态资源无需登录（`c746b6c`）。

---

## 二、批次 1：能聊能记

| 功能 | 原理 | 代码 | 实现要点 |
|---|---|---|---|
| 聊天 | 一会话 = 一 Agent 实例，JSONL 会话日志持久化 | `conversations.ts`；`server.ts:285-365` | 按 `uid:cid` 池化装配（并发共享同一次装配）；`POST …/messages` 202 后 `followup` 异步跑；`GET …/stream` SSE（25s 心跳）推活体事件；未配模型 → 409 / 流首帧 `model_not_configured` |
| 今天页数据 | 账本折叠 | `fold.todayView`；`GET /api/today?tz=` | 今天流水时间序 + 计划覆盖判定 + 打卡态取当天最新 + 分类合计 + streak |
| 快速记录/作废/打卡 | UI 直写账本（`source:"ui"`） | `server.ts` 的 `/api/flows`、`/api/void`、`/api/checkin` | 作废校验 seq 存在后追加 void；打卡校验 planId 存在 |

---

## 三、批次 2：人格与记忆

| 功能 | 原理 | 代码 | 实现要点 |
|---|---|---|---|
| 多智能体三段配置 | 人设卡 + 能力绑定（工具开关/技能/MCP） | `agents.ts`、`persona.ts` | persona = 纯自由 markdown，名字从首个 `# H1` 推导（`extractAgentName`）；索引行走 JSONL、正文原样落盘 |
| system prompt 热更 | `systemPrompt()` **每步同步重取** | `conversations.ts:282-293`（`composePromptWithMeta`） | 人设/记忆/技能目录改动下一步对话即生效，无需重建 agent；合成顺序：人设 → 日期 → 记忆块 → 纪律 |
| 会话切换伙伴 | `meta.json` 记 agentId + 切换史 | `conversations.ts:132-143` | 只换 prompt 与装配，历史不丢；切换史供前端画分割线 |
| 技能 | 标准 Agent Skill，**渐进式加载** | `skills.ts` | 目录层（description ≤1024 硬约束）常驻 system prompt 只耗轻 token；正文经 `load_skill` 工具按需载入 = 一条工具事件落日志，「模型可见即日志可重建」天然满足 |
| MCP | 仅 remote 型（公网禁令天然满足）；Streamable HTTP JSON-RPC | `mcp.ts` | `initialize` + `tools/list` → 包装为 harness 工具；POST 同时接受 JSON/SSE 双响应；信任边界 = 安装时连一次、绑定即授权 |
| 长期记忆 L1 | 会话日志复用（不另建记忆库） | — | 全量对话文本落在 session.jsonl，凝练时取尾部 40 条 |
| 长期记忆 L3 | 四槽 markdown（近期动态/画像/主线/偏好）+ meta | `memory.ts` | 注入 = 槽拼接 + 剥溯源脚注（`stripFootnotes`：`[^n]:` 给人看出处的锚不喂模型），全量自动进 system prompt |
| 模型写记忆 | `save_preference` **窄工具** | `memory.ts:191-211` | 只写 preferences 槽、只记显式表达、≤240 字、一次一条、带日期脚注 |
| 记忆凝练 | 一次 LLM 批处理 → 四段输出 | `memory.ts:166-187`；触发 `server.ts:480-506`、`main.ts` 启动惰性（超 20h 且有过会话） | 要求输出 `<!-- slot: xxx -->` 标记；正则解析；**原子落盘 + meta 计数；解析失败 fail-safe 不写** |

---

## 四、批次 3：定时任务与通知

| 功能 | 原理 | 代码 | 实现要点 |
|---|---|---|---|
| 任务模型 | 四字段：agentId/trigger/instruction/enabled | `tasks.ts` `TaskDef` | 双入口：模型对话四工具（`create_task`/`query_tasks`/`update_task`/`delete_task`，2026-09-04 补齐 CRUD——起因：用户实测"只能建不能撤"）+ UI/API 直建 |
| 触发 | 枚举 + cron 逃生门 | `tasks.ts` `cronMatches`/`nextDue` | 自研零依赖 5 段匹配器（`* n a-b a,b */n`，周日 0\|7 归一）；**全部在任务时区求值**；cron 逐分钟前进、上限 2 年 |
| 执行 | 到点投 `instruction` 进**任务专属持久会话**跑离线回合 | `conversations.ts:165-170`（`taskAgent`）、`main.ts:85-96`（`taskRunner`） | 与聊天回合同权装配（伙伴 = task.agentId 快照，人设仍热读）；收口后把最后一条 assistant/message 文本落站内通知 |
| 补跑不补吵 | 锚点 = `lastRunTs ?? createdTs` | `tasks.ts` `Scheduler.tick` | 错过 <24h 补最近一次；≥24h 记 `skipped` 并推进锚点（不堆积）；30s 一 tick；支持手动 `POST …/run` |
| 站内通知 | 追加式 JSONL + 通道缝 | `notify.ts` | `NotifyChannel = (uid, payload)`；站内 = 永远在线兜底通道（微信桥后接入，架构位留给 D9.2 双向网关）；单条/全部已读重写整文件 |

---

## 五、批次 4：盘面成品化与公网硬化

| 功能 | 原理 | 代码 | 实现要点 |
|---|---|---|---|
| 分类管理 | 合并 = 旧流水先 void 再同字段新写 | `server.ts:617-679` | 走追加回路，审计不丢；归档名单 `archives.json` 原子替换（tmp+rename） |
| 盘面/成长 API | 确定性折叠 | `fold.ts`；`server.ts` 的 `/api/panels*` | 分类周期切片 today/week/month/year；近 30 天补零；周环比/完成率/近 14 天趋势 |
| 公网硬化 | 静态托管防目录穿越 + 安全头 | `server.ts` `serveStatic`/`setSecurityHeaders` | resolve 后前缀校验；nosniff/DENY/no-referrer；BODY_LIMIT 1MB；注册限速 |

---

## 六、web 前端（UI 对齐原型）

- **基建**：Tailwind v3 接入，token 与 `prototype/index.html` 1:1 映射 CSS 变量（`web/theme.css` + `tailwind.config.js`）；手写内联 SVG 图标（`web/src/icons.tsx`）；分类色确定性哈希（`web/src/catcolor.ts`）；Toggle 组件（`web/src/ui.tsx`）。
- **壳子**（`web/src/App.tsx`）：`App` 先 `api.me()` 判定登录态 → 登录页或 `Shell`；`Shell` = 左侧栏（品牌 + 主导航 对话/今天/盘面/成长 + 分隔 + 伙伴/提醒带未读徽标 + 最近对话列表 + 新对话 + 左下头像下拉：提醒/技能 MCP/长期记忆/模型接入/通知通道/主题/退出登录）+ 内容区；会话创建集中到壳子（防各页挂载竞态建空会话）；未读数 15s 轮询。
- **页面**：`pages/Login.tsx`（居中品牌 + 登录/注册分段控件）；`Chat.tsx`（伙伴卡头 + 思维链原生 checkbox 美化 + SSE 流式 + 工具回执）；`Today.tsx`（「＋ 快速记录」+ 计划/流水 + 作废）；`Panels.tsx`（分类 chips 色标 + 周期分段 + 汇总卡 + SVG 折线 + 30 天热力图 `.heat-0..4`）；`Progress.tsx`（火柴棍 + 完成率 + 周环比双条 + 近 14 天）；`Agents.tsx`/`AgentEdit.tsx`（三段配置 + Toggle + skills/MCP 绑定）；`Tasks.tsx`（分组 + toggle + 通知/全部已读）；`Skills.tsx`/`Memory.tsx`/`Settings.tsx`/`NotifyChannels.tsx`。
- **API 客户端**（`web/src/api.ts`）：fetch（cookie 同源）+ `EventSource`，类型与服务器路由一一对应（`api`/`api2`/`api3`/`api4` 按批次分组）。

---

## 七、质量与验证

- `pnpm typecheck`：0 错误；`pnpm test`：190 全绿（23 文件，含 harness 不变量守护：model-visible means logged、tool_call/result 配对、确定性测试，及真实厂商冒烟）。
- UI 验收：12 页 + 深/浅双主题逐页浏览器截图 + 功能冒烟（含白背景 bug 修复：`theme.css` 基层层补 `body{background:var(--bg)}`）。
- 各批次 spec 在 `mydocs/specs/`，UI 对齐 spec：`2026-09-04_00-00_ui-align-prototype.md`（Review PASS）。
- 已知刻意边界：简报无预设无独立机制（纯定时任务用法，D7 已收口）；任务在未配模型时执行会记一条 `failed` 运行记录（detail 说明原因），不静默也不堆积；记忆凝练依赖 BYOK 模型已配置。
