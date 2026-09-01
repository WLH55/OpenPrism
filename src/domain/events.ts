/**
 * 事件模型（ADR 0002/0003 规格，移动端重写）：六种事件、工厂、加载校验与容错解析。
 * 仅追加、按 id 幂等；一切事件带双时间戳（occurredAt 发生时间 / recordedAt 录入时间）。
 */

import type {
  ActivityDimension,
  Aggregate,
  CategoryDimension,
  Dimension,
  EventSource,
  GoalPeriod,
  GoalRepeat,
} from './types'

export interface EventBase {
  id: string
  recordedAt: number
  source: EventSource
  /** 对话来源事件的溯源会话。 */
  sessionId?: string
}

export interface ExpenseEvent extends EventBase {
  kind: 'expense'
  dimension: 'finance'
  category: string
  amount: number
  note?: string
  occurredAt: number
}

export interface MoodEvent extends EventBase {
  kind: 'mood'
  dimension: 'mood'
  score: number
  note?: string
  occurredAt: number
}

export interface ActivityEvent extends EventBase {
  kind: 'activity'
  dimension: ActivityDimension
  category: string
  minutes?: number
  note?: string
  occurredAt: number
}

/** 更正：指向既有事件，update=合并补丁 / delete=废止；原始事件永不改写，最后一条更正生效。 */
export interface CorrectionEvent extends EventBase {
  kind: 'correction'
  target: string
  op: 'update' | 'delete'
  patch?: Record<string, unknown>
  reason?: string
}

export interface CategoryEvent extends EventBase {
  kind: 'category'
  dimension: CategoryDimension
  op: 'add' | 'rename' | 'delete'
  name: string
  /** rename 的新名字。 */
  newName?: string
}

/** 目标（M8 组合式指标）：维度 × 分类（可选）× 聚合轴 × 数量 × 周期；重设即按 key 覆盖。 */
export interface GoalEvent extends EventBase {
  kind: 'goal'
  dimension: Dimension
  category?: string
  aggregate: Aggregate
  target: number
  period: GoalPeriod
  repeat: GoalRepeat
  /** 锚定日（0=周日 … 6=周六）：督导时机与意图锚，不构成硬约束。 */
  anchorDays?: number[]
  /** 督导查岗时刻（HH:mm）；批次 3 生效。 */
  followUpTime?: string
  note?: string
  /** 单次目标的窗口锚点；缺省取录入时刻所在周期窗口。 */
  windowStart?: number
}

export type RecordEvent = ExpenseEvent | MoodEvent | ActivityEvent
export type OpenEvent = RecordEvent | CorrectionEvent | CategoryEvent | GoalEvent

