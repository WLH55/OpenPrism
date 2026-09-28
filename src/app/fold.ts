// 今天页确定性折叠（D7：面板 = 账本折叠，0 token、0 模型调用）。
// 时间语义：tzOffsetMinutes = 「UTC 加多少分钟得当地」（如中国 +480；恰为 -new Date().getTimezoneOffset()）。

import type { CheckinRecord, FlowRecord, GoalRecord, LedgerAppend, LedgerRecord, PlanRecord } from "./ledger";
import { latestGoalSnapshots } from "./goals";
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
  /** 今日必做（确定性折叠，无模型依赖）：逾期 > 今日截止 > 覆盖今天的未完成 > 阶段第一条未完成打卡点补位（可打卡；存量 nextStep 文字兜底） */
  top3: TopItem[];
  /** 计划卡：3 方向 + 3 阶段 + 软约束提示（B1）；阶段 nextStep = 其第一条未完成打卡点标题 */
  goalCard: {
    directions: { goalId: string; title: string; progress: GoalNode["progress"]; updatedAt: number }[];
    phases: { goalId: string; title: string; due?: string; nextStep?: string }[];
    warning?: string;
  };
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

  // B1：Top3 + 计划卡（同源 records 重复折叠，个人量级毫秒级；goalView/top3 为函数声明，前置调用安全）
  const goals = goalView(records, now, tzOffsetMinutes);
  const goalCard = {
    directions: goals.directions
      .filter((d) => d.status === "active")
      .slice(0, 3)
      .map(({ goalId, title, progress, updatedAt }) => ({ goalId, title, progress, updatedAt })),
    phases: (() => {
      const all: GoalNode[] = [];
      const collect = (nodes: GoalNode[]): void => {
        for (const node of nodes) {
          if (node.level === "phase") all.push(node);
          collect(node.children);
        }
      };
      collect(goals.directions);
      // 下一步 = 该阶段第一条未完成打卡点（与 Top3 补位同源；旧 nextStep 文字不再是来源，转打卡点后自动衔接）
      const firstUnchecked = firstUncheckedMilestoneByGoal(live, liveDoneEver(live));
      return all
        .filter((p) => p.status === "active")
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.goalId < b.goalId ? -1 : 1))
        .slice(0, 3)
        .map(({ goalId, title, due }) => {
          const next = firstUnchecked.get(goalId);
          return { goalId, title, ...(due !== undefined ? { due } : {}), ...(next !== undefined ? { nextStep: next.title } : {}) };
        });
    })(),
    ...(goals.warning !== undefined ? { warning: goals.warning } : {}),
  };
  const topItems = top3(records, now, tzOffsetMinutes);

  return { date: dateString(localParts(now, tzOffsetMinutes)), flows, plans, totalByCategory, streakDays, top3: topItems, goalCard };
}

// ── B1：目标层级折叠（2026-09-28，SDD 个人工作台业务借鉴 §4）──────────────
// goal 语义：同 goalId 多条快照，未 void 的最新一条胜出（修订 = 追加，不消耗 void）；
// 里程碑 = 挂目标树的 deadline 型 plan（done = 曾有 done 打卡）；
// 周期计划今日执行 = planScopeCoversToday && 今日有 done（与 todayView 打卡口径一致）；
// 数量约束是软的：折叠层只给 warning，不 block（agent/UI 呈现层负责"3 的剧场"）。

/** 剔除 void 目标与 void 本身（goalView/top3 共用；与 todayView 同语义） */
function liveRecords(records: LedgerRecord[]): Array<FlowRecord | PlanRecord | CheckinRecord | GoalRecord> {
  const voided = new Set(
    records.filter((r): r is Extract<LedgerRecord, { kind: "void" }> => r.kind === "void").map((r) => r.targetSeq),
  );
  return records.filter((r) => r.kind !== "void" && !voided.has(r.seq)) as Array<
    FlowRecord | PlanRecord | CheckinRecord | GoalRecord
  >;
}

export interface GoalNode {
  goalId: string;
  level: GoalRecord["level"];
  title: string;
  status: GoalRecord["status"];
  parentId?: string;
  why?: string;
  outcome?: string;
  metric?: string;
  due?: string;
  nextStep?: string;
  /** 当前快照的 ts */
  updatedAt: number;
  children: GoalNode[];
  /** 子树里程碑进度（deadline 型 plan） */
  progress: { done: number; total: number; rate: number };
  /** 子树周期计划今日执行（覆盖今天 && 今日 done） */
  recurring: { doneToday: number; total: number };
}

