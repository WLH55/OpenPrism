/**
 * 主动简报（D7）：每日/每周 markdown，数据部分折叠+模板（确定性、零 token），
 * 周报解读段可选过 LLM。产物是可重算的派生物，落 `reports/YYYY-MM/`（不进事件日志）。
 *
 * @module openprism/briefing
 */

import { dayKey, periodStart, type FoldedRecordLike, type GoalProgress } from './panel.js'
import type { GoalPayload } from './events.js'
import { ACTIVITY_DIMENSION_LABEL } from './panel.js'
import type { ActivityDimension } from './types.js'

export interface BriefingResult {
  /** 相对 openprism home 的存放路径（reports/YYYY-MM/xxx.md）。 */
  path: string
  markdown: string
}

function monthDir(time: number): string {
  return `reports/${dayKey(time).slice(0, 7)}`
}

function fmtMoney(amount: number): string {
  return `¥${amount.toFixed(2)}`
}

function fmtMinutes(minutes: number): string {
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 窗口内的支出/心情/活动统计（按 occurredAt）。 */
function windowStats(records: FoldedRecordLike[], from: number, to: number): {
  expenseTotal: number
  expenseCount: number
  byCategory: Map<string, number>
  moodScores: number[]
  activityCount: number
  activityMinutes: number
} {
  const stats = {
    expenseTotal: 0,
    expenseCount: 0,
    byCategory: new Map<string, number>(),
    moodScores: [] as number[],
    activityCount: 0,
    activityMinutes: 0,
  }
  for (const record of records) {
    if (record.deleted || record.occurredAt < from || record.occurredAt >= to) continue
    if (record.kind === 'expense') {
      const amount = (record.payload as { amount: number }).amount
      stats.expenseTotal += amount
      stats.expenseCount += 1
      const category = (record.payload as { category: string }).category
      stats.byCategory.set(category, (stats.byCategory.get(category) ?? 0) + amount)
    } else if (record.kind === 'mood') {
      stats.moodScores.push((record.payload as { score: number }).score)
    } else if (record.kind === 'activity') {
      stats.activityCount += 1
      stats.activityMinutes += (record.payload as { durationMinutes?: number }).durationMinutes ?? 0
    }
  }
  return stats
}

/** 每日简报（清晨生成，回顾昨天）。 */
export function buildDailyBriefing(input: {
  records: FoldedRecordLike[]
  goals: GoalProgress[]
  /** 过去 24 小时提炼产出的记录条数（5.3 的钩子）。 */
  distillCount: number
  now: number
}): BriefingResult {
  const { records, goals, distillCount, now } = input
  const yesterday = startOfYesterday(now)
  const stats = windowStats(records, yesterday, startOfDay(now))
  const lines: string[] = []
  lines.push(`# OpenPrism 每日简报 · ${dayKey(yesterday)}`)
  lines.push('')
  lines.push('## 昨天')
  if (stats.expenseCount === 0 && stats.moodScores.length === 0 && stats.activityCount === 0) {
    lines.push('- 昨天没有记录。随手记一笔，面板才有光。')
  } else {
    if (stats.expenseCount > 0) {
      const top = [...stats.byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([category, amount]) => `${category} ${fmtMoney(amount)}`).join('、')
      lines.push(`- 支出：${fmtMoney(stats.expenseTotal)}（${String(stats.expenseCount)} 笔：${top}）`)
    } else {
      lines.push('- 支出：无记录')
    }
    if (stats.moodScores.length > 0) {
      const avg = stats.moodScores.reduce((a, b) => a + b, 0) / stats.moodScores.length
      lines.push(`- 心情：均值 ${avg.toFixed(1)}/5（${String(stats.moodScores.length)} 条）`)
    } else {
      lines.push('- 心情：无记录')
    }
    if (stats.activityCount > 0) {
      lines.push(`- 活动：${String(stats.activityCount)} 条${stats.activityMinutes > 0 ? `，合计 ${fmtMinutes(stats.activityMinutes)}` : ''}`)
    } else {
      lines.push('- 活动：无记录')
    }
  }
  lines.push('')
  lines.push('## 目标进度')
  const active = goals.filter((g) => g.metric === 'expenseTotal' || g.metric === 'activityDuration' || g.metric === 'activityCount' || g.metric === 'moodCount')
  if (active.length === 0) {
    lines.push('- 暂无目标（对话里说「本月餐饮预算 2000」即可设定）')
  } else {
    for (const goal of active) {
      const percent = Math.round(goal.ratio * 100)
      const flag = goal.metric === 'expenseTotal'
        ? goal.ratio > 1 ? '🔴 已超支' : goal.ratio >= 0.8 ? '🟡 接近上限' : '🟢'
        : goal.ratio >= 1 ? '✅ 已达成' : '🟢'
      lines.push(`- ${goal.note ?? `${goalLabel(goal)}（${periodLabel(goal.period)}）`}：${fmtGoalValue(goal)} / ${fmtTarget(goal)}（${String(percent)}%）${flag}`)
    }
  }
  lines.push('')
  lines.push('## 提炼反馈')
  lines.push(`- 过去一天从对话中提炼了 ${String(distillCount)} 条记录`)
  lines.push('')
  return { path: `${monthDir(now)}/daily-${dayKey(yesterday)}.md`, markdown: `${lines.join('\n')}\n` }
}

/** 每周周报（周日晚生成）：本周 vs 上周 + 可选 LLM 解读。 */
export async function buildWeeklyBriefing(input: {
  records: FoldedRecordLike[]
  now: number
  llm?: { completeOnce(system: string, prompt: string): Promise<string> }
  llmRoute?: { provider: string; model: string }
}): Promise<BriefingResult> {
  const { records, now } = input
  const weekStart = periodStart('week', now)
  const lastWeekStart = weekStart - 7 * 24 * 3600 * 1000
  const thisWeek = windowStats(records, weekStart, now + 1)
  const lastWeek = windowStats(records, lastWeekStart, weekStart)

  const lines: string[] = []
  const weekEnd = Math.min(now, weekStart + 7 * 24 * 3600 * 1000 - 1)
  lines.push(`# OpenPrism 周报 · ${dayKey(weekStart)} ~ ${dayKey(weekEnd)}`)
  lines.push('')
  lines.push('## 本周 vs 上周')
  lines.push('')
  lines.push('| 维度 | 本周 | 上周 | 环比 |')
  lines.push('|---|---|---|---|')
  const expenseDelta = deltaLine(thisWeek.expenseTotal, lastWeek.expenseTotal)
  lines.push(`| 支出 | ${fmtMoney(thisWeek.expenseTotal)}（${String(thisWeek.expenseCount)} 笔） | ${fmtMoney(lastWeek.expenseTotal)}（${String(lastWeek.expenseCount)} 笔） | ${expenseDelta} |`)
  lines.push(`| 心情均值 | ${moodAvg(thisWeek.moodScores)} | ${moodAvg(lastWeek.moodScores)} | — |`)
  lines.push(`| 活动条数 | ${String(thisWeek.activityCount)} | ${String(lastWeek.activityCount)} | ${deltaLine(thisWeek.activityCount, lastWeek.activityCount)} |`)
  lines.push(`| 活动时长 | ${thisWeek.activityMinutes > 0 ? fmtMinutes(thisWeek.activityMinutes) : '—'} | ${lastWeek.activityMinutes > 0 ? fmtMinutes(lastWeek.activityMinutes) : '—'} | — |`)
  lines.push('')
  lines.push('## 支出分类（本周）')
  if (thisWeek.byCategory.size === 0) {
    lines.push('- 本周暂无支出')
  } else {
    for (const [category, amount] of [...thisWeek.byCategory.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${category}：${fmtMoney(amount)}`)
    }
  }
  lines.push('')
  lines.push('## 解读')
  if (input.llm !== undefined && input.llmRoute !== undefined) {
    try {
      const interpretation = await input.llm.completeOnce(
        '你是温和的个人生活观察者。根据给定的周报统计，写 2-3 句中文解读：点出一个亮点、一个可改进项，语气友好不说教。不要编造数据。',
        `本周支出 ${fmtMoney(thisWeek.expenseTotal)}（上周 ${fmtMoney(lastWeek.expenseTotal)}）；` +
        `心情均值 ${moodAvg(thisWeek.moodScores)}（上周 ${moodAvg(lastWeek.moodScores)}）；` +
        `活动 ${String(thisWeek.activityCount)} 条 ${fmtMinutes(thisWeek.activityMinutes)}（上周 ${String(lastWeek.activityCount)} 条 ${fmtMinutes(lastWeek.activityMinutes)}）。`,
      )
      lines.push(interpretation.trim())
    } catch (error) {
      lines.push(`（解读生成失败：${String(error)}）`)
    }
  } else {
    lines.push('（未配置模型路由，跳过解读）')
  }
  lines.push('')
  const weekOfMonth = `${dayKey(weekStart).slice(0, 7)}`
  return { path: `${monthDir(weekEnd)}/weekly-${weekOfMonth}-${dayKey(weekEnd)}.md`, markdown: `${lines.join('\n')}\n` }
}

function deltaLine(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? '—' : '新增'
  const ratio = (current - previous) / previous
  const percent = Math.round(Math.abs(ratio) * 100)
  return ratio >= 0 ? `+${String(percent)}%` : `-${String(percent)}%`
}

function moodAvg(scores: number[]): string {
  return scores.length === 0 ? '—' : `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}/5`
}

function goalLabel(goal: GoalProgress): string {
  const dimensionLabel = goal.dimension === 'finance' ? '支出' : goal.dimension === 'mood' ? '心情' : ACTIVITY_DIMENSION_LABEL[goal.dimension as ActivityDimension] ?? goal.dimension
  return `${dimensionLabel}·${goal.metric}`
}

function periodLabel(period: GoalPayload['period']): string {
  return period === 'daily' ? '每天' : period === 'weekly' ? '每周' : '每月'
}

function fmtGoalValue(goal: GoalProgress): string {
  return goal.metric === 'expenseTotal' ? fmtMoney(goal.current) : String(Math.round(goal.current))
}

function fmtTarget(goal: GoalProgress): string {
  return goal.metric === 'expenseTotal' ? fmtMoney(goal.target) : String(goal.target)
}

function startOfYesterday(now: number): number {
  return periodStart('daily', now) - 24 * 3600 * 1000
}

function startOfDay(now: number): number {
  return periodStart('daily', now)
}
