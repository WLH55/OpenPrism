/**
 * 面板聚合：折叠结果 → 六维度统计（月合计/分类聚合/近 14 天趋势/最近记录/
 * 91 天热力图/周期切片/目标进度），以及给模型看的紧凑摘要文本（openprism_panel 工具的返回）。
 */

import type { ActivityDimension, Dimension } from './types'
import type { Folded } from './fold'
import { DIMENSION_META, PERIOD_LABEL, WEEKDAY_LABEL, AGGREGATE_LABEL } from './types'
import { periodWindow } from './fold'
import type { RecordEvent } from './events'

export type PeriodKey = 'today' | 'week' | 'month' | 'year'
const PERIOD_MAP: Record<PeriodKey, 'day' | 'week' | 'month' | 'year'> = {
  today: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
}

export interface RecentItem {
  id: string
  kind: RecordEvent['kind']
  dimension: Dimension
  title: string
  occurredAt: number
  recordedAt: number
  dateLabel: string
}

export interface SliceValue {
  count: number
  amount: number
  minutes: number
}

export interface PanelData {
  updatedAt: number
  month: string
  finance: {
    monthTotal: number
    monthCount: number
    byCategory: Array<{ category: string; amount: number; count: number }>
    daily: Array<{ date: string; amount: number }>
  }
  mood: {
    monthCount: number
    average: number | null
    recent: Array<{ date: string; score: number; note?: string }>
  }
  activities: Record<
    ActivityDimension,
    { monthCount: number; monthMinutes: number; byCategory: Array<{ category: string; count: number; minutes: number }> }
  >
  recent: RecentItem[]
  heatmap: Partial<Record<Dimension, Record<string, number>>>
  slices: Partial<Record<Dimension, Record<PeriodKey, SliceValue>>>
}

export function buildPanel(f: Folded, now: number): PanelData {
  const records = f.records
  const monthWin = periodWindow('month', now)

  const financeRecords = records.filter((r): r is Extract<RecordEvent, { kind: 'expense' }> => r.kind === 'expense')
  const monthFinance = financeRecords.filter((r) => inWin(r, monthWin))
  const byCategory = groupBy(monthFinance, (r) => r.category).map(([category, rs]) => ({
    category,
    amount: sum(rs, (r) => r.amount),
    count: rs.length,
  }))
  byCategory.sort((a, b) => b.amount - a.amount)

  const daily: Array<{ date: string; amount: number }> = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const next = new Date(d)
    next.setDate(next.getDate() + 1)
    const win = { start: d.getTime(), end: next.getTime() }
    daily.push({ date: fmtDate(d.getTime()), amount: sum(financeRecords.filter((r) => inWin(r, win)), (r) => r.amount) })
  }

  const moodRecords = records.filter((r): r is Extract<RecordEvent, { kind: 'mood' }> => r.kind === 'mood')
  const monthMood = moodRecords.filter((r) => inWin(r, monthWin))
  const moodRecent = [...monthMood].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 7)

  const activities = {} as PanelData['activities']
  for (const dim of ['life', 'work', 'family', 'study'] as const) {
    const rs = records.filter((r): r is Extract<RecordEvent, { kind: 'activity' }> => r.kind === 'activity' && r.dimension === dim)
    const monthRs = rs.filter((r) => inWin(r, monthWin))
    const byCat = groupBy(monthRs, (r) => r.category)
      .map(([category, list]) => ({ category, count: list.length, minutes: sum(list, (r) => r.minutes ?? 0) }))
      .sort((a, b) => b.count - a.count)
    activities[dim] = {
      monthCount: monthRs.length,
      monthMinutes: sum(monthRs, (r) => r.minutes ?? 0),
      byCategory: byCat,
    }
  }

  const recent = [...records]
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 10)
    .map((r): RecentItem => ({
      id: r.id,
      kind: r.kind,
      dimension: r.dimension,
      title: recordTitle(r),
      occurredAt: r.occurredAt,
      recordedAt: r.recordedAt,
      dateLabel: fmtDate(r.occurredAt),
    }))

  // 91 天热力图：按 occurredAt 的日历日计数
  const heatmap: PanelData['heatmap'] = {}
  const heatStart = new Date(now)
  heatStart.setHours(0, 0, 0, 0)
  heatStart.setDate(heatStart.getDate() - 90)
  for (const r of records) {
    if (r.occurredAt < heatStart.getTime()) continue
    const day = fmtDate(r.occurredAt)
    const bucket = (heatmap[r.dimension] ??= {})
    bucket[day] = (bucket[day] ?? 0) + 1
  }

  const slices: PanelData['slices'] = {}
  for (const r of records) {
    const perDim = (slices[r.dimension] ??= {} as Record<PeriodKey, SliceValue>)
    for (const key of ['today', 'week', 'month', 'year'] as const) {
      const win = periodWindow(PERIOD_MAP[key], now)
      if (!inWin(r, win)) continue
      const v = (perDim[key] ??= { count: 0, amount: 0, minutes: 0 })
      v.count += 1
      if (r.kind === 'expense') v.amount += r.amount
      if (r.kind === 'activity') v.minutes += r.minutes ?? 0
    }
  }

  const d = new Date(now)
  return {
    updatedAt: now,
    month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    finance: { monthTotal: sum(monthFinance, (r) => r.amount), monthCount: monthFinance.length, byCategory, daily },
    mood: {
      monthCount: monthMood.length,
      average: monthMood.length ? round1(sum(monthMood, (r) => r.score) / monthMood.length) : null,
      recent: moodRecent.map((r) => ({ date: fmtDate(r.occurredAt), score: r.score, note: r.note })),
    },
    activities,
    recent,
    heatmap,
    slices,
  }
}