export interface GoalView {
  /** 顶层树（direction 为正常根；孤儿/成环节点上提为根保证可见） */
  directions: GoalNode[];
  activeDirectionCount: number;
  activePhaseCount: number;
  /** 软约束提醒（active 方向或阶段 > 3 时给出，不 block） */
  warning?: string;
}

/** 存活 done 打卡的 planId 集合（doneEver 语义：打过一次就算）——top3/goalCard 共用 */
function liveDoneEver(live: LedgerRecord[]): Set<string> {
  const set = new Set<string>();
  for (const r of live) {
    if (r.kind === "checkin" && r.done) set.add(r.planId);
  }
  return set;
}

/** 各 goalId 名下第一条未完成打卡点（deadline 型 plan，按 due 升序）——「下一步」的统一来源（2026-09-28 统一执行项） */
function firstUncheckedMilestoneByGoal(live: LedgerRecord[], doneEver: Set<string>): Map<string, PlanRecord> {
  const map = new Map<string, PlanRecord>();
  for (const r of live) {
    if (r.kind !== "plan" || r.scope !== "deadline" || r.goalId === undefined || doneEver.has(r.planId)) continue;
    const cur = map.get(r.goalId);
    if (cur === undefined || (r.due ?? "9999") < (cur.due ?? "9999")) map.set(r.goalId, r);
  }
  return map;
}

