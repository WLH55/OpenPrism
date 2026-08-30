/**
 * 录入工具参数的共享规范化：镜像器（解析会话日志里的模型原始参数）与
 * 工具 execute（模型面边界）必须产出**逐字节一致**的载荷——
 * 两者对同一 `callId` 派生同一个确定性事件 id，append 按 id 幂等，
 * 载荷不一致会造成先写者胜的静默偏差（3.1/4.1）。
 *
 * @module openprism/records
 */

import type { ActivityPayload, ExpensePayload, MoodPayload } from './events.js'
import { RECORD_PAYLOAD_SCHEMAS } from './events.js'

/** 模型面录入工具名 → 记录种类。 */
export const RECORD_TOOL_NAMES: Record<string, 'expense' | 'mood' | 'activity'> = {
  openprism_record_expense: 'expense',
  openprism_record_mood: 'mood',
  openprism_record_activity: 'activity',
}

export type RecordToolKind = 'expense' | 'mood' | 'activity'
export type NormalizedPayload = ExpensePayload | MoodPayload | ActivityPayload

export type NormalizeResult =
  | { ok: true; payload: NormalizedPayload; occurredAt?: number }
  | { ok: false; error: string }

/** 发生时间（4.2）：接受 Unix 毫秒或 ISO/日期字符串；缺省 undefined（折叠取 recordedAt）。 */
export function parseOccurredAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * 规范化 + 校验模型参数：字符串 trim；空 note 丢弃；occurredAt 单独解析
 * （不在 payload schema 内，zod 默认剥掉未知键）。
 */
export function normalizeRecordArgs(kind: RecordToolKind, raw: Record<string, unknown>): NormalizeResult {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    clean[key] = typeof value === 'string' ? value.trim() : value
  }
  if (clean.note === '') delete clean.note
  const occurredAt = parseOccurredAt(clean.occurredAt)
  delete clean.occurredAt
  delete clean.durationless // 防模型幻觉字段；zod 也会剥
  const result = RECORD_PAYLOAD_SCHEMAS[kind].safeParse(clean)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path?.join('.') ?? ''
    return { ok: false, error: `参数${where ? ` ${where}` : ''}无效：${issue?.message ?? '校验失败'}` }
  }
  return { ok: true, payload: result.data as NormalizedPayload, ...(occurredAt !== undefined ? { occurredAt } : {}) }
}
