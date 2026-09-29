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
  /**
   * 确定性状态（2026-09-28 用户验收：计划要能区分进行中/未开始/已过期/已完成）：
   * deadline 型看 doneEver + due 与今天的关系；周期型看今日打卡 + 本周期内有无历史打卡。
   */
  state: PlanState;
  /** 当前可撤销的打卡 seq（2026-09-29 语义统一，与产出逻辑对齐）：deadline 型完成 = 全部存活 done 打卡；
   * 周期型今日 done = 今日存活打卡——作废即回退，追加 done:false 无效 */
  doneSeqs?: number[];
  /** 最近 10 条存活 done 打卡（倒序，含非今日，at 定位是哪天打的）——撤历史卡的凭据（2026-09-29） */
  checkins?: { seq: number; at: number }[];
  /** 账本 seq：逾期「跳过」= 作废该 plan 记录（2026-09-29） */
  seq: number;
  /** 完成时刻 = 最新存活 done 打卡的 at（2026-09-29）：已完成视图按它倒序/过滤近 30 天 */
  doneAt?: number;
  /** 今天完成的确定性标记（评审 2026-09-29 #14）：周期型=今日打过卡；deadline 型=最新完成打卡在今天。
   * 与 done 的区别：deadline 的 done=doneEver（上周完成的打卡点 done=true 但 doneToday=false），模型/前端按它归因"今天的完成度" */
  doneToday: boolean;
}

export type PlanState = "overdue" | "dueToday" | "doing" | "todo" | "upcoming" | "done";

/** 今天页计划的展示顺序：逾期 > 今天截止 > 进行中/待做 > 未开始（未来） > 已完成 */
const STATE_RANK: Record<PlanState, number> = { overdue: 0, dueToday: 1, doing: 2, todo: 3, upcoming: 4, done: 5 };

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
  /** 今日必做（确定性折叠，无模型依赖）：逾期 > 今日截止 > 覆盖今天的未完成（2026-09-30 目标层级下线，去掉里程碑补位终端） */
  top3: TopItem[];
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
  // doneEver（打过一次就算）+ 存活 done 打卡 seq + 最新完成时刻 + 最近打卡凭据：deadline 型的完成判定/撤销/完成视图排序同源
  const doneEver = new Set<string>();
  const doneSeqsByPlan = new Map<string, number[]>();
  const lastDoneAt = new Map<string, number>();
  const checkinsByPlan = new Map<string, { seq: number; at: number }[]>();
  for (const r of live) {
    if (r.kind !== "checkin" || !r.done) continue;
    doneEver.add(r.planId);
    const list = doneSeqsByPlan.get(r.planId) ?? [];
    list.push(r.seq);
    doneSeqsByPlan.set(r.planId, list);
    const pairs = checkinsByPlan.get(r.planId) ?? [];
    pairs.push({ seq: r.seq, at: r.at });
    checkinsByPlan.set(r.planId, pairs);
    lastDoneAt.set(r.planId, Math.max(lastDoneAt.get(r.planId) ?? 0, r.at));
  }
  const todayStr = dateString(localParts(now, tzOffsetMinutes));
  // 周期计划"本周期内"是否已有打卡（不含今天）——区分 待做 / 进行中
  const periodHasCheckin = (plan: PlanRecord): boolean =>
    live.some((r) => r.kind === "checkin" && r.done && r.planId === plan.planId && planScopeCoversToday(plan, r.at, tzOffsetMinutes) && !isToday(r.at));
  const stateOf = (plan: PlanRecord, doneToday: boolean): PlanState => {
    if (plan.scope === "deadline") {
      if (doneEver.has(plan.planId)) return "done";
      if (plan.due !== undefined && plan.due < todayStr) return "overdue";
      if (plan.due === todayStr) return "dueToday";
      return "upcoming";
    }
    if (doneToday) return "done";
    return periodHasCheckin(plan) ? "doing" : "todo";
  };
  // 列表成员（2026-09-29 B4 全量收编）：覆盖今天的周期计划 + 全部 deadline（含已完成且 due 已过的——
  // 「已完成」视图要看存档；默认视图的防刷屏改由前端按范围切换过滤，数据一次载荷）
  const plans = live
    .filter((r): r is PlanRecord => r.kind === "plan" && (r.scope === "deadline" || planScopeCoversToday(r, now, tzOffsetMinutes)))
    .map((plan) => {
      const doneToday = plan.scope === "deadline" ? doneEver.has(plan.planId) : checkinsToday.some((c) => c.planId === plan.planId);
      const last = checkinsToday.filter((c) => c.planId === plan.planId).sort((a, b) => b.at - a.at)[0];
      const state = stateOf(plan, doneToday);
      const lastDone = lastDoneAt.get(plan.planId);
      // "今天完成"的确定性口径：周期型=state done（即今日有卡）；deadline 型=最新完成打卡落在今天
      const doneTodayFlag = plan.scope === "deadline" ? lastDone !== undefined && dayKey(lastDone, tzOffsetMinutes) === todayK : doneToday;
      return {
        planId: plan.planId,
        title: plan.title,
        scope: plan.scope,
        ...(plan.due !== undefined ? { due: plan.due } : {}),
        done: doneToday,
        ...(last !== undefined ? { checkinTs: last.at } : {}),
        state,
        // 撤销口径（评审 2026-09-29 簇 A）：done 项都给可作废的打卡 seq——deadline 型=全部存活 done 打卡（doneEver），
        // 周期型=今日存活 done 打卡（撤销只退今天，不动历史）；追加 done:false 对两者都无效（CONTEXT.md 语义）
        ...(state === "done"
          ? {
              doneSeqs:
                plan.scope === "deadline"
                  ? (doneSeqsByPlan.get(plan.planId) ?? [])
                  : checkinsToday.filter((c) => c.planId === plan.planId).map((c) => c.seq),
            }
          : {}),
        // 撤历史卡凭据：最近 10 条存活 done 打卡倒序（含非今日；at 相同按后打的在前）
        ...((checkinsByPlan.get(plan.planId) ?? []).length > 0
          ? {
              checkins: [...(checkinsByPlan.get(plan.planId) ?? [])]
                .sort((a, b) => b.at - a.at || b.seq - a.seq)
                .slice(0, 10),
            }
          : {}),
        seq: plan.seq,
        ...(state === "done" ? { doneAt: lastDone } : {}),
        doneToday: doneTodayFlag,
      };
    })
    // 已完成存档的 30 天窗口（评审 2026-09-29：载荷/模型上下文无界增长）——「已完成」视图本就按 30 天过滤，
    // 折叠层同口径截断后 UI 无感、agent 面（query_ledger what=today）不再全量灌历史
    .filter((p) => p.state !== "done" || (p.doneAt ?? 0) >= now - 30 * 86400000)
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.planId.localeCompare(b.planId));

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

  // Top3（确定性，0 模型；2026-09-30 目标层级下线——goalCard/goalView 整体移除，只剩计划终端）
  const topItems = top3(records, now, tzOffsetMinutes);

  return { date: dateString(localParts(now, tzOffsetMinutes)), flows, plans, totalByCategory, streakDays, top3: topItems };
}

