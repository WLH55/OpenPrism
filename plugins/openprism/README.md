# openprism —— dsh 组合包：六维度对话录入 + 可视化面板 + 目标/简报/采集管线

[OpenPrism](../../README.md) 的核心插件，以**可插拔组合包（bundle）**的形式安装在
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 本体上。
安装后 dsh Web UI 的侧栏底部出现「📊 面板」按钮，点开即见六个生活维度的分页面板；
对话中随手说「花了 35 吃午饭」「背了 40 分钟单词」，模型自动调用工具把结构化
数据写入存储；说「分类用猫咪」即可当场扩展自己的分类维度。

> v0.4 起架构升级为**全局事件日志**（见
> [ADR 0002](../../docs/adr/0002-global-event-log-as-sole-persistence.md)、
> [ADR 0003](../../docs/adr/0003-captures-are-not-events.md) 与
> [设计纪要](../../docs/design/2026-08-feature-design.md)）：
> 所有结构化数据只存一份 append-only 的事件日志，面板/周报从它折叠。

## 它做什么

| 组成 | dsh 原生扩展点 | 说明 |
|---|---|---|
| `openprism` 事件镜像器 | `ctx.on('session/event')` | 订阅会话事件流：openprism_* 工具调用以确定性 id 落库（凭据在会话日志里）；用户消息进采集日志（always-record）；捕获主对话模型路由 |
| 录入工具 ×3 | `ctx.tools` | `openprism_record_expense` / `openprism_record_mood` / `openprism_record_activity`——记录事件由镜像器落库，工具负责校验/自动建类/即时汇总 |
| `openprism_correct` 工具 | `ctx.tools` | 更正/删除任意记录（target 精确或 kind+维度最近匹配）；UI 端点同源 |
| `openprism_set_goal` 工具 | `ctx.tools` | 目标/预算（支出上限、活动时长/次数、心情打卡）；重设即覆盖 |
| `openprism_panel` 工具 | `ctx.tools` | 六维度聚合汇总文本（含可录分类清单与最近记录 id） |
| `GET /openprism/panel.json` | `ctx.webServer`（可选 seam） | 浏览器 UI 数据源：统计 + 目标进度 + 周期切片 + 91 天热力图 + 最近记录 |
| `POST /openprism/records` | `ctx.webServer` | 速记表单直录（不经模型，零 token） |
| `POST /openprism/corrections` | `ctx.webServer` | 记录删除/编辑（source: ui） |
| `POST /openprism/categories` | `ctx.webServer` | 分类的添加 / 改名（改名链折叠）/ 删除（归入「其他」） |
| `POST /openprism/distill`、`/briefing/daily`、`/briefing/weekly`、`/briefings`、`/rebuild` | `ctx.webServer` | 手动触发夜间提炼 / 简报生成 / 简报列表 / 从会话日志全量重建 |
| 侧栏按钮 + 六维度面板 | `dsh.client` + `sidebar.footer.action` 槽 | 统计卡、柱状图、分类条形、速记表单、目标进度、91 天热力图、周期切片（今日/本周/本月/今年）、最近记录删除编辑、分类管理器；640px 以下全屏单列（移动优先） |

## 架构（v0.4）

```
对话 ──模型──▶ openprism_* 工具调用 ──▶ 会话日志（tool/call，录入凭据）
                    │                          │ session/event
                    ▼                          ▼
              工具 execute              镜像器（确定性 id）     用户消息 ──▶ captures/YYYY-MM.jsonl（采集日志）
              （校验/建类/汇总）                │                    │ 夜间提炼（LLM 决策 + 本模块校验）
                    │                          ▼                    ▼
                    └────────────▶ events.jsonl（全局事件日志，唯一持久层）◀── ui/internal/extraction
                                        │ 折叠（更正/改名链/目标进度）
                                        ▼
                        面板 UI / panel.json / 每日·每周简报 / 微信投递（webhook 缝）
```

- **唯一持久层**：`$DSH_HOME/openprism/events.jsonl`（append-only，按 id 幂等）；
  四张 storage 表已废弃——会话日志只带标准 `tool/call`/`tool/result`，任何 dsh 都能加载。
