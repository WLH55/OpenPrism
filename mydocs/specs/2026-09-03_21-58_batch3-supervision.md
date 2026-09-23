# SDD Spec: 批次 3「监督」

> 状态：`[EXECUTE]`（自动连跑授权内）。前序：批次 1（2c2e926）、批次 2（500a85e）。
> 设计依据：docs/design/2026-09-app.md §D6（6.1–6.5 定时任务）§D9（通知通道首版 = 站内）。

## 1. Requirements

- **Goal**: 监督支柱成立——定时任务到点跑智能体「离线回合」+ 站内通知；补跑不补吵。
- **In-Scope**:
  1. 任务四字段（D6.4）：`agentId` + `trigger` + `instruction`（自然语言 followup）+ `enabled`；触发两类：单次（datetime）与周期（daily HH:MM / weekly [周一..周日] HH:MM / monthly D HH:MM / yearly MM-DD HH:MM + cron 逃生门，自研零依赖 5 段 cron 匹配器）；时刻绑定任务时区（默认服务器时区）。
  2. 任务专属持久会话（6.2）：`users/{uid}/tasks/{tid}/session.jsonl`；到点 = 调度器往该会话投 followup(instruction)；离线回合同权（同工具/绑定/Turn 预算，6.5）；账本 actor.agentName = 任务伙伴名，conversationId = taskId。
  3. 调度器：进程内 tick（默认 30s，时钟注入）；到点串行执行；运行历史 `runs.jsonl`（{ts,status: ran|skipped|failed}）。
  4. 补跑不补吵（6.3）：启动/tick 发现错过且 <24h → 只补最近一次；≥24h → 记 skipped 不跑；推送不吵（通知未读不打扰式呈现）。
  5. 双入口（6.4）：表单 API + 模型工具 `create_task`（与智能体对话可建任务；解析失败 = 工具 isError）。
  6. 通知（D9 首版）：`users/{uid}/notifications.jsonl` 追加 {seq,ts,kind:"task_message",taskId,text,readTs?}；通道缝 = `notify(uid, payload)` 多通道数组（首版仅站内）；离线回合收口后把助手文本落通知。
  7. Web：提醒页（任务列表/新建表单/启停/立即跑/运行历史）+ 顶栏通知铃（未读数、列表、已读）。
- **Out-of-Scope**: 微信桥（专项调研）、勿扰时段规则、任务密度上限（Q8 成本话题后续）、推送（Web 之外）。

## 4. Plan

### 4.1 File Changes

- 新 `src/app/tasks.ts`（TaskStore + 触发器 + cron 匹配 + nextDue + Scheduler + create_task 工具）、`src/app/notify.ts`（NotificationStore + 通道缝）
- 改 `src/app/conversations.ts`（assemble 参数化 sessionDir/fixedAgentId → `taskAgent(uid, tid, agentId)`）
- 改 `src/app/server.ts`（任务/通知路由；ServerDeps 增 tasks/notifications/scheduler 钩子）、`src/app/main.ts`（装配 + 启动 Scheduler）
- 测试：新 `test/app-tasks.test.ts`、`test/app-notify.test.ts`；扩 `test/app-conversations.test.ts`（taskAgent）、`test/app-server.test.ts`（任务/通知路由）
- Web：新 `pages/Tasks.tsx`、`Notifications.tsx`（或并入顶栏）；改 `App.tsx`、`api.ts`、`Chat.tsx`（顶栏铃铛）

### 4.2 Signatures（核心）

```ts
// tasks.ts
export type TaskTrigger =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: "HH:mm" }
  | { kind: "weekly"; days: number[]; time: "HH:mm" }        // 1=周一..7=周日
  | { kind: "monthly"; day: number; time: "HH:mm" }
  | { kind: "yearly"; month: number; day: number; time: "HH:mm" }
  | { kind: "cron"; expr: string };                           // 5 段（分 时 日 月 周）
export interface TaskDef { id: string; uid: string; agentId?: string; title: string; instruction: string;
  trigger: TaskTrigger; enabled: boolean; tzOffsetMinutes: number; createdTs: number; lastRunTs?: number; }
export function cronMatches(expr: string, date: Date): boolean;        // 支持 * / */n / n / a-b / a,b（周日用 0|7）
export function nextDue(trigger: TaskTrigger, fromTs: number, tz: number): number | null; // 单调下一到期（epoch ms；无解 null）
export interface TaskRun { ts: number; status: "ran" | "skipped" | "failed"; detail?: string; }
export class TaskStore {
  constructor(deps: { fileIO: FileIO; paths: AppPaths; now(): number; randomUUID(): string });
  list(uid): Promise<TaskDef[]>; get(uid, id): Promise<TaskDef | null>;
  create(uid, input: Omit<TaskDef, "id"|"uid"|"createdTs"|"enabled"|"tzOffsetMinutes"> & Partial<Pick<TaskDef,"enabled"|"tzOffsetMinutes">>): Promise<TaskDef>; // trigger 非法 → throw
  update(uid, id, patch: Partial<Pick<TaskDef, "enabled"|"instruction"|"title"|"trigger">>): Promise<TaskDef>;
  remove(uid, id): Promise<void>;
  runs(uid, id): Promise<TaskRun[]>; recordRun(uid, id, run): Promise<void>;
  saveAll(uid, tasks): Promise<void>;      // lastRunTs 持久化（原子重写 index）
}
export interface SchedulerDeps { uids(): string[]; tasks: TaskStore; runTask(uid, task): Promise<void>;
  now(): number; intervalMs?: number; logger?(line: string): void; }
export class Scheduler { start(): void; stop(): void; tick(): Promise<number>; } // tick 返回触发数（测试用）
export function createTaskTool(deps: { store: TaskStore; uid: string }): ToolDefinition;   // name="create_task"

// notify.ts
export interface NotificationRow { seq: number; ts: number; kind: string; taskId?: string; text: string; readTs?: number; }
export type NotifyChannel = (uid: string, payload: { kind: string; taskId?: string; text: string }) => Promise<void>;
export class NotificationStore {
  constructor(deps: { fileIO: FileIO; paths: AppPaths; now(): number });
  push(uid, payload): Promise<NotificationRow>;        // 站内通道落盘
  list(uid, opts?: { unreadOnly?: boolean }): Promise<NotificationRow[]>;
  unreadCount(uid): Promise<number>;
  markRead(uid, seq | "all"): Promise<void>;
}
export function inAppChannel(store: NotificationStore): NotifyChannel;

// conversations.ts 增量
taskAgent(uid: string, taskId: string, agentId: string | undefined): Promise<Agent>;  // 任务会话装配（同 chat 装配，sessionDir=tasks/{tid}，伙伴=task.agentId ?? 默认）
```