/** 紧凑摘要（openprism_panel 工具返回给模型的文本；数据零 token——全部确定性计算）。 */
export function formatPanelSummary(f: Folded, now: number): string {
  const p = buildPanel(f, now)
  const lines: string[] = []
  lines.push(`【OpenPrism 面板 · ${p.month}】`)

  lines.push(`💰 理财 本月支出 ¥${p.finance.monthTotal}（${p.finance.monthCount} 笔）`)
  if (p.finance.byCategory.length) {
    lines.push(`   分类：${p.finance.byCategory.map((c) => `${c.category} ¥${c.amount}(${c.count})`).join(' · ')}`)
  }

  lines.push(
    `❤️ 情感 本月 ${p.mood.monthCount} 条${p.mood.average !== null ? ` · 均值 ${p.mood.average}` : ''}${
      p.mood.recent.length ? ` · 最近：${p.mood.recent.map((r) => `${r.score}分`).join('/')}` : ''
    }`,
  )

  for (const dim of ['life', 'work', 'family', 'study'] as const) {
    const a = p.activities[dim]
    const meta = DIMENSION_META[dim]
    if (a.monthCount === 0) {
      lines.push(`${meta.emoji} ${meta.label} 本月无记录`)
      continue
    }
    const cat = a.byCategory.map((c) => `${c.category} ${c.count}次${c.minutes ? `/${c.minutes}分` : ''}`).join(' · ')
    lines.push(`${meta.emoji} ${meta.label} 本月 ${a.monthCount} 条 / ${a.monthMinutes} 分钟${cat ? `：${cat}` : ''}`)
  }

  if (f.goals.length) {
    lines.push('🎯 目标')
    for (const gp of f.goalProgress) {
      const g = gp.goal.event
      const dim = DIMENSION_META[g.dimension]
      const scope = g.category ? `${dim.label}/${g.category}` : dim.label
      const cmp = g.aggregate === 'amount' ? '≤' : '≥'
      const unit = g.aggregate === 'amount' ? '元' : g.aggregate === 'minutes' ? '分钟' : '次'
      const anchors = g.anchorDays?.length ? `（偏好 ${g.anchorDays.map((d) => WEEKDAY_LABEL[d]).join('、')}）` : ''
      const mark = gp.met ? '✓' : '✗'
      lines.push(
        `· ${scope} ${PERIOD_LABEL[g.period]}${cmp}${g.target}${unit}${anchors}：当前 ${gp.current}${unit} ${mark}`,
      )
    }
  }

  const catLines: string[] = []
  for (const [dim, list] of Object.entries(f.categories)) {
    if (list.length) catLines.push(`${DIMENSION_META[dim as keyof typeof DIMENSION_META].emoji}[${list.join(' ')}]`)
  }
  if (catLines.length) lines.push(`📋 可录分类（不限于）：${catLines.join(' ')}`)

  if (p.recent.length) {
    lines.push('🕘 最近记录（id 可用于更正）')
    for (const r of p.recent) lines.push(`· ${r.id} ${r.dateLabel} ${r.title}`)
  }
  return lines.join('\n')
}

// ─── 内部工具 ───

function inWin(r: RecordEvent, win: { start: number; end: number }): boolean {
  return r.occurredAt >= win.start && r.occurredAt < win.end
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return [...map.entries()]
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0
  for (const item of items) total += pick(item)
  return total
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtDate(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function recordTitle(r: RecordEvent): string {
  switch (r.kind) {
    case 'expense':
      return `支出 ¥${r.amount} ${r.category}${r.note ? ` · ${r.note}` : ''}`
    case 'mood':
      return `心情 ${r.score} 分${r.note ? ` · ${r.note}` : ''}`
    case 'activity':
      return `${r.category}${r.minutes ? ` ${r.minutes} 分钟` : ''}${r.note ? ` · ${r.note}` : ''}`
  }
}

export { AGGREGATE_LABEL }
