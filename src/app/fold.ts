// 今天页确定性折叠（D7：面板 = 账本折叠，0 token、0 模型调用）。
// 时间语义：tzOffsetMinutes = 「UTC 加多少分钟得当地」（如中国 +480；恰为 -new Date().getTimezoneOffset()）。

import type { CheckinRecord, FlowRecord, LedgerAppend, LedgerRecord, PlanRecord } from "./ledger";
export type { LedgerAppend, LedgerRecord } from "./ledger";

const DAY_MS = 86400000;

function localShift(ts: number, tzOffsetMinutes: number): number {
  return ts + tzOffsetMinutes * 60000;
}

function dayKey(ts: number, tzOffsetMinutes: number): number {
  return Math.floor(localShift(ts, tzOffsetMinutes) / DAY_MS);
}

function localParts(ts: number, tzOffsetMinutes: number): { year: number; month: number; date: number; weekday: number } {
  const d = new Date(localShift(ts, tzOffsetMinutes));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(), weekday: d.getUTCDay() };
}

function dateString(parts: { year: number; month: number; date: number }): string {
  const mm = String(parts.month + 1).padStart(2, "0");
  const dd = String(parts.date).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

export interface TodayPlanView {
  planId: string;
  title: string;
  scope: PlanRecord["scope"];
  due?: string;
  done: boolean;
  checkinTs?: number;
}

export interface TodayFlowView {
  seq: number;
  time: number;
  category: string;
  note?: string;
  value?: number;
  unit?: string;
}

export interface TodayView {
  date: string;
  flows: TodayFlowView[];
  plans: TodayPlanView[];
  totalByCategory: { category: string; total: number; count: number }[];
  streakDays: number;
}

/** 计划是否覆盖"今天"：scope 决定周期（创建 ts = 周期锚点） */
export function planScopeCoversToday(plan: PlanRecord, now: number, tzOffsetMinutes: number): boolean {
  const todayKey = dayKey(now, tzOffsetMinutes);
  const createdKey = dayKey(plan.ts, tzOffsetMinutes);
  switch (plan.scope) {
    case "day":
      return createdKey === todayKey;
    case "week": {
      // 当地周一为一周之始：周键 = 该周周一的 dayKey
      const weekStartKey = (key: number, weekday: number) => key - ((weekday + 6) % 7);
      return (
        weekStartKey(createdKey, localParts(plan.ts, tzOffsetMinutes).weekday) ===
        weekStartKey(todayKey, localParts(now, tzOffsetMinutes).weekday)
      );
    }
    case "month": {
      const a = localParts(plan.ts, tzOffsetMinutes);
      const b = localParts(now, tzOffsetMinutes);
      return a.year === b.year && a.month === b.month;
    }
    case "year":
      return localParts(plan.ts, tzOffsetMinutes).year === localParts(now, tzOffsetMinutes).year;
    case "ndays":
      return todayKey - createdKey >= 0 && todayKey - createdKey < Math.max(1, plan.ndays ?? 1);
    case "deadline":
      return typeof plan.due === "string" && plan.due >= dateString(localParts(now, tzOffsetMinutes));
  }
}

export function todayView(records: LedgerRecord[], now: number, tzOffsetMinutes = 0): TodayView {
  const active = records.filter((r) => r.kind !== "void") as Array<FlowRecord | PlanRecord | CheckinRecord>;
  const voidedSeqs = new Set(
    records.filter((r): r is Extract<LedgerRecord, { kind: "void" }> => r.kind === "void").map((r) => r.targetSeq),
  );
  const live = active.filter((r) => !voidedSeqs.has(r.seq));

  const todayK = dayKey(now, tzOffsetMinutes);
  const isToday = (ts: number) => dayKey(ts, tzOffsetMinutes) === todayK;

  const flows = live
    .filter((r): r is FlowRecord => r.kind === "event" && isToday(r.time))
    .sort((a, b) => a.time - b.time || a.seq - b.seq)
    .map(({ seq, time, category, note, value, unit }) => ({ seq, time, category, ...(note !== undefined ? { note } : {}), ...(value !== undefined ? { value } : {}), ...(unit !== undefined ? { unit } : {}) }));

  const checkinsToday = live.filter((r): r is CheckinRecord => r.kind === "checkin" && r.done && isToday(r.at));
  const plans = live
    .filter((r): r is PlanRecord => r.kind === "plan" && planScopeCoversToday(r, now, tzOffsetMinutes))
    .sort((a, b) => a.seq - b.seq)
    .map((plan) => {
      const done = checkinsToday.filter((c) => c.planId === plan.planId).sort((a, b) => b.at - a.at)[0];
      return {
        planId: plan.planId,
        title: plan.title,
        scope: plan.scope,
        ...(plan.due !== undefined ? { due: plan.due } : {}),
        done: Boolean(done),
        ...(done ? { checkinTs: done.at } : {}),
      };
    });

  const totals = new Map<string, { total: number; count: number }>();
  for (const flow of live) {
    if (flow.kind !== "event" || !isToday(flow.time)) continue;
    const entry = totals.get(flow.category) ?? { total: 0, count: 0 };
    entry.total += flow.value ?? 0;
    entry.count += 1;
    totals.set(flow.category, entry);
  }
  const totalByCategory = [...totals.entries()]
    .map(([category, { total, count }]) => ({ category, total, count }))
    .sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : 1));

  // streak：连续有流水的自然日数；今天还没记则从昨天起算（streak 活到明天），昨天也没有即断
  const daysWithFlow = new Set<number>();
  for (const r of live) {
    if (r.kind === "event") daysWithFlow.add(dayKey(r.time, tzOffsetMinutes));
  }
  let streakDays = 0;
  let cursor = daysWithFlow.has(todayK) ? todayK : todayK - 1;
  while (daysWithFlow.has(cursor)) {
    streakDays += 1;
    cursor -= 1;
  }

  return { date: dateString(localParts(now, tzOffsetMinutes)), flows, plans, totalByCategory, streakDays };
}