HTTP 路由（新增）：
```
GET/POST /api/tasks；PUT/DELETE /api/tasks/:id；POST /api/tasks/:id/run（立即跑，202）；GET /api/tasks/:id/runs
GET  /api/notifications?unread=1；POST /api/notifications/read {seq | all}
```

### 4.3 Checklist（TDD 红→绿）

- [ ] 1. `test/app-notify.test.ts`：push/list/unread/markRead 往返
- [ ] 2. `test/app-tasks.test.ts` 之 cron/nextDue：枚举触发器与 cron 匹配（固定时钟）
- [ ] 3. TaskStore CRUD + runs + trigger 校验（非法 throw）
- [ ] 4. Scheduler.tick：到点跑（mock runTask 计数）、未到点不跑、错过 <24h 补一次、≥24h skipped、禁用不跑、once 跑后不再跑
- [ ] 5. conversations.taskAgent（mock adapter：followup 落任务会话日志 + actor.conversationId=taskId）
- [ ] 6. create_task 工具（execute 落任务、坏 trigger 抛错）
- [ ] 7. server 路由 + main 装配启动 Scheduler（含 runTask 真链路：mock adapter → 任务会话 → 通知落盘）
- [ ] 8. web：Tasks 页 + 通知铃 + api 扩展
- [ ] 9. 全量绿 → commit 批次 3 → 进批次 4

### 4.4 风险

- cron 扫描上限：nextDue 逐分钟前进，上限 2 年；越界 null（任务标记失效由 UI 呈现）。
- 单进程调度：自部署语义（进程停 = 不跑，重启补跑窗口兜底）——与 D6.3 一致。

## 5. Execute Log（2026-09-03，批量 TDD 红→绿）

- [x] 1. `test/app-notify.test.ts`（RED→GREEN 2）→ notify.ts。
- [x] 2–4. `test/app-tasks.test.ts`（RED→GREEN 8）：cron/nextDue/TaskStore 校验/Scheduler 四语义（到点、<24h 补、≥24h skipped、禁用、once 一次）。过程修正：cron 周日 0/7 归一、weekly/monthly/yearly 显式范围校验、测试补 tzOffsetMinutes（锚点=lastRunTs??createdTs 语义的用例重构为两阶段世界）。
- [x] 5. `taskAgent`（conversations 装配参数化 sessionPath/metaOf；池 key `uid:task:tid`）→ 测试 1。
- [x] 6. `create_task` 工具（含聊天装配常驻）→ 测试 1。
- [x] 7. server 任务/通知路由（手动跑异步 202 + 运行历史；通知未读/已读）+ main 装配 runTask（离线回合→任务会话→助手文本落通知）+ Scheduler.start(30s) → server 测试 15。
- [x] 8. web：Tasks 页（新建表单 daily/weekly/cron、启停、立即跑、历史）+ 顶栏 Bell（15s 轮询未读、全部已读）+ api3。
- [x] 9. 根 176 tests 全绿（22 文件）+ 双 typecheck 0 + web build 过 → commit。

## 6. Review Verdict

| 轴 | 结论 | 证据 |
|---|---|---|
| Spec 质量 & 需求达成 | **PASS** | 四字段/枚举+cron/任务会话/补跑窗口/双入口/站内通知全部落地并有行为测试（tick 计数、runs 状态、未读计数） |
| Spec-代码一致性 | **PASS（偏差已记）** | §7 两条 |
| 代码自身质量 | **PASS** | 时钟全注入；调度 tick 可单测；异步手动跑以轮询测试（小真实延迟合规） |

- Overall Verdict: **PASS** · Blocking Issues: 无 · Regression risk: Low
- Follow-ups：① cron 逐分钟扫描 O(分钟)——量级可接受，热点再优化；② 通知 15s 轮询（SSE 推送留批次 4 或后续）；③ 微信桥（D9.2）专项调研未动。

## 7. Plan-Execution Diff

1. `create_task` 工具装配进 conversations（deps.tasks 可选）而非仅 server 注入——双入口同源。
2. 通知页合并为顶栏 Bell 组件（独立页信息量不值一页），Tasks 页承担任务管理。

## 8. Archive Record

- 已随批次 3 提交；批次 4 完成后统一 archive。
