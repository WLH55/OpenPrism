/**
 * 模型面工具 ×6：record_expense / record_mood / record_activity / correct / set_goal / panel。
 * 工具执行直接落事件日志（source: conversation + sessionId 溯源）——镜像器机制已随宿主时代蒸发。
 * 校验失败以「错误：…」文本返回给模型自行纠正，不炸循环。
 */

import type { EventStore } from '../store/eventStore'
import type { ToolDefinition } from '../llm/client'
import {
  makeActivity,
  makeCategory,
  makeCorrection,
  makeExpense,
  makeGoal,
  makeMood,
  type ActivityEvent,
  type OpenEvent,
  type RecordEvent,
} from '../domain/events'
import { foldEvents } from '../domain/fold'
import { formatPanelSummary } from '../domain/panel'
import type { ActivityDimension, Aggregate, CategoryDimension, Dimension, GoalPeriod } from '../domain/types'
import { PERIOD_LABEL, WEEKDAY_LABEL } from '../domain/types'

export interface ToolContext {
  store: EventStore
  sessionId: string
  now(): number
  newId(): string
}

const DIMENSIONS = ['finance', 'mood', 'life', 'work', 'family', 'study'] as const
const ACTIVITY_DIMS = ['life', 'work', 'family', 'study'] as const

const occurredAtSchema = {
  type: 'string',
  description: '发生时间（ISO，如 2026-08-31 或 2026-08-31T20:00）。仅当用户明确提到时间时才传；不传=现在。',
}

function occurredAtField(): Record<string, unknown> {
  return { ...occurredAtSchema }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'openprism_record_expense',
    description: '记一笔支出。用户提到花钱、消费、买了什么时调用。',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '金额（元）' },
        category: { type: 'string', description: '分类——用户随口说的任何词（猫咪、买书、打车…），未知分类自动创建' },
        note: { type: 'string', description: '备注（可选）' },
        occurredAt: occurredAtField(),
      },
      required: ['amount', 'category'],
    },
  },
  {
    name: 'openprism_record_mood',
    description: '记一条心情。用户表达情绪、心情打分时调用。',
    parameters: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '心情分 1-10（10 最好）' },
        note: { type: 'string', description: '备注（可选）' },
        occurredAt: occurredAtField(),
      },
      required: ['score'],
    },
  },
  {
    name: 'openprism_record_activity',
    description: '记一条活动：生活/工作/家庭/学习维度做的事（运动、刷题、写作、家务、带娃…）。',
    parameters: {
      type: 'object',
      properties: {
        dimension: { type: 'string', enum: [...ACTIVITY_DIMS], description: '活动维度' },
        category: { type: 'string', description: '分类——用户随口说的任何词（撸猫、刷题、写文章…），未知分类自动创建' },
        minutes: { type: 'number', description: '时长（分钟，可选）' },
        note: { type: 'string', description: '备注（可选）' },
        occurredAt: occurredAtField(),
      },
      required: ['dimension', 'category'],
    },
  },
  {
    name: 'openprism_correct',
    description: '更正或删除既有记录（金额记错、分类不对、误删重录等）。可用 targetId 精确指定，或按 kind+dimension 匹配最近一条。',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: '目标记录 id（推荐，openprism_panel 的最近记录里有）' },
        kind: { type: 'string', enum: ['expense', 'mood', 'activity'], description: '按种类匹配最近记录（无 targetId 时）' },
        dimension: { type: 'string', description: '进一步限定维度（可选）' },
        noteContains: { type: 'string', description: '按备注关键词匹配（可选）' },
        op: { type: 'string', enum: ['update', 'delete'] },
        patch: {
          type: 'object',
          description: 'update 时要改的字段',
          properties: {
            amount: { type: 'number' },
            category: { type: 'string' },
            score: { type: 'integer' },
            minutes: { type: 'number' },
            note: { type: 'string' },
            occurredAt: { type: 'string', description: 'ISO 时间' },
          },
        },
      },
      required: ['op'],
    },
  },
  {
    name: 'openprism_set_goal',
    description:
      '设置目标/预算/惯例（组合式：维度×分类×聚合轴×数量×周期）。同维度+分类+聚合轴的后设覆盖先设。' +
      '例：每周运动三次→dimension:life, category:运动, aggregate:count, target:3, period:week, anchorDays:[3,5,6]；' +
      '月支出上限→dimension:finance, aggregate:amount, target:3000, period:month。',
    parameters: {
      type: 'object',
      properties: {
        dimension: { type: 'string', enum: [...DIMENSIONS] },
        category: { type: 'string', description: '限定到某分类（可选；不限则数整个维度）' },
        aggregate: { type: 'string', enum: ['count', 'amount', 'minutes'], description: 'count=次数(≥达标) / amount=金额上限(≤达标,配 finance) / minutes=时长(≥达标,配活动维度)' },
        target: { type: 'number', description: '目标数量' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        repeat: { type: 'string', enum: ['rolling', 'once'], description: 'rolling=每周期重复（默认）；once=单次窗口（如「这周内做完X」）' },
        anchorDays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '偏好日 0=周日…6=周六（可选，不影响完成判定）' },
        followUpTime: { type: 'string', description: '督导查岗时刻 HH:mm（可选；到点提醒汇报）' },
        note: { type: 'string', description: '备注（可选）' },
      },
      required: ['dimension', 'aggregate', 'target', 'period'],
    },
  },
  {
    name: 'openprism_panel',
    description: '查看六维度统计汇总：月合计、分类聚合、目标进度、可录分类、最近记录（含 id，供更正引用）。用户问数据/进度/总结时调用。',
    parameters: {
      type: 'object',
      properties: { dimension: { type: 'string', enum: [...DIMENSIONS], description: '只关心某维度时传（可选）' } },
    },
  },
]

