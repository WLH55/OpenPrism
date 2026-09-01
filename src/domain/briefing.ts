/**
 * 简报生成（批次 2）：日报 / 周报 markdown。
 * 数据章节零 token——全部从折叠确定性计算（M8：目标完成对照直接出，复盘解读由调用方可选追加）。
 * 周窗口与 periodWindow 同构（周一为一周之始），周编号取 ISO week。
 */

import type { Folded } from './fold'
import { periodWindow } from './fold'
import type { RecordEvent } from './events'
import { DIMENSION_META, PERIOD_LABEL, WEEKDAY_LABEL } from './types'
import { DIMENSION_ORDER } from './fold'

export type BriefingKind = 'daily' | 'weekly'

export const BRIEFING_KIND_LABEL: Record<BriefingKind, string> = { daily: '日报', weekly: '周报' }

/** 文件名：brief-daily-2026-09-01.md / brief-weekly-2026-W36.md */
export function briefingFilename(kind: BriefingKind, now: number): string {
  const d = new Date(now)
  if (kind === 'daily') return `brief-daily-${fmtDate(now)}.md`
  return `brief-weekly-${isoYearWeek(now)}.md`
}

export function buildBriefing(kind: BriefingKind, f: Folded, now: number): string {
  const span = kind === 'daily' ? 1 : 7
  const win = periodWindow(kind === 'daily' ? 'day' : 'week', now)
  const prevWin = { start: win.start - span * DAY_MS, end: win.start }
  const scopeLabel = kind === 'daily' ? '今日' : '本周'
  const prevLabel = kind === 'daily' ? '昨日' : '上周'

  const inWin = (r: RecordEvent): boolean => r.occurredAt >= win.start && r.occurredAt < win.end
  const inPrev = (r: RecordEvent): boolean => r.occurredAt >= prevWin.start && r.occurredAt < prevWin.end
  const records = f.records.filter(inWin)
  const prevRecords = f.records.filter(inPrev)

  const lines: string[] = []
  lines.push(...titleLines(kind, now))
  lines.push('')

  // ─── 录入概览 ───
  const byDim = new Map<string, number>()
  for (const r of records) byDim.set(r.dimension, (byDim.get(r.dimension) ?? 0) + 1)
  const parts = DIMENSION_ORDER.filter((dim) => byDim.get(dim)).map(
    (dim) => `${DIMENSION_META[dim].emoji}${DIMENSION_META[dim].label} ${byDim.get(dim)}`,
  )
  lines.push('## 录入概览')
  lines.push(records.length ? `${scopeLabel}共录入 ${records.length} 条：${parts.join(' · ')}` : `${scopeLabel}暂无记录。`)
  if (prevRecords.length) {
    const diff = records.length - prevRecords.length
    const trend = diff > 0 ? `+${diff}` : String(diff)
    lines.push(`较${prevLabel} ${trend} 条（${prevLabel} ${prevRecords.length} 条）`)
  }
  lines.push('')

  // ─── 理财 ───
  const expenses = records.filter((r): r is Extract<RecordEvent, { kind: 'expense' }> => r.kind === 'expense')
  const prevExpenses = prevRecords.filter((r): r is Extract<RecordEvent, { kind: 'expense' }> => r.kind === 'expense')
  const spendTotal = sumOf(expenses, (r) => r.amount)
  const prevSpend = sumOf(prevExpenses, (r) => r.amount)
  lines.push(`## ${DIMENSION_META.finance.emoji} ${DIMENSION_META.finance.label}`)
  if (expenses.length) {
    const cats = groupSum(expenses, (r) => r.category, (r) => r.amount)
    lines.push(`${scopeLabel}支出 ¥${Math.round(spendTotal)}（${expenses.length} 笔）：${cats.map(([c, v]) => `${c} ¥${Math.round(v)}`).join(' · ')}`)
    if (prevExpenses.length && prevSpend > 0) {
      const pct = Math.round(((spendTotal - prevSpend) / prevSpend) * 100)
      lines.push(`较${prevLabel} ${pct > 0 ? '+' : ''}${pct}%（${prevLabel} ¥${Math.round(prevSpend)}）`)
    }
  } else {
    lines.push(`${scopeLabel}无支出记录。`)
  }
  if (kind === 'daily') {
    const monthWin = periodWindow('month', now)
    const monthExpenses = f.records.filter(
      (r) => r.kind === 'expense' && r.occurredAt >= monthWin.start && r.occurredAt < monthWin.end,
    ) as Extract<RecordEvent, { kind: 'expense' }>[]
    lines.push(`本月累计 ¥${Math.round(sumOf(monthExpenses, (r) => r.amount))}（${monthExpenses.length} 笔）`)
  }
  lines.push('')

  // ─── 情感 ───
  const moods = records.filter((r): r is Extract<RecordEvent, { kind: 'mood' }> => r.kind === 'mood')
  lines.push(`## ${DIMENSION_META.mood.emoji} ${DIMENSION_META.mood.label}`)
  if (moods.length) {
    const avg = (sumOf(moods, (r) => r.score) / moods.length).toFixed(1)
    const scores = [...moods].sort((a, b) => a.occurredAt - b.occurredAt).map((r) => `${r.score}分`).join('/')
    lines.push(`${scopeLabel} ${moods.length} 条 · 均值 ${avg} · ${scores}`)
  } else {
    lines.push(`${scopeLabel}无心情记录。`)
  }
  lines.push('')

  // ─── 活动四维度 ───
  for (const dim of ['life', 'work', 'family', 'study'] as const) {
    const acts = records.filter((r) => r.kind === 'activity' && r.dimension === dim)
    if (!acts.length) continue
    const minutes = sumOf(acts as Extract<RecordEvent, { kind: 'activity' }>[], (r) => r.minutes ?? 0)
    const cats = groupSum(acts as Extract<RecordEvent, { kind: 'activity' }>[], (r) => r.category, () => 1)
    const detail = cats.map(([c, v]) => `${c} ${v}次`).join(' · ')
    const meta = DIMENSION_META[dim]
    lines.push(`## ${meta.emoji} ${meta.label}`)
    lines.push(`${scopeLabel} ${acts.length} 条 / ${minutes} 分钟：${detail}`)
    lines.push('')
  }

  // ─── 目标对照（M8：从折叠直接出，零 token） ───
  lines.push('## 🎯 目标对照')
  if (f.goalProgress.length) {
    for (const gp of f.goalProgress) {
      const g = gp.goal.event
      const meta = DIMENSION_META[g.dimension]
      const scope = g.category ? `${meta.label}/${g.category}` : meta.label
      const unit = g.aggregate === 'amount' ? '元' : g.aggregate === 'minutes' ? '分钟' : '次'
      const cmp = g.aggregate === 'amount' ? '≤' : '≥'
      lines.push(`- ${gp.met ? '✅' : '⬜'} ${scope} ${PERIOD_LABEL[g.period]}${cmp}${g.target}${unit}：当前 ${roundNum(gp.current)}/${g.target}${unit}${gp.met ? ' 达标' : ''}`)
    }
  } else {
    lines.push('（暂无进行中的目标）')
  }
  lines.push('')

  // ─── 记录明细 ───
  lines.push(`## 🕘 ${scopeLabel}记录`)
  if (records.length) {
    for (const r of [...records].sort((a, b) => a.occurredAt - b.occurredAt)) {
      lines.push(`- ${fmtTime(r.occurredAt)} ${recordTitle(r)}`)
    }
  } else {
    lines.push('（无）')
  }

  return lines.join('\n')
}