- **采集日志**：`captures/YYYY-MM.jsonl`，always-record 的原料（可按保留策略整月裁剪）；
  提炼产物回链 `captureId`。
- **简报**：`reports/YYYY-MM/`，可重算派生物；数据模板零 token，周报解读可选过 LLM。
- **rebuild**：`POST /openprism/rebuild` 扫描 `$DSH_HOME/sessions`（含 zstd 压缩日志）
  重放 openprism_* 调用；非镜像事件原样保留。

### 分类模型（v0.3 起不变）

分类是数据不是代码：对话里说「分类用猫咪」未知分类自动建类；UI 可增删改名
（改名链在折叠期解析、删除的记录归入兜底「其他」）。

## 配置（环境变量）

| 变量 | 说明 |
|---|---|
| `OPENPRISM_DELIVERY_WEBHOOK` | 简报投递 webhook（POST JSON {title, path, markdown}）——im-bridge fork / 企业微信 bot / Bark 等皆可接；未配置时简报只落盘 |
| `OPENPRISM_CHATLOG_URL` | chatlog 本地服务地址（如 `http://127.0.0.1:5030`）；配置后每小时拉取微信/QQ 消息灌入采集日志，游标持久化防重复 |
| `DSH_HOME` | dsh 主目录（缺省 `~/.dsh`）；OpenPrism 数据在其下 `openprism/` |

## 安装（插拔）

```sh
dsh plugin --profile web add /path/to/OpenPrism/plugins/openprism
dsh --profile web        # 重启后侧栏出现「📊 面板」

# 卸载
dsh plugin --profile web remove openprism
```

依赖的 webServer / llm / slots 等 seam 由 `dsh-web-app` 组合提供，web profile 开箱即用。

## 开发

```sh
pnpm install
pnpm -C plugins/openprism build        # tsc（host 半边）+ esbuild（client 半边 → lib/client.js）
pnpm -C plugins/openprism typecheck    # 两个 face 各自 tsc --noEmit
pnpm -C plugins/openprism test         # vitest：领域层单测 + 假缝 E2E（57 项）
```

开发循环：`build` 后无需重新安装（profile 里是 `link:` 到本目录），重启 dsh 即生效。
浏览器半边的缓存键是内容哈希（rev），改代码重启后自动失效。

### 铁律一：零声明的 dsh 依赖（双实例陷阱）

本包 `package.json` **不声明任何 `@deepseek-ai/*` 运行时依赖（peer 也不声明）**；
运行时导入（dsh-storage-domain 已于 v0.4 移除，dsh-llm 走动态 import）依赖 dsh 的
`$DSH_HOME/profiles/node_modules` 回退链解析到**宿主自己的副本**。类型检查用 devDependencies。

### 铁律二：客户端闭包工厂契约

`lib/client.js` 必须是 `window.__ModuleLoader__.load({ id, factory(require) → exports })`
的**单参**工厂（见 `build-client.mjs`）；esbuild CJS 输出体需手工提供
`module`/`exports` 局部绑定。react 等平台模块经注入的 require 从模块表解析，禁止打包。

## Known Limitations and Deferred Work

- **面板数据仅本机**：浏览器 UI 以 5 秒轮询 `/openprism/panel.json` 刷新
  （长连接受 dsh webServer 能力限制，列为后续评估项）。
- **工具描述里的分类清单是启动时快照**：运行中新建的分类不会回写到已注册工具的
  description（下次重启更新）；但自动建类保证新名称不会被拒绝，模型也可先调
  `openprism_panel` 看到实时清单。
- **真机验证清单**（假缝 E2E 已覆盖逻辑，以下待真实 dsh 环境复核）：
  1. dsh `session/event` 对 user/message 原文与 request/header 路由的暴露（源码已核实类型）；
  2. `ctx.llm.stream` 提炼调用的 BlockAssembler 组装（源码范本 session-title-llm 一致）；
  3. 微信投递：im-bridge 需 fork 暴露 HTTP 缝（或任选 webhook 通道先行）；
  4. Chatlog：需本机运行 chatlog 服务并解密微信数据。
- 目标进度当前按自然窗口（每日/每周/每月）计算；滚动窗口（近 7 天）未做。