export function goalView(records: LedgerRecord[], now: number, tzOffsetMinutes: number): GoalView {
  const live = liveRecords(records);
  const latest = latestGoalSnapshots(records);

  const todayK = dayKey(now, tzOffsetMinutes);
  const doneEver = new Set<string>();
  const doneToday = new Set<string>();
  for (const r of live) {
    if (r.kind !== "checkin" || !r.done) continue;
    doneEver.add(r.planId);
    if (dayKey(r.at, tzOffsetMinutes) === todayK) doneToday.add(r.planId);
  }

  const nodes = new Map<string, GoalNode>();
  for (const g of latest.values()) {
    nodes.set(g.goalId, {
      goalId: g.goalId,
      level: g.level,
      title: g.title,
      status: g.status,
      ...(g.parentId !== undefined ? { parentId: g.parentId } : {}),
      ...(g.why !== undefined ? { why: g.why } : {}),
      ...(g.outcome !== undefined ? { outcome: g.outcome } : {}),
      ...(g.metric !== undefined ? { metric: g.metric } : {}),
      ...(g.due !== undefined ? { due: g.due } : {}),
      ...(g.nextStep !== undefined ? { nextStep: g.nextStep } : {}),
      updatedAt: g.ts,
      children: [],
      progress: { done: 0, total: 0, rate: 0 },
      recurring: { doneToday: 0, total: 0 },
    });
  }

  // plan 归属到直接节点（孤儿引用宽容跳过——完整性由 B2 工具校验兜底）
  const own = new Map<string, { progress: { done: number; total: number }; recurring: { doneToday: number; total: number } }>();
  for (const r of live) {
    if (r.kind !== "plan" || r.goalId === undefined || !nodes.has(r.goalId)) continue;
    const slot = own.get(r.goalId) ?? { progress: { done: 0, total: 0 }, recurring: { doneToday: 0, total: 0 } };
    if (r.scope === "deadline") {
      slot.progress.total += 1;
      if (doneEver.has(r.planId)) slot.progress.done += 1;
    } else if (planScopeCoversToday(r, now, tzOffsetMinutes)) {
      slot.recurring.total += 1;
      if (doneToday.has(r.planId)) slot.recurring.doneToday += 1;
    }
    own.set(r.goalId, slot);
  }

  // 组树：挂直接 parent；parent 缺失或成环 → 上提为根（防 agg 无限递归）
  const roots: GoalNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.parentId;
    const parent = parentId !== undefined ? nodes.get(parentId) : undefined;
    let cyclic = false;
    if (parent !== undefined) {
      const seen = new Set([node.goalId]);
      let cur: GoalNode | undefined = parent;
      while (cur !== undefined) {
        if (seen.has(cur.goalId)) {
          cyclic = true;
          break;
        }
        seen.add(cur.goalId);
        cur = cur.parentId !== undefined ? nodes.get(cur.parentId) : undefined;
      }
    }
    if (parent !== undefined && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  const byUpdated = (a: GoalNode, b: GoalNode) => a.updatedAt - b.updatedAt || (a.goalId < b.goalId ? -1 : 1);
  roots.sort(byUpdated);
  for (const node of nodes.values()) node.children.sort(byUpdated);

  // 自底向上冒泡：根上的 progress/recurring = 自身 + 全部子孙
  const aggregate = (node: GoalNode): { d: number; t: number; rd: number; rt: number } => {
    const o = own.get(node.goalId) ?? { progress: { done: 0, total: 0 }, recurring: { doneToday: 0, total: 0 } };
    let d = o.progress.done;
    let t = o.progress.total;
    let rd = o.recurring.doneToday;
    let rt = o.recurring.total;
    for (const child of node.children) {
      const s = aggregate(child);
      d += s.d;
      t += s.t;
      rd += s.rd;
      rt += s.rt;
    }
    node.progress = { done: d, total: t, rate: t === 0 ? 0 : d / t };
    node.recurring = { doneToday: rd, total: rt };
    return { d, t, rd, rt };
  };
  roots.forEach(aggregate);

  let activeDirectionCount = 0;
  let activePhaseCount = 0;
  for (const g of latest.values()) {
    if (g.status !== "active") continue;
    if (g.level === "direction") activeDirectionCount += 1;
    else if (g.level === "phase") activePhaseCount += 1;
  }
  let warning: string | undefined;
  if (activeDirectionCount > 3) warning = `同时推进 ${activeDirectionCount} 个方向，注意力容易稀释——考虑先聚焦 3 个以内`;
  else if (activePhaseCount > 3) warning = `同时推进 ${activePhaseCount} 个阶段计划，节奏可能太满——考虑先聚焦 3 个以内`;

  return { directions: roots, activeDirectionCount, activePhaseCount, ...(warning !== undefined ? { warning } : {}) };
}

export interface TopItem {
  kind: "overdue" | "dueToday" | "today" | "nextStep";
  title: string;
  planId?: string;
  due?: string;
  /** 归属链顶层目标的标题（无归属则无） */
  goalTitle?: string;
}

/** 今日必做 Top3（确定性，0 模型）：逾期 > 今日截止 > 覆盖今天的未完成；不足 3 用 active 阶段第一条未完成打卡点补位 */
export function top3(records: LedgerRecord[], now: number, tzOffsetMinutes: number): TopItem[] {
  const live = liveRecords(records);
  const todayStr = dateString(localParts(now, tzOffsetMinutes));
  const todayK = dayKey(now, tzOffsetMinutes);
  const doneEver = liveDoneEver(live);
  const doneToday = new Set<string>();
  for (const r of live) {
    if (r.kind !== "checkin" || !r.done) continue;
    if (dayKey(r.at, tzOffsetMinutes) === todayK) doneToday.add(r.planId);
  }

  // 归属链顶层标题（seen 防环）
  const latest = latestGoalSnapshots(records);
  const topTitleOf = (goalId: string): string | undefined => {
    const seen = new Set<string>();
    let cur = latest.get(goalId);
    while (cur !== undefined && !seen.has(cur.goalId)) {
      seen.add(cur.goalId);
      const up = cur.parentId !== undefined ? latest.get(cur.parentId) : undefined;
      if (up === undefined) return cur.title;
      cur = up;
    }
    return undefined;
  };
  const itemFor = (plan: PlanRecord, kind: TopItem["kind"]): TopItem => {
    const goalTitle = plan.goalId !== undefined ? topTitleOf(plan.goalId) : undefined;
    return {
      kind,
      title: plan.title,
      planId: plan.planId,
      ...(plan.due !== undefined ? { due: plan.due } : {}),
      ...(goalTitle !== undefined ? { goalTitle } : {}),
    };
  };

  const overdue: TopItem[] = [];
  const dueToday: TopItem[] = [];
  const todayItems: TopItem[] = [];
  for (const r of live) {
    if (r.kind !== "plan") continue;
    if (r.scope === "deadline") {
      if (doneEver.has(r.planId) || r.due === undefined) continue; // 里程碑已完成/无 due 不进
      if (r.due < todayStr) overdue.push(itemFor(r, "overdue"));
      else if (r.due === todayStr && !doneToday.has(r.planId)) dueToday.push(itemFor(r, "dueToday"));
      continue;
    }
    if (planScopeCoversToday(r, now, tzOffsetMinutes) && !doneToday.has(r.planId)) todayItems.push(itemFor(r, "today"));
  }

  const items = [...overdue, ...dueToday, ...todayItems].slice(0, 3);
  if (items.length < 3) {
    // 下一步补位（2026-09-28 统一执行项）：active 阶段的第一条未完成打卡点（带 planId，今天页可直接打卡）；
    // 存量阶段还挂着旧 nextStep 文字（未转打卡点）的兜底显示——不可打卡，计划页有"转为打卡点"入口
    const taken = new Set(items.map((i) => i.planId));
    const firstUnchecked = firstUncheckedMilestoneByGoal(live, doneEver);
    const phases = [...latest.values()]
      .filter((g) => g.level === "phase" && g.status === "active")
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.goalId < b.goalId ? -1 : 1));
    for (const phase of phases) {
      if (items.length >= 3) break;
      const first = firstUnchecked.get(phase.goalId);
      if (first !== undefined && !taken.has(first.planId)) {
        items.push(itemFor(first, "nextStep"));
        taken.add(first.planId);
        continue;
      }
      if (phase.nextStep !== undefined && phase.nextStep !== "") {
        const goalTitle = phase.parentId !== undefined ? topTitleOf(phase.parentId) : undefined;
        items.push({
          kind: "nextStep",
          title: `推进「${phase.title}」：${phase.nextStep}`,
          ...(phase.due !== undefined ? { due: phase.due } : {}),
          ...(goalTitle !== undefined ? { goalTitle } : {}),
        });
      }
    }
  }
  return items;
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
  /** B4（2026-09-28）：上一同长周期对照（归因句与基准的数据源） */
  lastPeriod: { count: number; total: number };
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

  // B4：上一同长周期对照（today=昨天、week=上周、month=上月、year=去年）
  const lastStart = (() => {
    if (period === "week") return weekStart(now - 7 * DAY_MS, tz);
    if (period === "month") {
      const p = localParts(now, tz);
      return p.month === 0 ? Date.UTC(p.year - 1, 11, 1) - tz * 60000 : Date.UTC(p.year, p.month - 1, 1) - tz * 60000;
    }
    if (period === "year") {
      const p = localParts(now, tz);
      return Date.UTC(p.year - 1, 0, 1) - tz * 60000;
    }
    return start - DAY_MS; // today → 昨天
  })();
  const lastPeriodFlows = activeFlows(records).filter((f) => f.category === category && f.time >= lastStart && f.time < start);
  const lastPeriod = { count: lastPeriodFlows.length, total: lastPeriodFlows.reduce((sum, f) => sum + (f.value ?? 0), 0) };

  return { period, category, count, total, daily, flows, lastPeriod };
}

