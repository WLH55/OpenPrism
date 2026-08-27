# OpenPrism

> 一个你，折射出生活的每一个维度。

OpenPrism 是一个**个人智能工作台**：与智能体对话，随手记录；数据自动沉淀为各个生活维度的统计面板，并打通你的笔记、AI 工具与各类平台资源。

**OpenPrism 以 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件的形式存在**——不是独立的 agent 框架，而是一组可插拔安装在 dsh 本体上的组合包（bundle）。`dsh plugin add openprism` 即装、`remove` 即卸。

## 定位

- **不是**又一个待办清单或笔记软件，而是挂在 dsh 上的"对话即录入"数据中枢
- 一次输入（对话、记录、自动采集）→ 多维视图（面板）→ 洞察与行动
- 复用 dsh 的全部底座：事件溯源会话日志、插件体系、审批与沙箱、Web UI

## 六大维度面板（v0.3 全部实现）

| 维度 | 录入工具 | 面板内容 |
|---|---|---|
| 💰 理财 | `openprism_record_expense` | 本月合计、近 14 天趋势、分类条形图 |
| ❤️ 情感 | `openprism_record_mood` | 均值、记录数、最近 7 条 |
| 🌱 生活 · 💼 工作 · 🏠 家庭 · 📚 学习 | `openprism_record_activity`（dimension 参数区分） | 本月条数/时长、分类聚合、最近记录 |
| 全部 | `openprism_panel` | 六维度汇总文本（供模型引用回答） |

**分类维度完全自定义**：每个维度自带一组默认分类，同时支持三种扩展方式——

1. **对话即扩展**：记账时说"分类用猫咪"，未知分类名自动创建；
2. **面板 UI 管理**：每个维度页签底部的"分类管理"支持添加 / 改名（已有记录跟随迁移）/ 删除（记录归入兜底分类「其他」）；
3. 分类清单持久化在 storage-domain，重启不丢。

## 架构

```
OpenPrism/
└── plugins/
    └── openprism/               # dsh 组合包（dsh.bundle manifest + cordis.patch.yml）
        ├── src/index.ts          # 宿主半边：storage 域 + 4 个模型面工具 + HTTP 端点
        ├── src/panel.ts          # 六维度聚合（storage 记录 → 统计的纯函数）
        ├── src/types.ts          # 记录形状（expenses / moods / activities / categories）
        ├── src/client.tsx        # 浏览器半边：分页可视化面板（dsh.client 声明）
        └── build-client.mjs      # esbuild 打包为 __ModuleLoader__ 闭包
```

数据流：`对话 → 模型调用工具 → storage-domain（$DSH_HOME/storages，跨会话持久）→ 聚合纯函数 → 面板 UI / 模型汇总文本`。会话日志只携带标准 `tool/call` / `tool/result` 事件——卸载插件后任何 dsh 都能加载这些会话。

核心设计原则：

1. **一切皆插件**：OpenPrism 是 dsh 组合包，`dsh plugin` 插拔
2. **对话即录入**：结构化数据落在 storage-domain，面板只是数据的投影
3. **站在 dsh 肩膀上**：审批、沙箱、压缩、持久化、Web UI 全部继承自宿主

## 快速开始

```sh
pnpm install && pnpm build                # 构建 lib/
dsh plugin --profile web add ./plugins/openprism
dsh --profile web                          # 重启后在对话里说"花了 35 吃午饭"
dsh plugin --profile web remove openprism  # 卸载
```

## 状态

- [x] 六维度录入工具 + 跨会话聚合（storage-domain）
- [x] Web 面板 UI（分页签 + 图表 + 分类管理，5 秒轮询）
- [x] 自定义分类（对话自动创建 / UI 增删改名 / 持久化）
- [ ] 记录删除与编辑 UI
- [ ] 平台连接器（笔记、AI 工具、各类平台资源）

## License

MIT
