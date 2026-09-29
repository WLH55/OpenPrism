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
  /** 通知渠道（2026-09-27）：inapp 站内（默认）| wechat 站内记录+微信机器人推送；缺省 = inapp */
  notifyChannel?: "inapp" | "wechat";
  /** 内置任务标记（2026-09-29）：每用户种子一次性（users.builtins_seeded），删了不复活；UI 带「内置」徽标 */
  builtin?: BuiltinTaskKind;
  tzOffsetMinutes: number;
  createdTs: number;
  lastRunTs?: number;
}

/** 内置三件套（2026-09-29 SDD 逾期处理与内置任务）：标记值即身份 */
export type BuiltinTaskKind = "daily-brief" | "daily-report" | "weekly-review";

export interface TaskRun {
  ts: number;
  status: "ran" | "skipped" | "failed";
  detail?: string;
}

/** 本次运行的来路：调度器按计划到点（带计划时刻 due）或用户在界面手动触发 */
export type TaskRunTrigger = { kind: "scheduled"; due: number } | { kind: "manual" };

/** 定时提醒会话的 cid 前缀（每伙伴一个，见 conversations.ensureTaskFeed） */
export const TASK_FEED_CID_PREFIX = "feed:";
/** 任务专属会话的 cid 前缀（会话日志键 = `task:<taskId>`） */
export const TASK_SESSION_CID_PREFIX = "task:";

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

// ── 触发描述与到点注入（提醒会话的上下文，2026-09-23） ──
// 调度器到点时只投一句任务指令的话，模型会当成普通对话反问时间与频率；
// 这里把「这是自动触发 + 任务内容 + 重复规则 + 计划时刻与实际触发时刻」一次写全。

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"]; // 1=周一 … 7=周日

