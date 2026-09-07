// 定时任务（D6，ADR 0008 领域表）：tasks/task_runs 两表。任务四字段（agentId/trigger/instruction/enabled）
// + 任务专属持久会话 + 调度器。触发：枚举（daily/weekly/monthly/yearly/interval/once）+ cron 逃生门（自研零依赖 5 段匹配器）；
// 补跑不补吵：锚点 = lastRunTs ?? createdTs，错过 <24h 补最近一次，≥24h 记 skipped（锚点推进，不堆积）。

import type { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "../harness/index";

export type TaskTrigger =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string } // 1=周一 … 7=周日
  | { kind: "monthly"; day: number; time: string }
  | { kind: "yearly"; month: number; day: number; time: string }
  // 自定义重复（提醒页弹窗）：每 N 个单位（分钟/小时从 startTs 直步进，无 time；天及以上锚当日 HH:mm）；
  // month/year 日历月步进且月末截断；endTs 为结束日当天末尾（含当天）
  | { kind: "interval"; every: number; unit: "minute" | "hour" | "day" | "week" | "month" | "year"; time?: string; startTs: number; endTs?: number }
  | { kind: "cron"; expr: string };

export interface TaskDef {
  id: string;
  uid: string;
  agentId?: string;
  title: string;
  instruction: string;
  trigger: TaskTrigger;
  enabled: boolean;
  tzOffsetMinutes: number;
  createdTs: number;
  lastRunTs?: number;
}

export interface TaskRun {
  ts: number;
  status: "ran" | "skipped" | "failed";
  detail?: string;
}

// ── cron 匹配器（5 段：分 时 日 月 周；支持 * n a-b a,b */n；周日用 0|7） ──