export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<string> {
  try {
    const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
    switch (name) {
      case 'openprism_record_expense':
        return await recordExpense(args, ctx)
      case 'openprism_record_mood':
        return await recordMood(args, ctx)
      case 'openprism_record_activity':
        return await recordActivity(args, ctx)
      case 'openprism_correct':
        return await correct(args, ctx)
      case 'openprism_set_goal':
        return await setGoal(args, ctx)
      case 'openprism_panel':
        return formatPanelSummary(await freshFold(ctx), ctx.now())
      default:
        return `错误：未知工具 ${name}`
    }
  } catch (e) {
    return `错误：${e instanceof Error ? e.message : String(e)}`
  }
}

// ─── 各工具实现 ───

async function freshFold(ctx: ToolContext) {
  return foldEvents(await ctx.store.loadAll(), ctx.now())
}

function init(ctx: ToolContext) {
  return { id: ctx.newId(), recordedAt: ctx.now(), source: 'conversation' as const, sessionId: ctx.sessionId }
}

function internalInit(ctx: ToolContext) {
  return { id: ctx.newId(), recordedAt: ctx.now(), source: 'internal' as const }
}

function parseOccurredAt(v: unknown, now: number): number {
  if (v === undefined || v === null || v === '') return now
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number)
      return new Date(y, m - 1, d, 12, 0, 0).getTime() // 纯日期按本地正午，避免时区把日期挪走
    }
    const t = Date.parse(s)
    if (Number.isFinite(t)) return t
  }
  throw new Error(`occurredAt 无法解析：${String(v)}`)
}

function requireNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} 需为数字`)
  return v
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${what} 需为非空字符串`)
  return v
}

async function ensureCategory(dim: CategoryDimension, name: string, ctx: ToolContext, folded: Awaited<ReturnType<typeof freshFold>>): Promise<OpenEvent | null> {
  if (folded.categories[dim]?.includes(name)) return null
  return makeCategory(internalInit(ctx), { dimension: dim, op: 'add', name })
}

async function recordExpense(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const amount = requireNumber(args.amount, 'amount')
  if (amount <= 0) throw new Error('amount 需为正数')
  const category = requireString(args.category, 'category')
  const occurredAt = parseOccurredAt(args.occurredAt, ctx.now())
  const folded = await freshFold(ctx)
  const catEvent = await ensureCategory('finance', category, ctx, folded)
  if (catEvent) await ctx.store.append(catEvent)
  await ctx.store.append(
    makeExpense(init(ctx), { category, amount, note: str(args.note), occurredAt }),
  )
  const after = await freshFold(ctx)
  const month = after.records.filter((r) => r.kind === 'expense' && inMonth(r.occurredAt, ctx.now()))
  const total = month.reduce((s, r) => s + (r.kind === 'expense' ? r.amount : 0), 0)
  return `已记录：支出 ¥${amount} · ${category}（${fmtShort(occurredAt)}）。本月支出合计 ¥${Math.round(total)}（${month.length} 笔）。`
}