// ── 计划/打卡折叠共用（2026-09-30 目标层级下线：goal 树折叠整体移除，历史 goal 行在投影层不可见） ──

/** 剔除 void 记录本身（top3 共用；与 todayView 同语义） */
function liveRecords(records: LedgerRecord[]): Array<FlowRecord | PlanRecord | CheckinRecord> {
  const voided = new Set(
    records.filter((r): r is Extract<LedgerRecord, { kind: "void" }> => r.kind === "void").map((r) => r.targetSeq),
  );
  return records.filter((r) => r.kind !== "void" && !voided.has(r.seq)) as Array<FlowRecord | PlanRecord | CheckinRecord>;
}

/** 存活 done 打卡的 planId 集合（doneEver 语义：打过一次就算）——top3 共用 */
function liveDoneEver(live: LedgerRecord[]): Set<string> {
  const set = new Set<string>();
  for (const r of live) {
    if (r.kind === "checkin" && r.done) set.add(r.planId);
  }
  return set;
}

export interface TopItem {
  kind: "overdue" | "dueToday" | "today";
  title: string;
  planId?: string;
  due?: string;
}

/** 今日必做 Top3（确定性，0 模型）：逾期 > 今日截止 > 覆盖今天的未完成 */
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

  const itemFor = (plan: PlanRecord, kind: TopItem["kind"]): TopItem => ({
    kind,
    title: plan.title,
    planId: plan.planId,
    ...(plan.due !== undefined ? { due: plan.due } : {}),
  });

  const overdue: TopItem[] = [];
  const dueToday: TopItem[] = [];
  const todayItems: TopItem[] = [];
  for (const r of live) {
    if (r.kind !== "plan") continue;
    if (r.scope === "deadline") {
      if (doneEver.has(r.planId) || r.due === undefined) continue; // 已完成/无 due 不进
      if (r.due < todayStr) overdue.push(itemFor(r, "overdue"));
      else if (r.due === todayStr && !doneToday.has(r.planId)) dueToday.push(itemFor(r, "dueToday"));
      continue;
    }
    if (planScopeCoversToday(r, now, tzOffsetMinutes) && !doneToday.has(r.planId)) todayItems.push(itemFor(r, "today"));
  }

  return [...overdue, ...dueToday, ...todayItems].slice(0, 3);
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
