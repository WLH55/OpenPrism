/**
 * OpenPrism 全局事件日志的事件信封与载荷（v0.4）。
 *
 * 领域规则（docs/design/2026-08-feature-design.md）：
 * - 事件仅追加，不原地修改；纠错 = 追加 correction 事件（4.1）；
 * - 每条事件带来源 source（机制轴：mirror/ui/internal/extraction/rule，3.3）与
 *   可选渠道 channel（入口轴：chat/wechat/form，Q8）；
 * - occurredAt（发生时间，缺省折叠时取 recordedAt）/ recordedAt（录入时间）双时间（4.2）；
 * - mirror 事件的 id 必须确定性派生，rebuild 后不变（4.1）；
 * - store.append 按 id 幂等，镜像器与工具执行竞态安全（3.1/5.1）。
 *
 * 本模块不 import 任何 dsh 包——领域层可独立测试。
 *
 * @module openprism/events
 */

import { z } from 'zod'
import type { ActivityDimension, CategoryDimension } from './types.js'

/** 事件来源（机制轴）。 */
export type EventSource = 'mirror' | 'ui' | 'internal' | 'extraction' | 'rule'

/** 事件入口渠道（渠道轴）。 */
export type Channel = 'chat' | 'wechat' | 'form'

/** 目标可对的聚合指标（必须能从事件折叠得出）。 */
export type GoalMetric = 'expenseTotal' | 'activityDuration' | 'activityCount' | 'moodCount'

export type GoalPeriod = 'daily' | 'weekly' | 'monthly'

export interface ExpensePayload {
  amount: number
  category: string
  note?: string
}

export interface MoodPayload {
  score: number
  note?: string
}

export interface ActivityPayload {
  dimension: ActivityDimension
  category: string
  durationMinutes?: number
  note?: string
}

export interface GoalPayload {
  dimension: CategoryDimension | 'mood'
  metric: GoalMetric
  target: number
  period: GoalPeriod
  note?: string
}

export interface CategoryPayload {
  op: 'create' | 'rename' | 'delete'
  dimension: CategoryDimension
  name: string
  /** op=rename 时的目标名。 */
  newName?: string
}

/** 更正载荷：target 永远指向原始事件 id；后到的更正生效（4.1）。 */
export interface CorrectionPayload {
  target: string
  op: 'update' | 'delete'
  patch?: RecordPatch
}

/** update 更正允许改动的字段（occurredAt 允许修正发生时间）。 */
export type RecordPatch = Partial<
  ExpensePayload & MoodPayload & ActivityPayload & GoalPayload
> & { occurredAt?: number }

export type RecordKind = 'expense' | 'mood' | 'activity' | 'goal'
export type EventKind = RecordKind | 'category' | 'correction'

interface BaseEvent {
  id: string
  source: EventSource
  channel?: Channel
  sessionId?: string
  recordedAt: number
  occurredAt?: number
  /** 提炼产出时回链的采集原料 id（5.1；mirror/ui/internal 事件没有）。 */
  captureId?: string
}

export type OpenEvent = BaseEvent &
  (
    | { kind: 'expense'; payload: ExpensePayload }
    | { kind: 'mood'; payload: MoodPayload }
    | { kind: 'activity'; payload: ActivityPayload }
    | { kind: 'goal'; payload: GoalPayload }
    | { kind: 'category'; payload: CategoryPayload }
    | { kind: 'correction'; payload: CorrectionPayload }
  )

// ─── 载荷校验（append 边界校验；模型产出/外部输入都从这里过） ───

const expenseSchema = z.object({ amount: z.number().finite().positive(), category: z.string().min(1), note: z.string().optional() })
const moodSchema = z.object({ score: z.number().int().min(1).max(5), note: z.string().optional() })
const activitySchema = z.object({
  dimension: z.enum(['life', 'work', 'family', 'study']),
  category: z.string().min(1),
  durationMinutes: z.number().positive().optional(),
  note: z.string().optional(),
})
const goalSchema = z.object({
  dimension: z.enum(['finance', 'life', 'work', 'family', 'study', 'mood']),
  metric: z.enum(['expenseTotal', 'activityDuration', 'activityCount', 'moodCount']),
  target: z.number().finite().positive(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  note: z.string().optional(),
})
const categorySchema = z.object({
  op: z.enum(['create', 'rename', 'delete']),
  dimension: z.enum(['finance', 'life', 'work', 'family', 'study']),
  name: z.string().min(1),
  newName: z.string().min(1).optional(),
})
const correctionSchema = z.object({
  target: z.string().min(1),
  op: z.enum(['update', 'delete']),
  patch: z.record(z.string(), z.unknown()).optional(),
})

const PAYLOAD_SCHEMAS = {
  expense: expenseSchema,
  mood: moodSchema,
  activity: activitySchema,
  goal: goalSchema,
  category: categorySchema,
  correction: correctionSchema,
} as const

/** 录入记录的载荷 schema（镜像器与工具执行共用同一校验，见 records.ts）。 */
export const RECORD_PAYLOAD_SCHEMAS = {
  expense: expenseSchema,
  mood: moodSchema,
  activity: activitySchema,
} as const

const EVENT_SOURCE_VALUES: readonly EventSource[] = ['mirror', 'ui', 'internal', 'extraction', 'rule']
const CHANNEL_VALUES: readonly Channel[] = ['chat', 'wechat', 'form']

/** append 边界校验；返回错误文本，合法时返回 null。 */
export function validateEvent(event: OpenEvent): string | null {
  if (typeof event.id !== 'string' || event.id.length === 0) return 'id 必须是非空字符串'
  if (!EVENT_SOURCE_VALUES.includes(event.source)) return `source 非法：${String(event.source)}`
  if (event.channel !== undefined && !CHANNEL_VALUES.includes(event.channel)) return `channel 非法：${String(event.channel)}`
  if (typeof event.recordedAt !== 'number' || !Number.isFinite(event.recordedAt)) return 'recordedAt 必须是数字'
  if (event.occurredAt !== undefined && (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt))) {
    return 'occurredAt 必须是数字'
  }
  if (event.captureId !== undefined && (typeof event.captureId !== 'string' || event.captureId.length === 0)) {
    return 'captureId 必须是非空字符串'
  }
  if (event.kind === 'correction' && event.payload.op === 'update' && (event.payload.patch === undefined || Object.keys(event.payload.patch).length === 0)) {
    return 'update 更正必须带 patch'
  }
  const schema = PAYLOAD_SCHEMAS[event.kind]
  if (!schema) return `kind 非法：${String(event.kind)}`
  const result = schema.safeParse(event.payload)
  return result.success ? null : `payload 校验失败：${result.error.issues[0]?.message ?? 'unknown'}`
}