async function recordMood(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const score = args.score
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error('score 需为 1-10 整数')
  }
  const occurredAt = parseOccurredAt(args.occurredAt, ctx.now())
  await ctx.store.append(makeMood(init(ctx), { score, note: str(args.note), occurredAt }))
  const after = await freshFold(ctx)
  const month = after.records.filter((r) => r.kind === 'mood' && inMonth(r.occurredAt, ctx.now()))
  const avg = month.length ? (month.reduce((s, r) => s + (r.kind === 'mood' ? r.score : 0), 0) / month.length).toFixed(1) : '—'
  return `已记录：心情 ${score} 分（${fmtShort(occurredAt)}）。本月 ${month.length} 条 · 均值 ${avg}。`
}

async function recordActivity(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dimension = requireString(args.dimension, 'dimension') as ActivityDimension
  if (!(ACTIVITY_DIMS as readonly string[]).includes(dimension)) {
    throw new Error(`dimension 需为 ${ACTIVITY_DIMS.join('/')}`)
  }
  const category = requireString(args.category, 'category')
  const minutes = args.minutes === undefined ? undefined : requireNumber(args.minutes, 'minutes')
  const occurredAt = parseOccurredAt(args.occurredAt, ctx.now())
  const folded = await freshFold(ctx)
  const catEvent = await ensureCategory(dimension, category, ctx, folded)
  if (catEvent) await ctx.store.append(catEvent)
  await ctx.store.append(
    makeActivity(init(ctx), { dimension, category, minutes, note: str(args.note), occurredAt }),
  )
  const after = await freshFold(ctx)
  const month = after.records.filter(
    (r): r is ActivityEvent => r.kind === 'activity' && r.dimension === dimension && inMonth(r.occurredAt, ctx.now()),
  )
  const catCount = month.filter((r) => r.category === category).length
  const catMinutes = month.filter((r) => r.category === category).reduce((s, r) => s + (r.minutes ?? 0), 0)
  return `已记录：${category}${minutes ? ` ${minutes} 分钟` : ''} · ${dimension}（${fmtShort(occurredAt)}）。本月${category} ${catCount} 次${catMinutes ? ` / ${catMinutes} 分钟` : ''}。`
}

async function correct(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const op = args.op
  if (op !== 'update' && op !== 'delete') throw new Error('op 需为 update 或 delete')
  const folded = await freshFold(ctx)
  const target = findTarget(folded.records, args)
  if (!target) {
    throw new Error('没找到匹配的记录；可先调 openprism_panel 查最近记录的 id')
  }
  let patch: Record<string, unknown> | undefined
  if (op === 'update') {
    const raw = (args.patch ?? {}) as Record<string, unknown>
    patch = {}
    for (const key of ['amount', 'category', 'score', 'minutes', 'note'] as const) {
      if (raw[key] !== undefined) patch[key] = raw[key]
    }
    if (raw.occurredAt !== undefined) patch.occurredAt = parseOccurredAt(raw.occurredAt, ctx.now())
    if (Object.keys(patch).length === 0) throw new Error('update 需要 patch 里至少一个字段')
  }
  await ctx.store.append(makeCorrection(init(ctx), { target: target.id, op, patch, reason: str(args.reason) }))
  const title = recordBrief(target)
  return op === 'delete' ? `已删除：${title}。` : `已更正：${title} → ${describePatch(patch!)}。`
}

function findTarget(records: readonly RecordEvent[], args: Record<string, unknown>): RecordEvent | null {
  const targetId = strOrUndefined(args.targetId)
  if (targetId) {
    return records.find((r) => r.id === targetId) ?? null
  }
  const kind = strOrUndefined(args.kind)
  if (kind !== undefined && !['expense', 'mood', 'activity'].includes(kind)) return null
  const dimension = strOrUndefined(args.dimension)
  const noteContains = strOrUndefined(args.noteContains)
  const candidates = records.filter((r) => {
    if (kind !== undefined && r.kind !== kind) return false
    if (dimension !== undefined && r.dimension !== dimension) return false
    if (noteContains !== undefined && !(r.note ?? '').includes(noteContains)) return false
    return true
  })
  candidates.sort((a, b) => b.occurredAt - a.occurredAt)
  return candidates[0] ?? null
}

