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

数据流（v0.4）：`对话 → 模型调用工具 → 会话日志（tool/call，录入凭据）→ 镜像器 → 全局事件日志（唯一持久层，可随时从会话日志重建）→ 折叠 → 面板 UI / 模型汇总 / 简报`。采集管线（always-record）把用户消息落按月分片的采集日志，夜间提炼为结构化事件。卸载插件后任何 dsh 都能加载这些会话。

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

- [x] 六维度录入工具 + 跨会话聚合（v0.4 起数据存全局事件日志，可从会话日志重建）
- [x] Web 面板 UI（分页签 + 图表 + 分类管理 + 目标进度 + 91 天热力图 + 周期切片，移动优先）
- [x] 自定义分类（对话自动创建 / UI 增删改名 / 持久化）
- [x] 记录删除与编辑（对话 openprism_correct + 面板最近记录操作）
- [x] 采集管线（always-record 捕获 + 夜间 LLM 提炼，采集原料按月分片）
- [x] 目标/预算体系（openprism_set_goal + 面板目标进度）
- [x] 每日/每周简报（reports/YYYY-MM markdown，数据零 token + 可选 LLM 解读）
- [ ] 微信投递（webhook 投递缝已就绪，im-bridge fork 待做）
- [ ] 平台连接器（Chatlog 适配已就绪，需本机 chatlog 服务）

## License

MIT