export interface ProgressView {
  streakDays: number;
  /** 当前覆盖（scope 覆盖今天）计划完成率 */
  completion: { done: number; total: number; rate: number };
  /** 分类周环比：本周活跃分类 vs 上周（笔数；上周为 0 → deltaPct null） */
  weekOverWeek: { category: string; thisWeek: number; lastWeek: number; deltaPct: number | null }[];
  /** 近 14 天（本地日）全分类流水笔数 */
  trend14: { date: string; count: number }[];
  /** B4（2026-09-28）：基准锚点——图表有用判据②参照系 */
  /** 历史最长连续记录天数（streakDays 配它才有"追平纪录"的参照） */
  bestStreak: number;
  /** 近 8 周 done 打卡数（周均基准；weekStart = 该周周一 YYYY-MM-DD） */
  weeklyDone8w: { weekStart: string; done: number }[];
  /** B4：行为模式原料（元认知；结论句见 insights） */
  /** 记录时段分布：morning 05-11 / afternoon 11-17 / evening 17-23 / night 23-05（本地时） */
  hourBuckets: { morning: number; afternoon: number; evening: number; night: number };
  /** 记录最多的分类 */
  topCategory: { category: string; count: number } | null;
  /** 作废（更正）过的流水笔数 */
  voidedFlows: number;
  /** 行为模式结论句（有信号才生成；空数组 = 数据还太少） */
  insights: string[];
}