async function setGoal(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dimension = requireString(args.dimension, 'dimension') as Dimension
  if (!(DIMENSIONS as readonly string[]).includes(dimension)) throw new Error(`dimension 需为 ${DIMENSIONS.join('/')}`)
  const aggregate = requireString(args.aggregate, 'aggregate') as Aggregate
  if (!['count', 'amount', 'minutes'].includes(aggregate)) throw new Error('aggregate 需为 count/amount/minutes')
  if (aggregate === 'amount' && dimension !== 'finance') throw new Error('amount 轴只配合 finance 维度')
  if (aggregate === 'minutes' && dimension === 'finance') throw new Error('minutes 轴配合活动维度')
  if (dimension === 'mood' && aggregate !== 'count') throw new Error('情感维度只支持 count 轴')
  const target = requireNumber(args.target, 'target')
  if (target <= 0) throw new Error('target 需为正数')
  const period = requireString(args.period, 'period') as GoalPeriod
  if (!['day', 'week', 'month', 'year'].includes(period)) throw new Error('period 需为 day/week/month/year')
  const repeat = args.repeat === 'once' ? 'once' : 'rolling'
  const category = strOrUndefined(args.category)
  const anchorDays = normalizeAnchorDays(args.anchorDays)
  const followUpTime = strOrUndefined(args.followUpTime)
  if (followUpTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(followUpTime)) {
    throw new Error('followUpTime 需为 HH:mm')
  }
  const now = ctx.now()
  await ctx.store.append(
    makeGoal(init(ctx), {
      dimension,
      category,
      aggregate,
      target,
      period,
      repeat,
      anchorDays,
      followUpTime,
      note: str(args.note),
      windowStart: repeat === 'once' ? now : undefined,
    }),
  )
  const after = await freshFold(ctx)
  const gp = after.goalProgress.find((p) => {
    const g = p.goal.event
    return g.dimension === dimension && (g.category ?? '') === (category ?? '') && g.aggregate === aggregate
  })
  const unit = aggregate === 'amount' ? '元' : aggregate === 'minutes' ? '分钟' : '次'
  const cmp = aggregate === 'amount' ? '≤' : '≥'
  const anchors = anchorDays?.length ? `（偏好 ${anchorDays.map((d) => WEEKDAY_LABEL[d]).join('、')}）` : ''
  const progress = gp ? `当前进度 ${gp.current}/${target}${unit}` : ''
  return `目标已设：${dimension}${category ? `/${category}` : ''} ${PERIOD_LABEL[period]}${cmp}${target}${unit}${anchors}${repeat === 'once' ? ' · 单次' : ''}。${progress}`
}

// ─── 小工具 ───

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function normalizeAnchorDays(v: unknown): number[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('anchorDays 需为数组')
  const days = [...new Set(v.map(Number))].sort((a, b) => a - b)
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('anchorDays 需为 0-6 整数')
  return days
}

function inMonth(at: number, now: number): boolean {
  const d = new Date(at)
  const n = new Date(now)
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()
}

function fmtShort(at: number): string {
  const d = new Date(at)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function recordBrief(r: RecordEvent): string {
  switch (r.kind) {
    case 'expense':
      return `${fmtShort(r.occurredAt)} 支出 ¥${r.amount} ${r.category}`
    case 'mood':
      return `${fmtShort(r.occurredAt)} 心情 ${r.score} 分`
    case 'activity':
      return `${fmtShort(r.occurredAt)} ${r.category}${r.minutes ? ` ${r.minutes} 分钟` : ''}`
  }
}

function describePatch(patch: Record<string, unknown>): string {
  return Object.entries(patch)
    .map(([k, v]) => `${k}=${k === 'occurredAt' ? fmtShort(Number(v)) : String(v)}`)
    .join('，')
}
