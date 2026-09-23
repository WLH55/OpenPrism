# 项目级设计类 Skills

按目录安装的第三方 agent skills（仅本项目生效，未装全局）。ZCode 会扫描
`<repo>/.agents/skills/`，Claude Code / Codex 等工具同样识别该目录。

## 清单与来源

| 目录 | 来源仓库 | 许可 | 用途 |
|---|---|---|---|
| `impeccable/` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable)（v4.1.3，plugin 编译产物） | Apache 2.0 | 前端设计总入口：audit / polish / distill / animate 等 20+ 设计命令，反 "AI 味" |
| `baseline-ui/` | [ibelick/ui-skills](https://github.com/ibelick/ui-skills) | MIT | 快速去 "AI 味"：间距、层级、排版微调 |
| `fixing-accessibility/` | 同上 | MIT | 无障碍审计与修复（ARIA、键盘、对比度） |
| `fixing-metadata/` | 同上 | MIT | HTML metadata / SEO 审计与修复 |
| `fixing-motion-performance/` | 同上 | MIT | 动画性能审计（合成层、滚动动画、blur） |
| `design-taste-frontend/` | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | MIT | 反模板化前端审美（v2，支持 VARIANCE/MOTION/DENSITY 档位） |
| `high-end-visual-design/` | 同上（soft-skill） | MIT | "高级感"：字体、留白、卡片、动效规格 |
| `redesign-existing-projects/` | 同上（redesign-skill） | MIT | 现有项目 UI 审计 + 升级，不破坏功能 |
| `full-output-enforcement/` | 同上（output-skill） | MIT | 强制完整代码输出，禁止占位符/截断 |
| `better-icons/` | [better-auth/better-icons](https://github.com/better-auth/better-icons) | MIT | 图标检索（200+ 图标库 / 20 万+ 图标），运行时经 `npx better-icons` CLI |
| `ui-design-brain/` | [carmahhawwari/ui-design-brain](https://github.com/carmahhawwari/ui-design-brain) | 见目录内 LICENSE.txt | 60+ 组件最佳实践参考（含 5 种风格预设） |

## 更新方式

均为静态文件，直接从对应上游仓库重新复制同名目录覆盖即可。
`impeccable` 上游推荐 `npx impeccable update`（按 harness 定制编译），
覆盖安装后如行为异常，可改用该方式并同步本表版本号。

## 备注

- 本仓库本身是纯 TS harness 库，这些 skills 主要服务于后续在别的分支/仓库
  做前端或 UI 工具时的复用；对 `src/harness/` 核心零影响（不 import 任何东西）。
- 刻意未装：Motion AI Kit（核心功能在付费层 Motion+）、designskills.xyz 的
  Figma→skill 生成器（网页工具，需连接 Figma；产出可直接放入本目录）。
