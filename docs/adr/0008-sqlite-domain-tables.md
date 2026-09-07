---
status: accepted
---

# 0008 存储引擎切换：SQLite 领域表

OpenPrism 应用层存储从 append-only JSONL 文件整体切换为 SQLite（Node 内置 `node:sqlite`，≥22.13 免标志），
采用**领域表建模**（13+ 张强类型表），并废除"启动全量载入内存折叠"的读模型。

## 用户裁决（2026-09-06，本 ADR 的直接动因）

1. **要领域表**：强类型列、索引、SQL 查询能力；否决"log_lines 通用行表 + JSON 透传"方案（该方案业务代码零改动，
   但行不拆列、读模型不变）。
2. **不接受启动全量载入内存**：改为启动只载用户表 + 到期任务查询；账本/会话/任务等按 uid 懒加载
   （活跃工作集缓存），会话事件按 cid 查询天然可分页。
3. **统一 SQLite**：除主密钥（`secret.key`）外全部数据入库，`users/{uid}/` 文件沙盒目录取消。

## 架构落点

- **真相层与折叠层不动（继承 ADR 0007 的裁决方式）**：`LedgerRecord` 四词表（event/plan/checkin/void）、九事件
  词表、`fold.ts` 纯函数、全部业务路由语义零改动；换的只是存储引擎与数据访问方式。
- **harness 零平台依赖铁律不破**：`node:sqlite` 只出现在 `src/app` 层；会话日志经既有 `SessionLog` 接口缝注入
  （app 层 `SqliteSessionLog` 实现，harness 的内存/JSONL 双实现保留为参考实现与测试替身）。
- **账本单表继承**：`ledger_entries` 以 `kind` 判别列 + 各类专有列建模（(uid, seq) 主键）；四类记录共享 seq 空间，
  void→target_seq 更正回路保持"只追加不抹除"。
- **九事件落 `conversation_events`**：cid+seq 唯一，type/role 冗余列供查询，`event_json` 保留完整原文（content
  块多态由 harness 类型管校验）。任务会话 cid = `task:<taskId>`，与聊天会话同表隔离。
- **可靠性增益**：WAL + `synchronous=FULL` + 事务，取代无 fsync 的文件追加与多处"整文件重写"（agents/skills/tasks
  索引、notifications markRead 均改为单行 UPDATE）；备份用 `VACUUM INTO`（WAL 伴生文件不可裸拷）。

## Considered Options

- **log_lines 通用表（FileIO 缝换引擎）**：改动最小、测试零动，但无强类型列、读模型仍是全量载入——与用户裁决冲突。
- **账本留 JSONL、其余入库（混合）**：双真源，ADR 0007 已否决（2026-08 D3.2 伤疤）。
- **better-sqlite3**：成熟但需原生编译；`node:sqlite` 零依赖、同步 API 恰好保住 persona 注入/会话签发的同步语义，
  且驱动调用收敛单文件可随时替换。

## Consequences

- 单实例假设不变（WAL 允许多读单写；多进程写需应用层协调）。
- `node:sqlite` 标记 stability 1.1（experimental）——自部署形态可接受；如遇阻塞换 better-sqlite3 只动 `db.ts`。
- 旧数据经 `migrate.ts` 一次性导入（`meta.migrated` 幂等标记），旧 JSONL 文件原样保留，可随时人工核对或回退
  （git revert 代码 + 旧目录仍在）。
- 「一个文件就是全部数据」从"一个目录"变为"一个 db 文件 + secret.key"，可导出性不降级。
