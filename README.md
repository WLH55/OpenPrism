# OpenPrism

> 一个你，折射出生活的每一个维度。

OpenPrism 是一个**安卓个人智能工作台 App**：与智能体对话，随手记录；数据自动沉淀为六个生活维度的统计面板；定时任务按你的自然语言指令主动做事。

**Expo (React Native) + TypeScript** 单码库。数据全部本地——App 私有目录里的 JSONL 事件日志是唯一持久层；模型接入走通用 OpenAI 兼容协议，各厂商 API key 自配、存系统安全存储，不上传任何地方。

## 架构

```
对话 UI（RN）─▶ agent 循环 ─▶ OpenAI 兼容客户端 ─▶ 各厂商 API
                   │ 工具执行（录入 / 更正 / 目标 / 查询）
                   ▼
        事件日志（events.jsonl，App 私有目录，唯一持久层）
                   │ 折叠（更正链 / 改名链 / 目标进度）
                   ▼
         面板 UI / 简报 markdown / 无头任务产物
```

领域语言见 [CONTEXT.md](CONTEXT.md)；设计决策见 [设计纪要 2026-09](docs/design/2026-09-mobile-app.md) 与 [docs/adr/](docs/adr/)。

## 快速开始

```sh
pnpm install
pnpm start          # Expo 开发服务器（手机 Expo Go 扫码预览）
pnpm android        # 连接真机 / 模拟器运行
pnpm typecheck      # tsc --noEmit
```

正式包自用 sideload（无需上架）：`npx expo run:android --variant release`。

> pnpm 需要 `.npmrc` 的 `node-linker=hoisted`（已随库提供）。

## 路线图（两批交付）

- [ ] 第一批：对话录入六维度 + 面板 + 厂商配置 + 手动简报
- [ ] 第二批：定时任务（自然语言指令 + 补跑）+ 本地通知
- [ ] 后续演进：采集/提炼管线、连接器（Chatlog、微信通道）

## 前史

v0.4 之前本项目是 dsh（DeepSeek Harness）插件，2026-09 按 [ADR 0004](docs/adr/0004-mobile-app-rewrite.md) 推翻、移动端重写。插件时代终态见 `dev` 分支（`f54c8ec`，68 测试绿）；事件日志格式不变，旧 `~/.dsh/openprism/events.jsonl` 可导入。

## License

MIT
