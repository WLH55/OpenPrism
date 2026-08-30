/**
 * 更正回路（4.1）：定位目标记录 + 校验补丁 + 落库更正事件。
 *
 * 落库主体：工具 execute（source: internal）与 UI 端点（source: ui）直接追加；
 * rebuild 重放会话日志里的 openprism_correct 调用走同一条 applyCorrection
 * （对已应用语义幂等：delete 重复定位会被墓碑拒绝，update 重复同补丁无副作用）。
 * 更正事件引用的原始记录 id 是确定性的（mirrorEventId），与在线/重建无关。
 *
 * @module openprism/corrections
 */

import type { ActivityPayload, CorrectionPayload, OpenEvent, RecordPatch } from './events.js'
import { RECORD_PAYLOAD_SCHEMAS } from './events.js'
import { randomEventId } from './store.js'
import type { EventStore } from './store.js'
import { parseOccurredAt } from './records.js'
import { foldEvents, type FoldedRecord, type FoldedState } from './fold.js'
import type { ActivityDimension } from './types.js'

export type RecordKind = 'expense' | 'mood' | 'activity'

export interface CorrectionRequest {
  /** 目标事件 id；缺省时按 kind（+可选 dimension）定位最近一条。 */
  target?: string
  op: 'update' | 'delete'
  kind?: RecordKind
  dimension?: ActivityDimension
  /** update 的补丁字段（按目标记录的 kind 校验）；delete 时忽略。 */
  patch?: RecordPatch
}

export type LocateResult =
  | { ok: true; id: string; record: FoldedRecord }
  | { ok: false; error: string }

/** 定位要更正的原始记录：优先显式 target，否则取「最近一条匹配」。 */
export function locateTarget(state: FoldedState, req: CorrectionRequest): LocateResult {
  if (req.target !== undefined && req.target.length > 0) {
    const record = state.records.find((r) => r.id === req.target)
    if (!record) return { ok: false, error: `找不到事件 ${req.target}（用 openprism_panel 查看最近记录的 id）` }
    if (record.kind === 'goal') return { ok: false, error: `事件 ${req.target} 是目标而非记录` }
    if (record.deleted) return { ok: false, error: `事件 ${req.target} 已被删除` }
    return { ok: true, id: record.id, record }
  }
  if (!req.kind) return { ok: false, error: '未提供 target 时必须提供 kind（expense / mood / activity）' }

  const candidates = state.records.filter((r) => {
    if (r.deleted || r.kind !== req.kind) return false
    if (req.kind === 'activity' && req.dimension && (r.payload as ActivityPayload).dimension !== req.dimension) return false
    return true
  })
  if (candidates.length === 0) {
    return { ok: false, error: `最近没有匹配的${kindLabel(req.kind)}记录（可先用 openprism_panel 查看记录与 id）` }
  }
  // 「最近」按发生时间（4.2），同刻按日志顺序取后到者
  const latest = candidates.reduce((a, b) => (b.occurredAt >= a.occurredAt ? b : a))
  return { ok: true, id: latest.id, record: latest }
}

function kindLabel(kind: RecordKind): string {
  return kind === 'expense' ? '支出' : kind === 'mood' ? '心情' : '活动'
}

/** update 补丁按目标记录的 kind 做部分校验；返回错误文本，合法返回 null。 */
export function validatePatch(kind: RecordKind, patch: RecordPatch | undefined): string | null {
  if (patch === undefined || Object.keys(patch).length === 0) return 'update 更正必须至少提供一个要修改的字段'
  const schema = RECORD_PAYLOAD_SCHEMAS[kind].partial()
  const result = schema.safeParse(stripUndefined(patch as Record<string, unknown>))
  return result.success ? null : `补丁无效：${result.error.issues[0]?.message ?? '校验失败'}`
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out
}

/** 归一化 openprism_correct / UI 端点的原始参数；出错返回 { error }。
 *  字段语义：kind/dimension 用于定位（无 target 时），其余字段（amount/score/
 *  category/note/durationMinutes/occurredAt）是 update 的补丁值。 */
