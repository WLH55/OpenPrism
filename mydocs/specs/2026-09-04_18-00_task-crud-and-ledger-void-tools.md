# Spec：模型侧任务 CRUD + 账本修正工具（2026-09-04 18:00）

## 背景

用户实测反馈（引用其伙伴的原话）：「我这边没有取消/删除定时任务的工具，只能建，不能撤。23:30 那个我撤不掉。」——模型侧只有 `create_task`，查/改/删全缺；UI 的提醒页本就能删，但用户要求**模型侧增删改查对等**（记账/计划/打卡/定时提醒/查账本/记偏好都应齐）。

同源铁律下还有两个对称缺口一并补：

- 流水记错/重复：模型无作废工具（`/api/void` 只有 UI 入口），且 `query_ledger` flows 不回 seq，模型连引用都拿不到；
- 计划不要了：模型无取消工具，只能放着不管（永远出现在覆盖周期里）。

## 改动清单

| # | 改动 | 文件 |
|---|---|---|
| 1 | `createTaskTool` → `createTaskTools`：create_task + **query_tasks** + **update_task** + **delete_task** | `src/app/tasks.ts` |
| 2 | 新工具 **void_flow**（按 seq 作废流水，修正 = 作废后重记） | `src/app/tools.ts` |
| 3 | 新工具 **cancel_plan**（按 planId 作废计划记录） | `src/app/tools.ts` |
| 4 | `query_ledger` what=flows 输出补 `seq`（模型引用作废目标的凭据） | `src/app/tools.ts` |
| 5 | 纪律段补两条：任务可管理（建/查/改/删，用户说不要了就删）；记错不将就（void_flow / cancel_plan 走作废回路，不口头说改好了） | `src/app/persona.ts` |
| 6 | 装配处换 `createTaskTools`（四工具整组挂载，不参与 binding.tools 过滤，与 create_task 现状同语义） | `src/app/conversations.ts` |

## 设计裁决

- **作废而非改写**：void_flow/cancel_plan 都走账本既有的 void 回路（追加 `void` 引用 `targetSeq`），不新增原地改写路径——审计性不动摇。「改」= 作废 + 重记，与分类合并同一语义。
- **删除任务 = 物理删**：TaskStore.remove 是既有存储面（UI 同款）；任务不是账本事件，无审计义务，模型与 UI 同权即可。
- **update_task 面最小**：enabled/title/instruction/trigger 四字段，至少改一项；trigger 复用 create 同校验（validateTrigger）。
- **query_tasks 附 nextDueAt**：用既有 `nextDue`（任务自己的 tzOffsetMinutes）算下次到点，模型能直接回答"它什么时候还会响"；坏 trigger 容错跳过。
- **偏好（save_preference）维持追加制**：删改经记忆页人工编辑（D5 既定），本批不动。
- 模型可见性：新工具照常以 tool_call/result 落会话日志，不变量不受影响。

## Checklist

- [x] tasks.ts 四工具（含输出 schema/render、坏输入抛错）
- [x] tools.ts void_flow/cancel_plan + flows 补 seq
- [x] persona.ts 纪律两条
- [x] conversations.ts 装配更新
- [x] 测试：app-tasks（工具 CRUD 往返）、app-tools（作废回路 + seq）、app-conversations（装配名单）
- [x] `pnpm typecheck` + `pnpm test` 全绿
- [x] 设计纪要 D6.4/D2.2 增补 + 实现汇报文档更新
- [x] 重启服务器（用户实例即刻生效）+ commit/push

## Execute Log

- `src/app/tasks.ts`：`createTaskTool` → `createTaskTools(deps: { store, uid, now })` 返回四工具；query_tasks 附 nextDueAt（任务自身 tzOffsetMinutes 求 nextDue，坏 trigger 容错跳过）；update_task 空 patch / 坏 taskId / 坏 trigger 抛错；delete_task 先查后删、不存在抛错。query_tasks `isConcurrencySafe: true`（纯读）。
- `src/app/tools.ts`：新增 void_flow（Number.isInteger 校验 seq；只认 active 流水）与 cancel_plan（按 planId 找活跃计划，void 其 seq，reason 缺省"用户取消计划"）；query_ledger what=flows 输出补 seq。返回数组从四件变六件。
- `src/app/persona.ts`：DISCIPLINE 增两条——记错不将就（void_flow/cancel_plan 必须走工具）；定时任务完整可管理（建/查/改/删，用户说不要了就删，不要说没办法）。
- `src/app/conversations.ts`：`createTaskTool(...)` → `tools.push(...createTaskTools({ store, uid, now }))`。
- 测试：app-tasks 新增四用例（每用例独立 uid，修掉首版同 uid 跨用例污染）；app-tools 新增作废回路两用例 + 工具名单六件 + flows seq 断言；app-conversations 两处装配名单更新（默认助手 11 工具；binding 过滤后 7 工具——任务四件不参与 binding.tools 过滤，与既有 create_task 同语义）。
- 途中修过的问题：query_tasks render 首版有坏语法（中文分号混入 join）当场修正；typecheck 报 `input.seq` 未收窄，改局部 `const seq = Number(...)` 后通过。
- 验证：`pnpm typecheck` 0 错误；`pnpm test` 190/190 全绿（23 文件）。

## Review Verdict

**PASS**。改动全部落在 app 层，harness 零触碰；新工具照常走 tool_call/result 落会话日志，"model-visible means logged" 不变量不受影响。作废回路复用既有 void 原语（无新写入路径）；任务删除与 UI 同一存储面。用户实例重启后即可对伙伴说"把 23:30 那个任务删了"。