function parseField(field: string, min: number, max: number): (value: number) => boolean {
  if (field === "*") return () => true;
  const options = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    const plainMatch = /^(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step < 1) throw new Error(`bad cron step "${part}"`);
      for (let v = min; v <= max; v += step) options.add(v);
    } else if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      const step = rangeMatch[3] !== undefined ? Number(rangeMatch[3]) : 1;
      if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`bad cron range "${part}"`);
      for (let v = lo; v <= hi; v += step) options.add(v);
    } else if (plainMatch) {
      const v = Number(part);
      if (v < min || v > max) throw new Error(`bad cron value "${part}"`);
      options.add(v);
    } else {
      throw new Error(`bad cron field "${part}"`);
    }
  }
  return (value: number) => options.has(value);
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 需要 5 段（分 时 日 月 周），收到 ${fields.length} 段`);
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dayOfMonth = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  // 周日归一到 7（cron 的 0 与 7 同义）
  const weekdayField = fields[4]!.split(",").map((part) => (part === "0" ? "7" : part)).join(",");
  const weekday = parseField(weekdayField, 0, 7);
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return (
    minute(date.getUTCMinutes()) &&
    hour(date.getUTCHours()) &&
    dayOfMonth(date.getUTCDate()) &&
    month(date.getUTCMonth() + 1) &&
    weekday(day)
  );
}

// ── 触发器求值（全部在任务时区；cron 逐分钟前进，上限 2 年） ──

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function localParts(ts: number, tz: number): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const shifted = new Date(ts + tz * 60000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    wd: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
  };
}

function localTs(y: number, mo: number, d: number, h: number, mi: number, tz: number): number {
  return Date.UTC(y, mo, d, h, mi) - tz * 60000;
}

export function nextDue(trigger: TaskTrigger, fromTs: number, tz: number): number | null {
  const from = localParts(fromTs, tz);
  switch (trigger.kind) {
    case "once":
      return trigger.at;
    case "daily": {
      const m = HHMM.exec(trigger.time);
      if (!m) throw new Error(`bad time "${trigger.time}"`);
      const [h, mi] = [Number(m[1]), Number(m[2])];
      const today = localTs(from.y, from.mo, from.d, h, mi, tz);
      return today > fromTs ? today : localTs(from.y, from.mo, from.d + 1, h, mi, tz);
    }
    case "weekly": {
      const m = HHMM.exec(trigger.time);
      if (!m) throw new Error(`bad time "${trigger.time}"`);
      const [h, mi] = [Number(m[1]), Number(m[2])];
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = localTs(from.y, from.mo, from.d + offset, h, mi, tz);
        if (candidate > fromTs && trigger.days.includes(localParts(candidate, tz).wd)) return candidate;
      }
      return null;
    }
    case "monthly": {
      const m = HHMM.exec(trigger.time);
      if (!m) throw new Error(`bad time "${trigger.time}"`);
      const [h, mi] = [Number(m[1]), Number(m[2])];
      for (let monthOffset = 0; monthOffset <= 1; monthOffset++) {
        const y = from.y + Math.floor((from.mo + monthOffset) / 12);
        const mo = (from.mo + monthOffset) % 12;
        const candidate = localTs(y, mo, trigger.day, h, mi, tz);
        if (candidate > fromTs) return candidate;
      }
      return null;
    }
    case "yearly": {
      const m = HHMM.exec(trigger.time);
      if (!m) throw new Error(`bad time "${trigger.time}"`);
      const [h, mi] = [Number(m[1]), Number(m[2])];
      for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
        const candidate = localTs(from.y + yearOffset, trigger.month - 1, trigger.day, h, mi, tz);
        if (candidate > fromTs) return candidate;
      }
      return null;
    }
    case "interval": {
      const end = trigger.endTs ?? Number.POSITIVE_INFINITY;
      // 分钟/小时：从 startTs 直步进，与时刻无关
      if (trigger.unit === "minute" || trigger.unit === "hour") {
        const period = trigger.every * (trigger.unit === "minute" ? 60000 : 3600000);
        const k = Math.max(0, Math.ceil((fromTs + 1 - trigger.startTs) / period));
        const due = trigger.startTs + k * period;
        return due <= end ? due : null;
      }
      const m = HHMM.exec(trigger.time ?? "");
      if (!m) throw new Error(`bad time "${trigger.time ?? ""}"`);
      const [h, mi] = [Number(m[1]), Number(m[2])];
      const a = localParts(trigger.startTs, tz);
      const base = localTs(a.y, a.mo, a.d, h, mi, tz); // 首个候选 = 锚点日 HH:mm（time 为准）
      if (trigger.unit === "day" || trigger.unit === "week") {
        const period = trigger.every * (trigger.unit === "day" ? 86400000 : 7 * 86400000);
        const k = Math.max(0, Math.ceil((fromTs + 1 - base) / period));
        const due = base + k * period;
        return due <= end ? due : null;
      }
      // month/year：锚点日起按日历月步进，月末截断（如 1 月 31 号 → 2 月 28 号）
      const stepMonths = trigger.every * (trigger.unit === "month" ? 1 : 12);
      const avgMs = stepMonths * 30.44 * 86400000;
      const kStart = Math.max(0, Math.floor((fromTs - base) / avgMs) - 2);
      for (let k = kStart; k <= kStart + 240; k++) {
        const months = k * stepMonths;
        const y = a.y + Math.floor((a.mo + months) / 12);
        const mo = (a.mo + months) % 12;
        const d = Math.min(a.d, new Date(Date.UTC(y, mo + 1, 0)).getUTCDate());
        const due = localTs(y, mo, d, h, mi, tz);
        if (due > fromTs) return due <= end ? due : null;
      }
      return null;
    }
    case "cron": {
      cronMatches(trigger.expr, new Date(fromTs + tz * 60000)); // 语法校验（抛错）
      // 逐分钟前进（当地时区），上限 2 年
      let cursor = Math.floor((fromTs + tz * 60000) / 60000) * 60000;
      const limit = fromTs + 2 * 365 * 86400000;
      while (cursor <= limit) {
        if (cronMatches(trigger.expr, new Date(cursor))) return cursor - tz * 60000;
        cursor += 60000;
      }
      return null;
    }
  }
}

function validateTrigger(trigger: TaskTrigger): void {
  switch (trigger.kind) {
    case "once":
      if (!Number.isFinite(trigger.at)) throw new Error("once 需要 at（epoch 毫秒）");
      return;
    case "weekly":
      if (!Array.isArray(trigger.days) || trigger.days.length === 0 || trigger.days.some((d) => d < 1 || d > 7)) {
        throw new Error("weekly 需要 days（1=周一 … 7=周日）");
      }
      break;
    case "monthly":
      if (trigger.day < 1 || trigger.day > 31) throw new Error("monthly 需要 day 1-31");
      break;
    case "yearly":
      if (trigger.month < 1 || trigger.month > 12) throw new Error("yearly 需要 month 1-12");
      if (trigger.day < 1 || trigger.day > 31) throw new Error("yearly 需要 day 1-31");
      break;
    case "interval":
      if (!Number.isInteger(trigger.every) || trigger.every < 1) throw new Error("interval 需要 every ≥ 1 的整数");
      if (!["minute", "hour", "day", "week", "month", "year"].includes(trigger.unit)) throw new Error(`interval unit 非法：${String(trigger.unit)}`);
      if (!Number.isFinite(trigger.startTs)) throw new Error("interval 需要 startTs（epoch 毫秒）");
      if (trigger.endTs !== undefined && (!Number.isFinite(trigger.endTs) || trigger.endTs < trigger.startTs)) {
        throw new Error("interval endTs 需不早于 startTs（epoch 毫秒）");
      }
      break;
    default:
      break;
  }
  nextDue(trigger, 0, 0); // time/cron 语法校验（抛错）
}

// ── 存储 ────────────────────────────────────────────────

export interface TaskStoreDeps {
  db: DatabaseSync;
  now(): number;
  randomUUID(): string;
}

interface TaskRow {
  id: string;
  uid: string;
  agent_id: string | null;
  title: string;
  instruction: string;
  trigger_json: string;
  enabled: number;
  tz_offset_minutes: number;
  created_ts: number;
  last_run_ts: number | null;
}

function rowToTask(row: TaskRow): TaskDef {
  return {
    id: row.id,
    uid: row.uid,
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    title: row.title,
    instruction: row.instruction,
    trigger: JSON.parse(row.trigger_json) as TaskTrigger,
    enabled: row.enabled === 1,
    tzOffsetMinutes: row.tz_offset_minutes,
    createdTs: row.created_ts,
    ...(row.last_run_ts !== null ? { lastRunTs: row.last_run_ts } : {}),
  };
}

export class TaskStore {
  constructor(private deps: TaskStoreDeps) {}

  async list(uid: string): Promise<TaskDef[]> {
    const rows = this.deps.db
      .prepare("SELECT * FROM tasks WHERE uid = ? ORDER BY created_ts, id")
      .all(uid) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  async get(uid: string, id: string): Promise<TaskDef | null> {
    const row = this.deps.db.prepare("SELECT * FROM tasks WHERE id = ? AND uid = ?").get(id, uid) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  async create(
    uid: string,
    input: Omit<TaskDef, "id" | "uid" | "createdTs" | "enabled" | "tzOffsetMinutes"> &
      Partial<Pick<TaskDef, "enabled" | "tzOffsetMinutes">>,
  ): Promise<TaskDef> {
    if (input.title.trim() === "" || input.instruction.trim() === "") throw new Error("title/instruction 必填");
    validateTrigger(input.trigger);
    const task: TaskDef = {
      id: this.deps.randomUUID(),
      uid,
      agentId: input.agentId,
      title: input.title.trim(),
      instruction: input.instruction.trim(),
      trigger: input.trigger,
      enabled: input.enabled ?? true,
      tzOffsetMinutes: input.tzOffsetMinutes ?? 0,
      createdTs: this.deps.now(),
    };
    this.deps.db
      .prepare(
        "INSERT INTO tasks (id, uid, agent_id, title, instruction, trigger_json, enabled, tz_offset_minutes, created_ts, last_run_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(task.id, uid, task.agentId ?? null, task.title, task.instruction, JSON.stringify(task.trigger), task.enabled ? 1 : 0, task.tzOffsetMinutes, task.createdTs);
    return task;
  }

  async update(uid: string, id: string, patch: Partial<Pick<TaskDef, "enabled" | "instruction" | "title" | "trigger">>): Promise<TaskDef> {
    const task = await this.get(uid, id);
    if (!task) throw new Error(`task "${id}" 不存在`);
    if (patch.trigger) validateTrigger(patch.trigger);
    const next: TaskDef = { ...task, ...patch };
    this.deps.db
      .prepare("UPDATE tasks SET title = ?, instruction = ?, trigger_json = ?, enabled = ? WHERE id = ? AND uid = ?")
      .run(next.title, next.instruction, JSON.stringify(next.trigger), next.enabled ? 1 : 0, id, uid);
    return next;
  }

  async remove(uid: string, id: string): Promise<void> {
    const result = this.deps.db.prepare("DELETE FROM tasks WHERE id = ? AND uid = ?").run(id, uid);
    if (result.changes === 0) throw new Error(`task "${id}" 不存在`);
    this.deps.db.prepare("DELETE FROM task_runs WHERE task_id = ? AND uid = ?").run(id, uid);
    // 任务专属会话的事件一并清理（旧文件版此处会遗留孤儿 session.jsonl）
    this.deps.db.prepare("DELETE FROM conversation_events WHERE cid = ?").run(`task:${id}`);
  }

  async runs(uid: string, id: string): Promise<TaskRun[]> {
    const rows = this.deps.db
      .prepare("SELECT ts, status, detail FROM task_runs WHERE uid = ? AND task_id = ? ORDER BY ts, id")
      .all(uid, id) as unknown as { ts: number; status: TaskRun["status"]; detail: string | null }[];
    return rows.map((row) => ({ ts: row.ts, status: row.status, ...(row.detail !== null ? { detail: row.detail } : {}) }));
  }

  async recordRun(uid: string, id: string, run: TaskRun): Promise<void> {
    this.deps.db
      .prepare("INSERT INTO task_runs (uid, task_id, ts, status, detail) VALUES (?, ?, ?, ?, ?)")
      .run(uid, id, run.ts, run.status, run.detail ?? null);
  }

  /** 锚点推进（补跑/执行/失败共用）：替代旧版整文件重写 */
  async updateLastRun(uid: string, id: string, ts: number): Promise<void> {
    this.deps.db.prepare("UPDATE tasks SET last_run_ts = ? WHERE id = ? AND uid = ?").run(ts, id, uid);
  }
}

// ── 调度器 ──────────────────────────────────────────────

export interface SchedulerDeps {
  uids(): string[];
  tasks: TaskStore;
  runTask(uid: string, task: TaskDef): Promise<void>;
  now(): number;
  intervalMs?: number;
  logger?(line: string): void;
}

const CATCHUP_WINDOW_MS = 24 * 3600 * 1000;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    const interval = this.deps.intervalMs ?? 30_000;
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 触发到点/补跑；返回实际执行数（测试用）。锚点 = lastRunTs ?? createdTs。 */
  async tick(): Promise<number> {
    const now = this.deps.now();
    let fired = 0;
    for (const uid of this.deps.uids()) {
      const tasks = await this.deps.tasks.list(uid);
      for (const task of tasks) {
        if (!task.enabled) continue;
        const anchor = task.lastRunTs ?? task.createdTs;
        let due: number | null;
        try {
          due = nextDue(task.trigger, anchor, task.tzOffsetMinutes);
        } catch (error) {
          this.deps.logger?.(`[tasks] bad trigger ${task.id}: ${String((error as Error).message)}`);
          continue;
        }
        if (due === null) continue;
        if (task.trigger.kind === "once" && due <= anchor) continue; // 单次已跑过
        if (due > now) continue;
        if (now - due >= CATCHUP_WINDOW_MS) {
          // 补跑窗口外：跳过并推进锚点（不堆积，D6.3）
          task.lastRunTs = now;
          await this.deps.tasks.updateLastRun(uid, task.id, now);
          await this.deps.tasks.recordRun(uid, task.id, { ts: now, status: "skipped", detail: `错过 ${(now - due) / 3600000}h` });
          continue;
        }
        try {
          await this.deps.runTask(uid, task);
          task.lastRunTs = now;
          await this.deps.tasks.updateLastRun(uid, task.id, now);
          await this.deps.tasks.recordRun(uid, task.id, { ts: now, status: "ran" });
          fired += 1;
        } catch (error) {
          task.lastRunTs = now;
          await this.deps.tasks.updateLastRun(uid, task.id, now);
          await this.deps.tasks.recordRun(uid, task.id, { ts: now, status: "failed", detail: String((error as Error).message).slice(0, 200) });
        }
      }
    }
    return fired;
  }
}

// ── 模型工具（双入口之一：与智能体对话管理任务，D6.4；2026-09-04 补齐 CRUD） ──

export interface TaskToolsDeps {
  store: TaskStore;
  uid: string;
  /** nextDueAt 展示用（query_tasks）；缺省 0（once 任务原样回 at） */
  now(): number;
}

export function createTaskTools(deps: TaskToolsDeps): ToolDefinition[] {
  const createTask: ToolDefinition = {
    name: "create_task",
    description: "为用户创建一个定时任务（提醒/定时检查）。触发时刻用结构化字段，解析不了就问用户，不要猜。",
    parameters: {
      type: "object",
      required: ["title", "instruction", "trigger"],
      properties: {
        title: { type: "string" },
        instruction: { type: "string", description: "每次到点投给智能体的自然语言指令" },
        trigger: {
          type: "object",
          description: '如 {"kind":"daily","time":"23:00"} / {"kind":"weekly","days":[1,3],"time":"08:00"} / {"kind":"interval","every":2,"unit":"day","time":"09:00","startTs":epoch毫秒}（自定义重复，unit: minute|hour|day|week|month|year，minute/hour 不带 time，可选 endTs） / {"kind":"once","at":epoch毫秒} / {"kind":"cron","expr":"0 9 * * *"}',
        },
      },
    },
    output: {
      schema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: `已建定时任务（${(value as { taskId: string }).taskId}）` }],
    },
    async execute(args) {
      const input = (args ?? {}) as { title?: string; instruction?: string; trigger?: TaskTrigger };
      const task = await deps.store.create(deps.uid, {
        title: String(input.title ?? ""),
        instruction: String(input.instruction ?? ""),
        trigger: input.trigger as TaskTrigger,
      });
      return { taskId: task.id };
    },
    isConcurrencySafe: () => false,
  };

  const queryTasks: ToolDefinition = {
    name: "query_tasks",
    description: "查用户的定时任务列表：id、标题、触发、启用态、下次到点。用户问「我有哪些提醒」「那个任务还在吗」就用它。",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "只看启用（true）或停用（false）的；缺省 = 全部" },
      },
    },
    output: {
      schema: { type: "object", required: ["tasks"], properties: { tasks: { type: "array" } } },
      render: (_args, value) => {
        const tasks = (value as { tasks: { title: string }[] }).tasks ?? [];
        const text = tasks.length === 0 ? "没有定时任务" : `共 ${tasks.length} 个：${tasks.map((t) => t.title).join("；")}`;
        return [{ type: "text", text }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { enabled?: boolean };
      const all = await deps.store.list(deps.uid);
      const tasks = all
        .filter((t) => (input.enabled === undefined ? true : t.enabled === input.enabled))
        .map((t) => {
          let nextDueAt: number | undefined;
          try {
            const due = nextDue(t.trigger, deps.now(), t.tzOffsetMinutes);
            if (due !== null) nextDueAt = due;
          } catch {
            // 坏 trigger：列出原样，别让查询整体失败
          }
          return {
            id: t.id,
            title: t.title,
            instruction: t.instruction,
            trigger: t.trigger,
            enabled: t.enabled,
            ...(t.agentId !== undefined ? { agentId: t.agentId } : {}),
            ...(t.lastRunTs !== undefined ? { lastRunTs: t.lastRunTs } : {}),
            ...(nextDueAt !== undefined ? { nextDueAt } : {}),
          };
        });
      return { tasks };
    },
    isConcurrencySafe: () => true,
  };

  const updateTask: ToolDefinition = {
    name: "update_task",
    description: "修改定时任务：启停（enabled）、改标题/指令/触发时刻。taskId 从 query_tasks 拿。",
    parameters: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        enabled: { type: "boolean" },
        title: { type: "string" },
        instruction: { type: "string" },
        trigger: { type: "object", description: "与 create_task 同格式，整包替换" },
      },
    },
    output: {
      schema: { type: "object", required: ["id", "title", "enabled"], properties: { id: { type: "string" }, title: { type: "string" }, enabled: { type: "boolean" } } },
      render: (_args, value) => {
        const v = value as { title: string; enabled: boolean };
        return [{ type: "text", text: `已更新任务「${v.title}」（${v.enabled ? "启用" : "停用"}）` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { taskId?: string; enabled?: boolean; title?: string; instruction?: string; trigger?: TaskTrigger };
      if (typeof input.taskId !== "string" || input.taskId === "") throw new Error("taskId 必填（query_tasks 拿）");
      const patch: Parameters<TaskStore["update"]>[2] = {};
      if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
      if (input.title !== undefined) patch.title = String(input.title);
      if (input.instruction !== undefined) patch.instruction = String(input.instruction);
      if (input.trigger !== undefined) patch.trigger = input.trigger as TaskTrigger;
      if (Object.keys(patch).length === 0) throw new Error("至少改一项：enabled / title / instruction / trigger");
      const task = await deps.store.update(deps.uid, input.taskId, patch);
      return { id: task.id, title: task.title, enabled: task.enabled };
    },
    isConcurrencySafe: () => false,
  };

  const deleteTask: ToolDefinition = {
    name: "delete_task",
    description: "删除定时任务：用户说「这个提醒不要了/别再叫我」时用。删前不必确认服务器，但拿不准用户意图时先问一句。",
    parameters: {
      type: "object",
      required: ["taskId"],
      properties: { taskId: { type: "string" } },
    },
    output: {
      schema: { type: "object", required: ["deleted"], properties: { deleted: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: `已删除任务「${(value as { deleted: string }).deleted}」` }],
    },
    async execute(args) {
      const taskId = String((args as { taskId?: string } | undefined)?.taskId ?? "");
      if (taskId === "") throw new Error("taskId 必填（query_tasks 拿）");
      const hit = (await deps.store.list(deps.uid)).find((t) => t.id === taskId);
      if (!hit) throw new Error(`task "${taskId}" 不存在，先用 query_tasks 查`);
      await deps.store.remove(deps.uid, taskId);
      return { deleted: hit.title };
    },
    isConcurrencySafe: () => false,
  };

  return [createTask, queryTasks, updateTask, deleteTask];
}