export function parseCorrectionRequest(raw: Record<string, unknown>): CorrectionRequest | { error: string } {
  const op = raw.op
  if (op !== 'update' && op !== 'delete') return { error: 'op 必须是 update / delete' }
  const kind = typeof raw.kind === 'string' && raw.kind.length > 0 ? raw.kind as RecordKind : undefined
  if (kind !== undefined && !(kind in RECORD_PAYLOAD_SCHEMAS)) {
    return { error: `kind 必须是 expense / mood / activity，收到 ${String(raw.kind)}` }
  }
  const dimension = typeof raw.dimension === 'string' && raw.dimension.length > 0 ? raw.dimension as ActivityDimension : undefined
  const target = typeof raw.target === 'string' && raw.target.trim().length > 0 ? raw.target.trim() : undefined
  const patch: RecordPatch = {}
  if (op === 'update') {
    for (const key of ['amount', 'score', 'category', 'note', 'durationMinutes'] as const) {
      if (raw[key] !== undefined) (patch as Record<string, unknown>)[key] = raw[key]
    }
    const occurredAt = parseOccurredAt(raw.occurredAt)
    if (occurredAt !== undefined) (patch as Record<string, unknown>).occurredAt = occurredAt
    if (target === undefined && kind === undefined) return { error: '未提供 target 时必须提供 kind' }
  }
  return {
    op,
    ...(target !== undefined ? { target } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(dimension !== undefined ? { dimension } : {}),
    ...(op === 'update' ? { patch } : {}),
  }
}

export interface CorrectionApplyResult {
  op: 'update' | 'delete'
  target: string
  record: FoldedRecord
}

/**
 * 校验 + 定位 + 落库一条更正事件。失败抛 Error（工具边界转 tool/result 错误，
 * UI 端点转 HTTP 400）。record 返回的是更正前的原始记录（供结果文案）。
 */
export async function applyCorrection(
  store: EventStore,
  req: CorrectionRequest,
  meta: { source: 'internal' | 'ui'; sessionId?: string; recordedAt?: number },
): Promise<CorrectionApplyResult> {
  // kind 路径的补丁校验前移（目标 kind 已知；target 路径在定位后按记录 kind 校验）
  if (req.op === 'update' && req.target === undefined && req.kind !== undefined) {
    const early = validatePatch(req.kind, req.patch)
    if (early) throw new Error(`openprism: ${early}`)
  }
  const state = foldEvents(store.list())
  const located = locateTarget(state, req)
  if (!located.ok) throw new Error(`openprism: ${located.error}`)
  if (req.op === 'update') {
    const patchError = validatePatch(kindOf(located.record), req.patch)
    if (patchError) throw new Error(`openprism: ${patchError}`)
  }
  const payload: CorrectionPayload = {
    target: located.id,
    op: req.op,
    ...(req.op === 'update' ? { patch: req.patch } : {}),
  }
  await store.append({
    id: randomEventId('x'),
    kind: 'correction',
    source: meta.source,
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    recordedAt: meta.recordedAt ?? Date.now(),
    payload,
  } as OpenEvent)
  return { op: req.op, target: located.id, record: located.record }
}

function kindOf(record: FoldedRecord): RecordKind {
  if (record.kind === 'goal') throw new Error('openprism: 目标不支持该更正')
  return record.kind
}

/** 描述一条记录（工具结果/UI 文案共用）。 */
export function describeRecord(record: FoldedRecord): string {
  const date = new Date(record.occurredAt)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  switch (record.kind) {
    case 'expense': {
      const p = record.payload as import('./events.js').ExpensePayload
      return `支出 ¥${p.amount.toFixed(2)}（${p.category}${p.note !== undefined ? `·${p.note}` : ''}）@ ${stamp}`
    }
    case 'mood': {
      const p = record.payload as import('./events.js').MoodPayload
      return `心情 ${p.score}/5${p.note !== undefined ? `·${p.note}` : ''} @ ${stamp}`
    }
    case 'activity': {
      const p = record.payload as import('./events.js').ActivityPayload
      const minutes = p.durationMinutes !== undefined ? ` ${p.durationMinutes}分钟` : ''
      return `${p.dimension}·${p.category}${minutes}${p.note !== undefined ? `·${p.note}` : ''} @ ${stamp}`
    }
    case 'goal':
      return '目标'
  }
}
