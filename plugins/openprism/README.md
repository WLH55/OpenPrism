# openprism —— dsh 组合包：六维度对话录入 + 可视化面板 + 自定义分类

[OpenPrism](../../README.md) 的核心插件，以**可插拔组合包（bundle）**的形式安装在
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 本体上。
安装后 dsh Web UI 的侧栏底部出现「📊 面板」按钮，点开即见六个生活维度的分页面板；
对话中随手说「花了 35 吃午饭」「背了 40 分钟单词」，模型自动调用工具把结构化
数据写入存储；说「分类用猫咪」即可当场扩展自己的分类维度。

## 它做什么

| 组成 | dsh 原生扩展点 | 说明 |
|---|---|---|
| `openprism` storage 域 | `ctx.storageDomain` + `defineDomain` | 四张表（expenses / moods / activities / categories）持久化在 `$DSH_HOME/storages/openprism.json`，**跨会话、跨进程** |
| `openprism_record_expense` 工具 | `ctx.tools` | 记账（金额/类别/备注）——未知类别自动创建 |
| `openprism_record_mood` 工具 | `ctx.tools` | 记心情（1-5 分） |
| `openprism_record_activity` 工具 | `ctx.tools` | 记活动（生活/工作/家庭/学习 × 类别 × 可选时长），未知类别自动创建 |
| `openprism_panel` 工具 | `ctx.tools` | 六维度聚合汇总文本（含可录分类清单），回复给模型 |
| `GET /openprism/panel.json` 端点 | `ctx.webServer`（可选 seam） | 浏览器 UI 的数据源（同一聚合逻辑） |
| `POST /openprism/categories` 端点 | `ctx.webServer`（可选 seam） | 分类的添加 / 改名（记录跟随迁移）/ 删除（记录归入「其他」） |
| 侧栏按钮 + 分页面板模态 | `dsh.client` 浏览器插件 + `sidebar.footer.action` 槽 | 总览 + 六个维度页签：统计卡片、柱状图、分类条形图、最近记录、分类管理器 |

**数据模型（v0.2 起的架构决定）**：面板数据存 storage-domain 而非会话日志。
原因：dsh 对会话日志的事件类型有运行时白名单（构建期生成，无第三方注册面），
未知事件且未标记 `ignorable` 的日志会被**拒绝加载**（宁可拒绝不静默丢数据）；
`ignorable` 又只支持读取，公开 append API 无法写入。会话日志因此只携带标准
`tool/call` / `tool/result`——任何 dsh 版本都能加载，面板数据自己持久化。

**分类模型（v0.3）**：分类是数据不是代码——`categories` 表按维度存名字清单，
首次启动播种默认集；工具的 category 参数为自由字符串（描述里附当前清单引导
复用），`resolveCategory` 精确匹配已有分类、未知名称自动建行。「其他」是结构性
兜底：不可删、不可改名；删除其他分类时记录归入其中，改名时记录跟随迁移。

**同版本加表（迁移安全）**：storage-json 后端按域描述符的表清单读取快照，缺表
按空处理；因此 v0.3 在 `version: 1` 不变的前提下新增 activities / categories 两张
表，旧数据文件（只有 expenses / moods）加载后新表从空开始，无需迁移。

## 安装（插拔）

```sh
dsh plugin --profile web add /path/to/OpenPrism/plugins/openprism
dsh --profile web        # 重启后侧栏出现「📊 面板」

# 卸载
dsh plugin --profile web remove openprism
```

依赖的 storage seam（storage / storage-json / storage-domain 三行）由 `dsh-web-app`
组合提供，web profile 开箱即用；其他组合（如 headless）需在宿主 profile 的
`cordis.patch.yml` 自行补上，见 `cordis.patch.yml` 内注释。

对话示例：

```
你：我今天花了 35 吃午饭，又花 28 买了杯咖啡
AI：（自动调用 openprism_record_expense ×2，回报本月累计）
你：给猫买了猫粮 120，分类就用"猫咪"吧
AI：（openprism_record_expense，类别「猫咪」自动创建）
你：背了 40 分钟单词，跟爸妈视频了半小时
AI：（openprism_record_activity ×2：study/练习 40min、family/通话 30min）
你：今天心情不错
AI：（自动调用 openprism_record_mood）
你：打开看看面板？          # 或直接点侧栏「📊 面板」按钮
```

## 开发

```sh
pnpm install
pnpm -C plugins/openprism build        # tsc（host 半边）+ esbuild（client 半边 → lib/client.js）
pnpm -C plugins/openprism typecheck    # 两个 face 各自 tsc --noEmit
```

开发循环：`build` 后无需重新安装（profile 里是 `link:` 到本目录），重启 dsh 即生效。
浏览器半边的缓存键是内容哈希（rev），改代码重启后自动失效。

源码：

```
src/
├── types.ts          # 记录形状：ExpenseRecord / MoodRecord / ActivityRecord / CategoryRecord
├── panel.ts          # 六维度聚合与渲染：buildPanelSummary / renderPanelSummary（纯函数）
├── index.ts          # host 半边：storage 域 + 四个工具 + 分类播种/解析 + HTTP 端点
└── client.tsx        # 浏览器半边：分页面板模态（图表为手写 CSS 柱状/条形）+ 分类管理器
build-client.mjs      # esbuild CJS → window.__ModuleLoader__.load 闭包工厂包装
```

### 铁律一：零声明的 dsh 依赖（双实例陷阱）

本包 `package.json` **不声明任何 `@deepseek-ai/*` 依赖（peer 也不声明）**；对 dsh
的运行时导入（如 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain`）依赖 dsh 的
`$DSH_HOME/profiles/node_modules` 回退链解析到**宿主自己的副本**。若把这些包声明为
依赖，pnpm 会在 profile 生成遮蔽副本——Symbol 键身份不一致，运行期崩溃（已实测：
`Cannot read properties of undefined (reading 'prepare')`）。类型检查用 devDependencies。

### 铁律二：客户端闭包工厂契约

`lib/client.js` 必须是 `window.__ModuleLoader__.load({ id, factory(require) → exports })`
的**单参**工厂（见 `build-client.mjs`）；esbuild CJS 输出体需手工提供
`module`/`exports` 局部绑定。react 等平台模块经注入的 require 从模块表解析，
禁止打包。

## Known Limitations and Deferred Work

- **面板数据仅本机**：storage-domain 的 `domain/changed` 是进程内事件，浏览器 UI
  目前以 5 秒轮询 `/openprism/panel.json` 刷新。
- **没有删除/编辑入口**：记录只能追加；后续补「最近记录列表 + 删除」或让模型代理删除。
- **工具描述里的分类清单是启动时快照**：运行中新建的分类不会回写到已注册工具的
  description（下次重启更新）；但 `resolveCategory` 的自动创建保证了新名称不会被
  校验拒绝，模型也可以先调 `openprism_panel` 看到实时清单。
- 平台连接器（笔记、AI 工具、各类平台资源）尚未开始。