// ── 批次 4：分类页与进步页（D7.2 / D11.3，全部确定性折叠） ──────────────

function activeFlows(records: LedgerRecord[]): FlowRecord[] {
  const voided = new Set(
    records.filter((r): r is Extract<LedgerRecord, { kind: "void" }> => r.kind === "void").map((r) => r.targetSeq),
  );
  return records.filter(
    (r): r is FlowRecord => r.kind === "event" && !voided.has(r.seq),
  );
}

function localDayStart(now: number, tz: number): number {
  const k = dayKey(now, tz);
  return k * DAY_MS - tz * 60000;
}

function weekStart(now: number, tz: number): number {
  const { weekday } = localParts(now, tz);
  return localDayStart(now, tz) - ((weekday + 6) % 7) * DAY_MS;
}

export interface CategoryStat {
  category: string;
  lastTs: number;
  count: number;
}

/** 分类即维度：目录从实际记过的流水动态长出；归档分类剔除 */
export function listCategories(records: LedgerRecord[], archived: string[]): CategoryStat[] {
  const byCategory = new Map<string, CategoryStat>();
  for (const flow of activeFlows(records)) {
    const stat = byCategory.get(flow.category) ?? { category: flow.category, lastTs: 0, count: 0 };
    stat.lastTs = Math.max(stat.lastTs, flow.time);
    stat.count += 1;
    byCategory.set(flow.category, stat);
  }
  return [...byCategory.values()]
    .filter((stat) => !archived.includes(stat.category))
    .sort((a, b) => b.lastTs - a.lastTs);
}

export interface CategoryPeriodView {
  period: "today" | "week" | "month" | "year";
  category: string;
  count: number;
  total: number;
  /** 近 30 天（本地日）序列，缺日补零——趋势/热力图共用 */
  daily: { date: string; count: number; total: number }[];
  /** 周期内明细（时间倒序，封顶 200） */
  flows: TodayFlowView[];
}

