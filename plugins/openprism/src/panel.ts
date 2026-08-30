/**
 * 面板聚合与渲染：storage 记录 → 六维度统计摘要 → 文本/JSON 投影。
 * 全部是纯函数——工具、HTTP 端点与浏览器 UI 共用同一份聚合逻辑。
 *
 * @module openprism/panel
 */

import type {
  ActivityDimension,
  ActivityRecord,
  CategoryDimension,
  ExpenseRecord,
  MoodRecord,
  PanelData,
} from './types.js'

/** 活动类维度（固定顺序，UI 页签与聚合共用）。 */
export const ACTIVITY_DIMENSIONS: readonly ActivityDimension[] = ['life', 'work', 'family', 'study']

/** 拥有可自定义分类的维度（固定顺序）。 */
export const CATEGORY_DIMENSIONS: readonly CategoryDimension[] = ['finance', 'life', 'work', 'family', 'study']

/** 兜底分类名：删除分类时记录归入此处；不可删除、不可改名。 */
export const FALLBACK_CATEGORY = '其他'

/** 各维度分类的默认集合：维度首次出现（categories 表无该维度记录）时播种。 */
export const DEFAULT_CATEGORIES: Record<CategoryDimension, readonly string[]> = {
  finance: ['餐饮', '饮品', '交通', '日用', '娱乐', '医疗', '学习', '其他'],
  life: ['运动', '睡眠', '饮食', '家务', '出行', '休闲', '其他'],
  work: ['会议', '编码', '沟通', '文档', '评审', '支持', '其他'],
  family: ['陪伴', '通话', '家务', '纪念', '其他'],
  study: ['阅读', '课程', '练习', '写作', '复习', '其他'],
}

/** 活动维度的展示名（模型侧 render 与 UI 页签共用措辞）。 */
export const ACTIVITY_DIMENSION_LABEL: Record<ActivityDimension, string> = {
  life: '生活',
  work: '工作',
  family: '家庭',
  study: '学习',
}

/** 分类聚合行（理财）。 */
export interface CategoryTotal {
  category: string
  amount: number
  count: number
}

/** 近期每日支出（迷你柱状图数据）。 */
export interface DailyTotal {
  /** YYYY-MM-DD（本地时区）。 */
  date: string
  amount: number
}

/** 理财维度摘要。 */
export interface FinanceSummary {
  monthTotal: number
  monthCount: number
  byCategory: CategoryTotal[]
  /** 最近 14 天每日支出（含零支出日，旧→新）。 */
  daily: DailyTotal[]
}

/** 情感维度摘要。 */
export interface MoodSummary {
  count: number
  average: number | null
  /** 最近 7 条（新→旧）。 */
  recent: Array<{ date: string; score: number; note?: string }>
}

/** 分类聚合行（活动维度：条数 + 分钟）。 */
export interface ActivityCategoryTotal {
  category: string
  count: number
  minutes: number
}

/** 单个活动维度摘要。 */
export interface ActivityDimensionSummary {
  /** 本月记录条数。 */
  monthCount: number
  /** 本月累计时长（分钟）。 */
  monthMinutes: number
  /** 本月分类聚合（按条数降序）。 */
  byCategory: ActivityCategoryTotal[]
  /** 最近 7 条（新→旧）。 */
  recent: Array<{ date: string; category: string; minutes?: number; note?: string }>
}

/** 面板摘要：所有视图（模型工具 / HTTP 端点 / 浏览器 UI）的统一数据形状。 */
export interface PanelSummary {
  updatedAt: number
  /** 本月键（YYYY-MM，本地时区）。 */
  month: string
  finance: FinanceSummary
  mood: MoodSummary
  activities: Record<ActivityDimension, ActivityDimensionSummary>
  /** 各维度的当前分类清单（自定义后实时变化）。 */
  categories: Record<CategoryDimension, string[]>
  /** 最近记录（含事件 id，供 openprism_correct 更正/删除与 UI 编辑入口）；由宿主侧装配。 */
  recent?: RecentItem[]
  /** 目标/预算进度（6.1）；由宿主侧装配。 */
  goals?: GoalProgress[]
  /** 每维度记录密度热力图（近 91 天）；由宿主侧装配。 */
  heatmap?: Record<DimensionKey, Array<{ date: string; count: number }>>
  /** 周期切片（今日/本周/本月/今年，按 occurredAt）；由宿主侧装配。 */
  slices?: Record<DimensionKey, Record<PeriodKey, SliceValue>>
}