export function progressView(records: LedgerRecord[], now: number, tzOffsetMinutes: number): ProgressView {
  const tz = tzOffsetMinutes;
  const flows = activeFlows(records);
  const todayK = dayKey(now, tz);

  // 连续（同 todayView 语义）+ 历史最长（B4 基准锚点）
  const daysWithFlow = new Set(flows.map((f) => dayKey(f.time, tz)));
  let streakDays = 0;
  let cursor = daysWithFlow.has(todayK) ? todayK : todayK - 1;
  while (daysWithFlow.has(cursor)) {
    streakDays += 1;
    cursor -= 1;
  }
  let bestStreak = 0;
  let run = 0;
  let prevK: number | null = null;
  for (const k of [...daysWithFlow].sort((a, b) => a - b)) {
    run = prevK !== null && k === prevK + 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prevK = k;
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

  // ── B4：基准量与行为模式（确定性折叠，0 模型） ──
  // 近 8 周 done 打卡数
  const allDoneCheckins = live.filter((r): r is CheckinRecord => r.kind === "checkin" && r.done);
  const weeklyDone8w: { weekStart: string; done: number }[] = [];
  for (let back = 7; back >= 0; back -= 1) {
    const ws = weekStartTs - back * 7 * DAY_MS;
    const we = ws + 7 * DAY_MS;
    weeklyDone8w.push({
      weekStart: dateString(localParts(ws, tz)),
      done: allDoneCheckins.filter((c) => c.at >= ws && c.at < we).length,
    });
  }

  // 时段分布 / 最活跃分类 / 更正频率
  const hourBuckets = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const f of flows) {
    const hour = new Date(localShift(f.time, tz)).getUTCHours(); // localShift 后按 UTC 读 = 本地时
    if (hour >= 5 && hour < 11) hourBuckets.morning += 1;
    else if (hour >= 11 && hour < 17) hourBuckets.afternoon += 1;
    else if (hour >= 17 && hour < 23) hourBuckets.evening += 1;
    else hourBuckets.night += 1;
  }
  const categoryCount = new Map<string, number>();
  for (const f of flows) categoryCount.set(f.category, (categoryCount.get(f.category) ?? 0) + 1);
  let topCategory: ProgressView["topCategory"] = null;
  for (const [category, count] of categoryCount) {
    if (topCategory === null || count > topCategory.count) topCategory = { category, count };
  }
  const eventSeqs = new Set(records.filter((r) => r.kind === "event").map((r) => r.seq));
  const voidedFlows = records.filter((r) => r.kind === "void" && eventSeqs.has(r.targetSeq)).length;

  // 结论句：有信号才生成（数据太少不出声）
  const insights: string[] = [];
  const bucketTotal = hourBuckets.morning + hourBuckets.afternoon + hourBuckets.evening + hourBuckets.night;
  if (bucketTotal >= 10) {
    const entries = [
      ["morning", "早上 5—11 点", hourBuckets.morning],
      ["afternoon", "白天 11—17 点", hourBuckets.afternoon],
      ["evening", "傍晚 17—23 点", hourBuckets.evening],
      ["night", "深夜 23—5 点", hourBuckets.night],
    ] as const;
    const top = entries.reduce((a, b) => (b[2] > a[2] ? b : a));
    if (top[2] / bucketTotal >= 0.5) insights.push(`你的记录 ${Math.round((top[2] / bucketTotal) * 100)}% 发生在${top[1]}——留意这个时段是不是你的黄金时间`);
  }
  if (topCategory !== null && topCategory.count >= 5) insights.push(`「${topCategory.category}」是你记录最多的分类（${topCategory.count} 笔）`);
  if (voidedFlows >= 5) insights.push(`你更正过 ${voidedFlows} 笔记录——犯错正常，账本都留了痕`);
  if (bestStreak > streakDays && streakDays >= 1) insights.push(`当前连续 ${streakDays} 天，历史最长 ${bestStreak} 天——再坚持 ${bestStreak - streakDays} 天追平纪录`);
  else if (bestStreak > 0 && streakDays === bestStreak && streakDays >= 2) insights.push(`当前连续 ${streakDays} 天，已追平历史最长纪录`);
  // 周均对照只比完整周：[7] 是进行中的本周（前半周必然偏低），[6] 才是上一个完整周
  const lastWeek = weeklyDone8w[6]!.done;
  const prior = weeklyDone8w.slice(0, 6);
  const priorDone = prior.reduce((sum, w) => sum + w.done, 0);
  if (priorDone > 0) {
    const priorAvg = priorDone / prior.length;
    const deltaPct = Math.round(((lastWeek - priorAvg) / priorAvg) * 100);
    if (deltaPct >= 20) insights.push(`上周完成打卡 ${lastWeek} 次，比前 6 周均值高 ${deltaPct}%——节奏在变好`);
    else if (deltaPct <= -20) insights.push(`上周完成打卡 ${lastWeek} 次，比前 6 周均值低 ${Math.abs(deltaPct)}%——承诺可能超过精力了`);
  }

  return { streakDays, completion, weekOverWeek, trend14, bestStreak, weeklyDone8w, hourBuckets, topCategory, voidedFlows, insights };
}