export function categoryView(
  records: LedgerRecord[],
  input: { category: string; period: CategoryPeriodView["period"]; now: number; tzOffsetMinutes: number },
): CategoryPeriodView {
  const { category, period, now } = input;
  const tz = input.tzOffsetMinutes;
  let start: number;
  if (period === "today") start = localDayStart(now, tz);
  else if (period === "week") start = weekStart(now, tz);
  else if (period === "month") {
    const p = localParts(now, tz);
    start = Date.UTC(p.year, p.month, 1) - tz * 60000;
  } else {
    const p = localParts(now, tz);
    start = Date.UTC(p.year, 0, 1) - tz * 60000;
  }

  const inPeriod = activeFlows(records).filter((f) => f.category === category && f.time >= start && f.time < now + DAY_MS);
  const count = inPeriod.length;
  const total = inPeriod.reduce((sum, f) => sum + (f.value ?? 0), 0);

  const daily: { date: string; count: number; total: number }[] = [];
  const todayK = dayKey(now, tz);
  for (let back = 29; back >= 0; back -= 1) {
    const k = todayK - back;
    const date = dateString(localParts(k * DAY_MS, tz));
    const dayFlows = inPeriod.filter((f) => dayKey(f.time, tz) === k);
    daily.push({ date, count: dayFlows.length, total: dayFlows.reduce((sum, f) => sum + (f.value ?? 0), 0) });
  }

  const flows = inPeriod
    .sort((a, b) => b.time - a.time || b.seq - a.seq)
    .slice(0, 200)
    .map(({ seq, time, category: c, note, value, unit }) => ({
      seq, time, category: c,
      ...(note !== undefined ? { note } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(unit !== undefined ? { unit } : {}),
    }));

  return { period, category, count, total, daily, flows };
}

export interface ProgressView {
  streakDays: number;
  /** 当前覆盖（scope 覆盖今天）计划完成率 */
  completion: { done: number; total: number; rate: number };
  /** 分类周环比：本周活跃分类 vs 上周（笔数；上周为 0 → deltaPct null） */
  weekOverWeek: { category: string; thisWeek: number; lastWeek: number; deltaPct: number | null }[];
  /** 近 14 天（本地日）全分类流水笔数 */
  trend14: { date: string; count: number }[];
}

export function progressView(records: LedgerRecord[], now: number, tzOffsetMinutes: number): ProgressView {
  const tz = tzOffsetMinutes;
  const flows = activeFlows(records);
  const todayK = dayKey(now, tz);

  // 连续（同 todayView 语义）
  const daysWithFlow = new Set(flows.map((f) => dayKey(f.time, tz)));
  let streakDays = 0;
  let cursor = daysWithFlow.has(todayK) ? todayK : todayK - 1;
  while (daysWithFlow.has(cursor)) {
    streakDays += 1;
    cursor -= 1;
  }

  // 完成率：覆盖今天的活跃计划 + 今天 done 打卡
  const voided = new Set(records.filter((r) => r.kind === "void").map((r) => (r as Extract<LedgerRecord, { kind: "void" }>).targetSeq));
  const live = records.filter((r) => r.kind !== "void" && !voided.has(r.seq));
  const plans = live.filter((r): r is PlanRecord => r.kind === "plan" && planScopeCoversToday(r, now, tz));
  const checkins = live.filter((r): r is CheckinRecord => r.kind === "checkin" && r.done && dayKey(r.at, tz) === todayK);
  const done = plans.filter((p) => checkins.some((c) => c.planId === p.planId)).length;
  const completion = { done, total: plans.length, rate: plans.length === 0 ? 0 : done / plans.length };

  // 周环比
  const weekStartTs = weekStart(now, tz);
  const lastWeekStartTs = weekStartTs - 7 * DAY_MS;
  const thisWeekFlows = flows.filter((f) => f.time >= weekStartTs);
  const categories = new Set(thisWeekFlows.map((f) => f.category));
  const weekOverWeek = [...categories].map((category) => {
    const thisWeek = thisWeekFlows.filter((f) => f.category === category).length;
    const lastWeek = flows.filter((f) => f.category === category && f.time >= lastWeekStartTs && f.time < weekStartTs).length;
    const deltaPct = lastWeek === 0 ? null : Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
    return { category, thisWeek, lastWeek, deltaPct };
  }).sort((a, b) => b.thisWeek - a.thisWeek);

  // 近 14 天趋势
  const trend14: { date: string; count: number }[] = [];
  for (let back = 13; back >= 0; back -= 1) {
    const k = todayK - back;
    trend14.push({
      date: dateString(localParts(k * DAY_MS, tz)),
      count: flows.filter((f) => dayKey(f.time, tz) === k).length,
    });
  }

  return { streakDays, completion, weekOverWeek, trend14 };
}