/** 六个面板维度的键（client 页签与切片/热力图共用）。 */
export type DimensionKey = 'finance' | 'mood' | 'life' | 'work' | 'family' | 'study'
export type PeriodKey = 'today' | 'week' | 'month' | 'year'

/** 周期切片值：count=记录数；amount=支出合计（finance）；minutes=时长合计（活动维度）。 */
export interface SliceValue {
  count: number
  amount?: number
  minutes?: number
}

/** 目标进度（目标事件 × 当期实际，6.1）。 */
export interface GoalProgress {
  id: string
  dimension: string
  metric: string
  target: number
  period: 'daily' | 'weekly' | 'monthly'
  note?: string
  /** 当期实际值。 */
  current: number
  /** current/target（可 >1）。 */
  ratio: number
  /** 窗口起始（YYYY-MM-DD）。 */
  windowStart: string
}

/** 最近记录行（更正回路的取 target 来源，4.1）。 */
export interface RecentItem {
  id: string
  kind: 'expense' | 'mood' | 'activity'
  occurredAt: number
  /** YYYY-MM-DD（本地时区，按 occurredAt）。 */
  date: string
  title: string
}

/** YYYY-MM-DD（本地时区）。 */
export function dayKey(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthKey(time: number): string {
  return dayKey(time).slice(0, 7)
}

/** 分类清单投影：storage 记录 → 每维度按创建时间排序的名字列表（空维度回退默认集）。 */
export function categoryLists(data: PanelData): Record<CategoryDimension, string[]> {
  const result = {} as Record<CategoryDimension, string[]>
  for (const dim of CATEGORY_DIMENSIONS) {
    const rows = data.categories
      .filter((c) => c.dimension === dim)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => c.name)
    result[dim] = rows.length > 0 ? rows : [...DEFAULT_CATEGORIES[dim]]
  }
  return result
}

function buildFinance(expenses: ExpenseRecord[], now: number): FinanceSummary {
  const month = monthKey(now)
  const monthExpenses = expenses.filter((e) => monthKey(e.time) === month)
  const monthTotal = monthExpenses.reduce((sum, e) => sum + e.amount, 0)
  const categoryMap = new Map<string, CategoryTotal>()
  for (const e of monthExpenses) {
    const row = categoryMap.get(e.category) ?? { category: e.category, amount: 0, count: 0 }
    row.amount += e.amount
    row.count += 1
    categoryMap.set(e.category, row)
  }

  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const dailyMap = new Map<string, number>()
  for (const e of expenses) {
    if (now - e.time > 14 * 24 * 3600 * 1000) continue
    const key = dayKey(e.time)
    dailyMap.set(key, (dailyMap.get(key) ?? 0) + e.amount)
  }
  const daily: DailyTotal[] = []
  for (let i = 13; i >= 0; i--) {
    const date = dayKey(dayStart.getTime() - i * 24 * 3600 * 1000)
    daily.push({ date, amount: dailyMap.get(date) ?? 0 })
  }

  return {
    monthTotal,
    monthCount: monthExpenses.length,
    byCategory: [...categoryMap.values()].sort((a, b) => b.amount - a.amount),
    daily,
  }
}

function buildMood(moods: MoodRecord[]): MoodSummary {
  const sorted = [...moods].sort((a, b) => a.time - b.time)
  return {
    count: sorted.length,
    average: sorted.length === 0 ? null : sorted.reduce((sum, m) => sum + m.score, 0) / sorted.length,
    recent: sorted.slice(-7).reverse().map((m) => ({
      date: dayKey(m.time),
      score: m.score,
      ...(m.note !== undefined ? { note: m.note } : {}),
    })),
  }
}

function buildActivityDimension(records: ActivityRecord[], dim: ActivityDimension, now: number): ActivityDimensionSummary {
  const month = monthKey(now)
  const mine = records.filter((r) => r.dimension === dim)
  const monthRecords = mine.filter((r) => monthKey(r.time) === month)
  const categoryMap = new Map<string, ActivityCategoryTotal>()
  for (const r of monthRecords) {
    const row = categoryMap.get(r.category) ?? { category: r.category, count: 0, minutes: 0 }
    row.count += 1
    row.minutes += r.durationMinutes ?? 0
    categoryMap.set(r.category, row)
  }
  return {
    monthCount: monthRecords.length,
    monthMinutes: monthRecords.reduce((sum, r) => sum + (r.durationMinutes ?? 0), 0),
    byCategory: [...categoryMap.values()].sort((a, b) => b.count - a.count),
    recent: [...mine]
      .sort((a, b) => b.time - a.time)
      .slice(0, 7)
      .map((r) => ({
        date: dayKey(r.time),
        category: r.category,
        ...(r.durationMinutes !== undefined ? { minutes: r.durationMinutes } : {}),
        ...(r.note !== undefined ? { note: r.note } : {}),
      })),
  }
}