/** 按任务时区显示时刻（用户看到的是自己钟面上的日期与钟点）；秒非零时补 :ss（单次任务可指定到秒），整分保持 HH:mm */
export function formatLocal(ts: number, tzOffsetMinutes: number): string {
  const shifted = new Date(ts + tzOffsetMinutes * 60000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const base = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  return ts % 60000 === 0 ? base : `${base}:${pad(shifted.getUTCSeconds())}`;
}

/** 触发规则的人话描述（到点注入与记忆提取共用同一份口径） */
export function describeTrigger(trigger: TaskTrigger, tzOffsetMinutes = 0): string {
  switch (trigger.kind) {
    case "once":
      return `单次 ${formatLocal(trigger.at, tzOffsetMinutes)}`;
    case "daily":
      return `每天 ${trigger.time}`;
    case "weekly": {
      const days = trigger.days.map((day) => WEEKDAY_NAMES[day] ?? `周${day}`).join("、");
      return days === "" ? `每周 ${trigger.time}` : `每${days} ${trigger.time}`;
    }
    case "monthly":
      return `每月 ${trigger.day} 日 ${trigger.time}`;
    case "yearly":
      return `每年 ${trigger.month} 月 ${trigger.day} 日 ${trigger.time}`;
    case "interval": {
      const unit = { minute: "分钟", hour: "小时", day: "天", week: "周", month: "个月", year: "年" }[trigger.unit];
      const freq = trigger.every === 1 ? `每${unit}` : `每 ${trigger.every} ${unit}`;
      return trigger.time ? `${freq} ${trigger.time}` : freq;
    }
    case "cron":
      return `cron 表达式 ${trigger.expr}`;
  }
}

/** 延迟时长的人话描述（补跑标注用） */
function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分钟`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

/** 到点投给模型的任务上下文（提醒会话的指令正文，落 user/message 事件可见） */
export function taskTriggerMessage(task: TaskDef, run: TaskRunTrigger, now: number): string {
  const lines = [
    `【定时任务触发】${task.title}`,
    `任务内容：${task.instruction}`,
    `重复规则：${describeTrigger(task.trigger, task.tzOffsetMinutes)}`,
  ];
  if (run.kind === "scheduled") {
    const delay = now - run.due;
    lines.push(`计划时刻：${formatLocal(run.due, task.tzOffsetMinutes)}`);
    lines.push(`触发时刻：${formatLocal(now, task.tzOffsetMinutes)}${delay >= 60000 ? `（补跑，比计划晚 ${describeDuration(delay)}）` : "（准点）"}`);
  } else {
    lines.push("触发方式：用户在提醒页手动点了「立即跑」");
    lines.push(`触发时刻：${formatLocal(now, task.tzOffsetMinutes)}`);
  }
  lines.push("这次触发由系统按计划自动发起，用户此刻没有打字。请直接完成上面这个任务，把要给用户看的内容作为回复正文；重复规则与时刻已经配置好，不要就这些反问用户。");
  return lines.join("\n");
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
  notify_channel: string | null;
  builtin: string | null;
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
    ...(row.notify_channel !== null ? { notifyChannel: row.notify_channel as "inapp" | "wechat" } : {}),
    ...(row.builtin !== null ? { builtin: row.builtin as BuiltinTaskKind } : {}),
    tzOffsetMinutes: row.tz_offset_minutes,
    createdTs: row.created_ts,
    ...(row.last_run_ts !== null ? { lastRunTs: row.last_run_ts } : {}),
  };
}

/**
 * 内置三件套（2026-09-29 SDD 逾期处理与内置任务）：简报管"今天要干嘛"，晚间汇报管"今天干得怎样"，
 * 周复盘管"这周值不值"。指令文案集中在此便于热改；到点助手可 query_ledger 读当日实况，不是死模板。
 */
const BUILTIN_TASK_DEFS: ReadonlyArray<{
  builtin: BuiltinTaskKind;
  title: string;
  instruction: string;
  trigger: TaskTrigger;
}> = [
  {
    builtin: "daily-brief",
    title: "每日简报",
    instruction:
      "生成今日简报：先用 query_ledger 查 what=today（含 top3），再给出：1) 今日必做三件事与一句话理由；2) 逾期与临近截止的风险；3) 一个今日聚焦建议——从待做计划里挑最值得先动的一件。语气温和，最后提醒可以去 web 端「今天」页看完整视图。",
    trigger: { kind: "daily", time: "08:30" },
  },
  {
    builtin: "daily-report",
    title: "每日晚间汇报",
    instruction:
      "晚间汇报时间。先用 query_ledger 查 what=today，看今天的计划完成情况（已完成/待做/逾期），然后像朋友一样向用户汇报今天的完成度：完成了的给一句具体的肯定；还没做的问一句——是打算今晚补上，还是今天就到这（要跳过哪条说一声，可以帮用户取消）；最后问一句今天有没有想记下来的事（心情、开销、进展都可以），用户回复后照常记入账本。语气平实，不说教。",
    trigger: { kind: "daily", time: "20:00" },
  },
  {
    builtin: "weekly-review",
    title: "每周复盘",
    instruction:
      "每周复盘时间。先用 query_ledger 查 what=today 与 what=plans。today 载荷的计划含近 30 天完成存档（每条带 doneAt 完成时刻），按 doneAt 归类自然周即可得到本周/上周完成数——数字只能来自载荷，数据不足就明说，不要编。给出：1) 本周完成 vs 上周（含仍在逾期与进行中的事项）；2) 一条本周行为观察（可参考本周流水规律）；3) 下周最值得聚焦的一件事及原因。最后问用户下周想重点推进什么——回复可顺势落成新计划。",
    trigger: { kind: "weekly", days: [7], time: "21:00" },
  },
];

/** 内置三件套的模板投影（GET /api/tasks/templates，评审 2026-09-29 #13）：提醒页模板按钮的唯一文案来源，
 *  与 BUILTIN_TASK_DEFS 单源——改指令只改一处，模板按钮不再手抄漂移 */
export function builtinTaskTemplates(): Array<{
  builtin: BuiltinTaskKind;
  title: string;
  instruction: string;
  trigger: TaskTrigger;
  label: string;
}> {
  return BUILTIN_TASK_DEFS.map((def) => ({
    builtin: def.builtin,
    title: def.title,
    instruction: def.instruction,
    trigger: def.trigger,
    label: describeTrigger(def.trigger, 480),
  }));
}

export class TaskStore {  constructor(private deps: TaskStoreDeps) {}

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
      Partial<Pick<TaskDef, "enabled" | "tzOffsetMinutes">> & { id?: string },
  ): Promise<TaskDef> {
    if (input.title.trim() === "" || input.instruction.trim() === "") throw new Error("title/instruction 必填");
    validateTrigger(input.trigger);
    if (input.notifyChannel !== undefined && input.notifyChannel !== "inapp" && input.notifyChannel !== "wechat") {
      throw new Error("notifyChannel 只支持 inapp | wechat");
    }
    if (input.builtin !== undefined && !BUILTIN_TASK_DEFS.some((d) => d.builtin === input.builtin)) {
      throw new Error(`builtin 只支持 ${BUILTIN_TASK_DEFS.map((d) => d.builtin).join(" | ")}`);
    }
    const task: TaskDef = {
      id: input.id ?? this.deps.randomUUID(),
      uid,
      agentId: input.agentId,
      title: input.title.trim(),
      instruction: input.instruction.trim(),
      trigger: input.trigger,
      enabled: input.enabled ?? true,
      ...(input.notifyChannel !== undefined ? { notifyChannel: input.notifyChannel } : {}),
      ...(input.builtin !== undefined ? { builtin: input.builtin } : {}),
      tzOffsetMinutes: input.tzOffsetMinutes ?? 0,
      createdTs: this.deps.now(),
    };
    this.deps.db
      .prepare(
        "INSERT INTO tasks (id, uid, agent_id, title, instruction, trigger_json, enabled, tz_offset_minutes, created_ts, last_run_ts, notify_channel, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(task.id, uid, task.agentId ?? null, task.title, task.instruction, JSON.stringify(task.trigger), task.enabled ? 1 : 0, task.tzOffsetMinutes, task.createdTs, task.notifyChannel ?? null, task.builtin ?? null);
    return task;
  }

  /**
   * 内置三件套种子（2026-09-29）：种子一次性（users.builtins_seeded 标记）——
   * 重复调用幂等；用户删除内置任务后重启不复活（标记已置），提醒页模板按钮可一键重建。
   * 注册路径与进程启动补种共用；tz 默认东八区（单用户自部署，可改）。
   */
  async ensureBuiltins(uid: string): Promise<number> {
    const row = this.deps.db.prepare("SELECT builtins_seeded FROM users WHERE uid = ?").get(uid) as
      | { builtins_seeded: number }
      | undefined;
    if (!row || row.builtins_seeded === 1) return 0;
    for (const def of BUILTIN_TASK_DEFS) {
      // 确定性 id（builtin-{kind}-{uid}）：不依赖注入方 uuid 的唯一性（测试夹具常给固定值），三连插不撞主键
      const id = `builtin-${def.builtin}-${uid}`;
      // 部分种子自愈（评审 2026-09-29）：上次中途失败留下的行直接跳过，重入不撞主键；标记兜底在循环后
      if ((await this.get(uid, id)) !== null) continue;
      await this.create(uid, {
        id,
        title: def.title,
        instruction: def.instruction,
        trigger: def.trigger,
        notifyChannel: "inapp",
        builtin: def.builtin,
        tzOffsetMinutes: 480,
      });
    }
    this.deps.db.prepare("UPDATE users SET builtins_seeded = 1 WHERE uid = ?").run(uid);
    return BUILTIN_TASK_DEFS.length;
  }

  async update(uid: string, id: string, patch: Partial<Pick<TaskDef, "enabled" | "instruction" | "title" | "trigger" | "notifyChannel">>): Promise<TaskDef> {
    const task = await this.get(uid, id);
    if (!task) throw new Error(`task "${id}" 不存在`);
    if (patch.trigger) validateTrigger(patch.trigger);
    if (patch.notifyChannel !== undefined && patch.notifyChannel !== "inapp" && patch.notifyChannel !== "wechat") {
      throw new Error("notifyChannel 只支持 inapp | wechat");
    }
    const next: TaskDef = { ...task, ...patch };
    this.deps.db
      .prepare("UPDATE tasks SET title = ?, instruction = ?, trigger_json = ?, enabled = ?, notify_channel = ? WHERE id = ? AND uid = ?")
      .run(next.title, next.instruction, JSON.stringify(next.trigger), next.enabled ? 1 : 0, next.notifyChannel ?? null, id, uid);
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
  runTask(uid: string, task: TaskDef, run: TaskRunTrigger): Promise<void>;
  now(): number;
  intervalMs?: number;
  logger?(line: string): void;
}

const CATCHUP_WINDOW_MS = 24 * 3600 * 1000;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 重入防护（评审 2026-09-29 pre-existing）：模型回合可超 tick 间隔（last_run_ts 要等 whenIdle 后才写），
   *  上一轮未结束时跳过本轮——慢回合不再二次投递同任务（双通知/双 ran），其他到期任务顺延到下轮 */
  private ticking = false;

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
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<number> {
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
          await this.deps.runTask(uid, task, { kind: "scheduled", due });
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
  /** 用户本地时区偏置（评审 2026-09-29 #17）：agent 建任务的触发时刻按用户钟面解释，缺省取进程本地 */
  tzOffsetMinutes?: number;
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
        notifyChannel: { type: "string", description: "通知渠道：inapp 站内（默认）| wechat 微信机器人（需用户已在 IM 通道页绑定）" },
        trigger: {
          type: "object",
          description: '时刻按用户当地钟面解释（如用户说"明早 8 点"就填 08:00，系统按用户时区调度）。如 {"kind":"daily","time":"23:00"} / {"kind":"weekly","days":[1,3],"time":"08:00"} / {"kind":"interval","every":2,"unit":"day","time":"09:00","startTs":epoch毫秒}（自定义重复，unit: minute|hour|day|week|month|year，minute/hour 不带 time，可选 endTs） / {"kind":"once","at":epoch毫秒} / {"kind":"cron","expr":"0 9 * * *"}',
        },
      },
    },
    output: {
      schema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: `已建定时任务（${(value as { taskId: string }).taskId}）` }],
    },
    async execute(args) {
      const input = (args ?? {}) as { title?: string; instruction?: string; trigger?: TaskTrigger; notifyChannel?: string };
      const task = await deps.store.create(deps.uid, {
        title: String(input.title ?? ""),
        instruction: String(input.instruction ?? ""),
        trigger: input.trigger as TaskTrigger,
        ...(input.notifyChannel === "wechat" || input.notifyChannel === "inapp" ? { notifyChannel: input.notifyChannel } : {}),
        // 触发时刻按用户钟面解释（评审 #17）：会话注入 tz，不再落 UTC 缺省导致"明早 8 点"变 16:30
        tzOffsetMinutes: deps.tzOffsetMinutes ?? -new Date().getTimezoneOffset(),
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
        const tasks = (value as { tasks: { title: string; builtin?: string }[] }).tasks ?? [];
        const text = tasks.length === 0 ? "没有定时任务" : `共 ${tasks.length} 个：${tasks.map((t) => (t.builtin !== undefined ? `${t.title}（内置）` : t.title)).join("；")}`;
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
            ...(t.builtin !== undefined ? { builtin: t.builtin } : {}), // 内置标记（评审 O4）：模型可定位"把内置的简报挪到九点"
            ...(t.agentId !== undefined ? { agentId: t.agentId } : {}),
            ...(t.notifyChannel !== undefined ? { notifyChannel: t.notifyChannel } : {}),
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
        notifyChannel: { type: "string", description: "通知渠道：inapp（默认）| wechat" },
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
      const input = (args ?? {}) as { taskId?: string; enabled?: boolean; title?: string; instruction?: string; trigger?: TaskTrigger; notifyChannel?: string };
      if (typeof input.taskId !== "string" || input.taskId === "") throw new Error("taskId 必填（query_tasks 拿）");
      const patch: Parameters<TaskStore["update"]>[2] = {};
      if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
      if (input.title !== undefined) patch.title = String(input.title);
      if (input.instruction !== undefined) patch.instruction = String(input.instruction);
      if (input.trigger !== undefined) patch.trigger = input.trigger as TaskTrigger;
      if (input.notifyChannel !== undefined) {
        if (input.notifyChannel !== "inapp" && input.notifyChannel !== "wechat") throw new Error("notifyChannel 只支持 inapp | wechat");
        patch.notifyChannel = input.notifyChannel;
      }
      if (Object.keys(patch).length === 0) throw new Error("至少改一项：enabled / title / instruction / trigger / notifyChannel");
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