export const RECORD_KINDS = ['expense', 'mood', 'activity'] as const
export const EVENT_KINDS = [...RECORD_KINDS, 'correction', 'category', 'goal'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

// ─── 工厂（id 与时间由调用方注入，保持领域层无平台依赖） ───

export interface EventInit {
  id: string
  recordedAt: number
  source: EventSource
  sessionId?: string
}

export function makeExpense(init: EventInit, input: Omit<ExpenseEvent, keyof EventBase | 'kind' | 'dimension'>): ExpenseEvent {
  return { kind: 'expense', dimension: 'finance', ...init, ...stripUndefined(input) }
}

export function makeMood(init: EventInit, input: Omit<MoodEvent, keyof EventBase | 'kind' | 'dimension'>): MoodEvent {
  return { kind: 'mood', dimension: 'mood', ...init, ...stripUndefined(input) }
}

export function makeActivity(
  init: EventInit,
  input: Omit<ActivityEvent, keyof EventBase | 'kind'>,
): ActivityEvent {
  return { kind: 'activity', ...init, ...stripUndefined(input) }
}

export function makeCorrection(
  init: EventInit,
  input: Omit<CorrectionEvent, keyof EventBase | 'kind'>,
): CorrectionEvent {
  return { kind: 'correction', ...init, ...stripUndefined(input) }
}

export function makeCategory(
  init: EventInit,
  input: Omit<CategoryEvent, keyof EventBase | 'kind'>,
): CategoryEvent {
  return { kind: 'category', ...init, ...stripUndefined(input) }
}

export function makeGoal(init: EventInit, input: Omit<GoalEvent, keyof EventBase | 'kind'>): GoalEvent {
  return { kind: 'goal', ...init, ...stripUndefined(input) }
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v
  return out as T
}

// ─── 加载校验与容错解析（撕裂尾行容忍，M3） ───

const SOURCES = ['conversation', 'ui', 'internal'] as const
const AGGREGATES = ['count', 'amount', 'minutes'] as const
const GOAL_PERIODS = ['day', 'week', 'month', 'year'] as const
const GOAL_REPEATS = ['rolling', 'once'] as const

/** 校验单个事件的形状；不合法抛 Error（消息含原因）。 */
export function validateEvent(raw: unknown): OpenEvent {
  if (typeof raw !== 'object' || raw === null) throw new Error('事件不是对象')
  const e = raw as Record<string, unknown>
  const kind = e.kind
  if (typeof kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`未知事件种类：${String(kind)}`)
  }
  if (typeof e.id !== 'string' || !e.id) throw new Error('事件缺少 id')
  if (typeof e.recordedAt !== 'number' || !Number.isFinite(e.recordedAt) || e.recordedAt <= 0) {
    throw new Error('recordedAt 非法')
  }
  if (typeof e.source !== 'string' || !(SOURCES as readonly string[]).includes(e.source)) {
    throw new Error(`未知来源：${String(e.source)}`)
  }
  switch (kind) {
    case 'expense':
      requireString(e.category, 'category')
      requireNumber(e.amount, 'amount', 0)
      requireTimestamp(e.occurredAt)
      return e as unknown as ExpenseEvent
    case 'mood':
      if (typeof e.score !== 'number' || !Number.isInteger(e.score) || e.score < 1 || e.score > 10) {
        throw new Error('心情分需为 1-10 整数')
      }
      requireTimestamp(e.occurredAt)
      return e as unknown as MoodEvent
    case 'activity':
      if (!(ACTIVITY_DIMENSION_VALUES as readonly string[]).includes(String(e.dimension))) {
        throw new Error(`活动维度非法：${String(e.dimension)}`)
      }
      requireString(e.category, 'category')
      if (e.minutes !== undefined) requireNumber(e.minutes, 'minutes', 0)
      requireTimestamp(e.occurredAt)
      return e as unknown as ActivityEvent
    case 'correction': {
      requireString(e.target, 'target')
      if (e.op !== 'update' && e.op !== 'delete') throw new Error(`更正操作非法：${String(e.op)}`)
      return e as unknown as CorrectionEvent
    }
    case 'category': {
      if (!(CATEGORY_DIMENSION_VALUES as readonly string[]).includes(String(e.dimension))) {
        throw new Error(`分类维度非法：${String(e.dimension)}`)
      }
      if (e.op !== 'add' && e.op !== 'rename' && e.op !== 'delete') throw new Error(`分类操作非法：${String(e.op)}`)
      requireString(e.name, 'name')
      if (e.op === 'rename' && typeof e.newName !== 'string') throw new Error('rename 需要 newName')
      return e as unknown as CategoryEvent
    }
    case 'goal': {
      if (!(DIMENSION_VALUES as readonly string[]).includes(String(e.dimension))) {
        throw new Error(`目标维度非法：${String(e.dimension)}`)
      }
      if (!(AGGREGATES as readonly string[]).includes(String(e.aggregate))) throw new Error('目标聚合轴非法')
      if (!(GOAL_PERIODS as readonly string[]).includes(String(e.period))) throw new Error('目标周期非法')
      if (!(GOAL_REPEATS as readonly string[]).includes(String(e.repeat))) throw new Error('目标重复方式非法')
      requireNumber(e.target, 'target', 0)
      if (e.anchorDays !== undefined) {
        if (!Array.isArray(e.anchorDays)) throw new Error('anchorDays 需为数组')
        for (const d of e.anchorDays) if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
          throw new Error('anchorDays 需为 0-6 整数')
        }
      }
      if (e.followUpTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(e.followUpTime))) {
        throw new Error('followUpTime 需为 HH:mm')
      }
      return e as unknown as GoalEvent
    }
  }
  // switch 对六种 kind 穷尽；此行只为满足类型检查
  throw new Error(`未知事件种类：${String(kind)}`)
}

const ACTIVITY_DIMENSION_VALUES = ['life', 'work', 'family', 'study']
const CATEGORY_DIMENSION_VALUES = ['finance', 'life', 'work', 'family', 'study']
const DIMENSION_VALUES = ['finance', 'mood', 'life', 'work', 'family', 'study']

function requireString(v: unknown, name: string): void {
  if (typeof v !== 'string' || !v) throw new Error(`${name} 需为非空字符串`)
}

function requireNumber(v: unknown, name: string, min: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`${name} 需为 ≥${min} 的数字`)
}

function requireTimestamp(v: unknown): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error('occurredAt 非法')
}

export interface ParsedLog {
  events: OpenEvent[]
  /** 中部损坏被跳过的行数。 */
  skippedLines: number
  /** 末行撕裂（写入中途被杀）——加载方应丢弃并重写文件。 */
  tornTail: boolean
}

/** 解析 JSONL 文本；末行不完整视为撕裂尾行，中部坏行跳过。 */
export function parseEvents(text: string): ParsedLog {
  const lines = text.split('\n')
  const events: OpenEvent[] = []
  let skippedLines = 0
  let tornTail = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      events.push(validateEvent(JSON.parse(line)))
    } catch {
      if (i === lines.length - 1) tornTail = true
      else skippedLines += 1
    }
  }
  return { events, skippedLines, tornTail }
}

/** 按 id 幂等：同 id 重复追加只保留首见（事件内容应相同）。 */
export function dedupeById(events: readonly OpenEvent[]): OpenEvent[] {
  const seen = new Set<string>()
  const out: OpenEvent[] = []
  for (const e of events) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}