/** 聚合：storage 记录 → 面板摘要（纯函数）。 */
export function buildPanelSummary(data: PanelData, now: number = Date.now()): PanelSummary {
  const activities = {} as Record<ActivityDimension, ActivityDimensionSummary>
  for (const dim of ACTIVITY_DIMENSIONS) {
    activities[dim] = buildActivityDimension(data.activities, dim, now)
  }
  return {
    updatedAt: now,
    month: monthKey(now),
    finance: buildFinance(data.expenses, now),
    mood: buildMood(data.moods),
    activities,
    categories: categoryLists(data),
  }
}

// ─── 聚合 v2（批次 4）：目标进度 / 热力图 / 周期切片 ───

function startOfDay(time: number): number {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 周期窗口起点（本地时区）：日=今天零点；周=本周一；月=本月 1 日；年=今年 1 月 1 日。 */
export function periodStart(period: 'daily' | 'weekly' | 'monthly' | 'today' | 'week' | 'month' | 'year', now: number): number {
  const d = new Date(startOfDay(now))
  if (period === 'daily' || period === 'today') return d.getTime()
  if (period === 'weekly' || period === 'week') {
    const dow = (d.getDay() + 6) % 7 // 周一=0
    return d.getTime() - dow * 24 * 3600 * 1000
  }
  if (period === 'monthly' || period === 'month') {
    d.setDate(1)
    return d.getTime()
  }
  d.setMonth(0, 1)
  return d.getTime()
}

function inWindow(occurredAt: number, from: number): boolean {
  return occurredAt >= from
}

/**
 * 目标进度（6.1）：活跃目标 × 当期实际值。
 * metric 取值：expenseTotal（理财支出合计）/ activityDuration / activityCount
 * （activity 维度时长与条数）/ moodCount（心情打卡数）。
 */
export function buildGoalProgress(
  goalRecords: Array<{ id: string; payload: import('./events.js').GoalPayload }>,
  records: FoldedRecordLike[],
  now: number,
): GoalProgress[] {
  const starts: Record<'daily' | 'weekly' | 'monthly', number> = {
    daily: periodStart('daily', now),
    weekly: periodStart('weekly', now),
    monthly: periodStart('monthly', now),
  }
  return goalRecords.map((goal) => {
    const from = starts[goal.payload.period]
    let current = 0
    for (const record of records) {
      if (record.deleted) continue
      if (!inWindow(record.occurredAt, from)) continue
      if (goal.payload.metric === 'expenseTotal') {
        if (record.kind === 'expense') current += (record.payload as { amount: number }).amount
      } else if (goal.payload.metric === 'activityDuration') {
        if (record.kind === 'activity' && (record.payload as { dimension: string }).dimension === goal.payload.dimension) {
          current += (record.payload as { durationMinutes?: number }).durationMinutes ?? 0
        }
      } else if (goal.payload.metric === 'activityCount') {
        if (record.kind === 'activity' && (record.payload as { dimension: string }).dimension === goal.payload.dimension) {
          current += 1
        }
      } else if (goal.payload.metric === 'moodCount') {
        if (record.kind === 'mood') current += 1
      }
    }
    return {
      id: goal.id,
      dimension: goal.payload.dimension,
      metric: goal.payload.metric,
      target: goal.payload.target,
      period: goal.payload.period,
      ...(goal.payload.note !== undefined ? { note: goal.payload.note } : {}),
      current,
      ratio: goal.payload.target > 0 ? current / goal.payload.target : 0,
      windowStart: dayKey(from),
    }
  })
}

/** 折叠记录的最小结构面（panel.ts 不反向依赖 fold.ts）。 */
export interface FoldedRecordLike {
  kind: 'expense' | 'mood' | 'activity' | 'goal'
  occurredAt: number
  deleted: boolean
  payload: unknown
}

/** 每维度记录密度热力图：近 days 天（含今天）逐日记录数，旧→新。 */
export function buildHeatmap(
  records: FoldedRecordLike[],
  dimension: DimensionKey,
  now: number,
  days = 91,
): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>()
  for (const record of records) {
    if (record.deleted) continue
    const dim = recordDimension(record)
    if (dim !== dimension) continue
    if (record.occurredAt > now) continue
    const key = dayKey(record.occurredAt)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out: Array<{ date: string; count: number }> = []
  const todayStart = startOfDay(now)
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = dayKey(todayStart - i * 24 * 3600 * 1000)
    out.push({ date, count: counts.get(date) ?? 0 })
  }
  return out
}

