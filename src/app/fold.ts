// 今天页确定性折叠（D7：面板 = 账本折叠，0 token、0 模型调用）。
// 时间语义：tzOffsetMinutes = 「UTC 加多少分钟得当地」（如中国 +480；恰为 -new Date().getTimezoneOffset()）。

import type { CheckinRecord, FlowRecord, LedgerRecord, PlanRecord } from "./ledger";

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