// ─── 内部工具 ───

const DAY_MS = 24 * 60 * 60 * 1000

function titleLines(kind: BriefingKind, now: number): string[] {
  const d = new Date(now)
  if (kind === 'daily') {
    return [`# OpenPrism 日报 · ${fmtDate(now)} ${WEEKDAY_LABEL[d.getDay()]}`]
  }
  const monday = new Date(d)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  return [
    `# OpenPrism 周报 · ${fmtDate(monday.getTime())} – ${fmtDate(sunday.getTime())}（第 ${isoWeek(d)} 周）`,
  ]
}

/** ISO 周（周一为始）：挪到本周周四定 ISO 年，再与第 1 周的周一对齐数周。 */
export function isoWeek(date: Date): number {
  const t = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7))
  const week1 = new Date(t.getFullYear(), 0, 4)
  week1.setDate(week1.getDate() - ((week1.getDay() + 6) % 7))
  return 1 + Math.round((t.getTime() - week1.getTime()) / (7 * DAY_MS))
}

/** ISO 年-周标识（周报文件名用）：2026-W36。 */
export function isoYearWeek(now: number): string {
  const d = new Date(now)
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7))
  return `${t.getFullYear()}-W${pad(isoWeek(d))}`
}

function sumOf<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0
  for (const item of items) total += pick(item)
  return total
}

function groupSum<T>(items: readonly T[], key: (item: T) => string, value: (item: T) => number): Array<[string, number]> {
  const map = new Map<string, number>()
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + value(item))
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

function roundNum(n: number): number {
  return Math.round(n * 10) / 10
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function fmtDate(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtTime(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
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