/** 周期切片：今日/本周/本月/今年的 count（+amount/minutes）。 */
export function buildSlices(
  records: FoldedRecordLike[],
  dimension: DimensionKey,
  now: number,
): Record<PeriodKey, SliceValue> {
  const windows: Record<PeriodKey, number> = {
    today: periodStart('today', now),
    week: periodStart('week', now),
    month: periodStart('month', now),
    year: periodStart('year', now),
  }
  const result = {} as Record<PeriodKey, SliceValue>
  for (const [period, from] of Object.entries(windows) as Array<[PeriodKey, number]>) {
    let count = 0
    let amount: number | undefined
    let minutes: number | undefined
    for (const record of records) {
      if (record.deleted || record.occurredAt > now) continue
      if (recordDimension(record) !== dimension) continue
      if (!inWindow(record.occurredAt, from)) continue
      count += 1
      if (record.kind === 'expense') {
        amount = (amount ?? 0) + (record.payload as { amount: number }).amount
      }
      if (record.kind === 'activity') {
        const minutesOf = (record.payload as { durationMinutes?: number }).durationMinutes
        if (minutesOf !== undefined) minutes = (minutes ?? 0) + minutesOf
      }
    }
    result[period] = {
      count,
      ...(amount !== undefined ? { amount } : {}),
      ...(minutes !== undefined ? { minutes } : {}),
    }
  }
  return result
}

function recordDimension(record: FoldedRecordLike): DimensionKey {
  if (record.kind === 'expense') return 'finance'
  if (record.kind === 'mood') return 'mood'
  if (record.kind === 'activity') return (record.payload as { dimension: DimensionKey }).dimension
  return 'life'
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 面板统计文本：面向模型（openprism_panel 工具的 render）。 */
export function renderPanelSummary(summary: PanelSummary): string {
  const lines: string[] = []
  if (summary.finance.monthCount === 0) {
    lines.push(`本月（${summary.month}）暂无支出记录`)
  } else {
    lines.push(`本月（${summary.month}）支出合计 ¥${summary.finance.monthTotal.toFixed(2)}，共 ${summary.finance.monthCount} 笔`)
    for (const row of summary.finance.byCategory) {
      lines.push(`  ${row.category}：¥${row.amount.toFixed(2)}（${row.count} 笔）`)
    }
  }
  if (summary.mood.count === 0) {
    lines.push('暂无心情记录')
  } else {
    lines.push(
      `心情记录 ${summary.mood.count} 条，均值 ${summary.mood.average === null ? '—' : `${summary.mood.average.toFixed(1)}/5`}`,
    )
  }
  for (const dim of ACTIVITY_DIMENSIONS) {
    const s = summary.activities[dim]
    if (s.monthCount === 0) {
      lines.push(`${ACTIVITY_DIMENSION_LABEL[dim]}：本月暂无记录`)
    } else {
      const top = s.byCategory.slice(0, 4).map((c) => `${c.category} ${c.count}`).join('、')
      const dur = s.monthMinutes > 0 ? ` / ${formatMinutes(s.monthMinutes)}` : ''
      lines.push(`${ACTIVITY_DIMENSION_LABEL[dim]}：本月 ${s.monthCount} 条${dur}（${top}）`)
    }
  }
  lines.push('可录分类（record 时优先复用，新名称会自动创建）：')
  for (const dim of CATEGORY_DIMENSIONS) {
    lines.push(`  ${dim === 'finance' ? '支出' : ACTIVITY_DIMENSION_LABEL[dim as ActivityDimension]}：${summary.categories[dim].join('、')}`)
  }
  if (summary.recent !== undefined && summary.recent.length > 0) {
    lines.push('最近记录（[id] 可用 openprism_correct 更正/删除）：')
    for (const item of summary.recent) {
      lines.push(`  [${item.id}] ${item.date} ${item.title}`)
    }
  }
  return lines.join('\n')
}
