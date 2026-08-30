/**
 * 提炼器（5.3）：夜间批量把采集原料提炼为结构化事件。
 *
 * 两阶段提取（4.3）的管线形态：LLM 出候选（record/none 决策），本模块做确定性
 * 校验（normalizeRecordArgs + schema）后落库——record → source: extraction 事件
 * （回链 captureId），none → 采集侧记账（不进事件日志）。
 * 幂等性：pending = 未回链且未记账的原料——崩溃重跑只处理剩余部分。
 *
 * @module openprism/distill
 */

import { randomEventId } from './store.js'
import type { EventStore } from './store.js'
import type { CaptureStore } from './captures.js'
import { foldEvents } from './fold.js'
import { normalizeRecordArgs } from './records.js'
import { describeRecord } from './corrections.js'
import type { OpenEvent, RecordKind } from './events.js'

export interface DistillLlmPort {
  complete(options: { provider: string; model: string; system: string; prompt: string; maxTokens: number }): Promise<string>
}

export interface DistillReport {
  ran: boolean
  reason?: 'no-pending' | 'no-route' | 'no-llm'
  processedCaptures: number
  recorded: number
  none: number
  invalid: number
}

const SYSTEM_PROMPT = [
  '你是个人生活记录提炼器。输入包含：已记录事件摘要（用于去重）与若干条待处理对话原文（每条以 #cap:<id> 开头）。',
  '只输出一个 JSON 数组，不要输出任何其他文字、解释或代码围栏。',
  '数组元素两种：',
  '{"action":"record","captureId":"<原样带回>","kind":"expense","payload":{"amount":正数,"category":"分类","note":"可选"},"occurredAt":"可选 ISO 时间"}',
  '{"action":"record","captureId":"<原样带回>","kind":"mood","payload":{"score":1到5整数,"note":"可选"}}',
  '{"action":"record","captureId":"<原样带回>","kind":"activity","payload":{"dimension":"life|work|family|study","category":"分类","durationMinutes":可选分钟数,"note":"可选"}}',
  '{"action":"none","captureId":"<原样带回>"}',
  '规则：只提炼明确的生活事实（花钱、心情、做了什么事）；寒暄、提问、闲聊、代码与技术讨论一律 none；',
  '事实已经出现在已记录事件摘要里 → none（不要重复记录）；金额/分数/分类不确定时宁可 none；不要编造。',
].join('\n')

export interface DistillDecision {
  action: 'record' | 'none'
  captureId?: string
  kind?: string
  payload?: Record<string, unknown>
  occurredAt?: string
}

/** 从模型输出中容错地取出第一个 JSON 数组（剥代码围栏/前后杂讯）。 */
export function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function distillPending(options: {
  store: EventStore
  captures: CaptureStore
  route?: { provider: string; model: string }
  llm?: DistillLlmPort
  batchSize?: number
  now?: number
}): Promise<DistillReport> {
  const { store, captures, route, llm } = options
  const now = options.now ?? Date.now()
  const batchSize = options.batchSize ?? 50

  const referenced = new Set(store.list().filter((e) => e.captureId !== undefined).map((e) => e.captureId as string))
  const pending = captures
    .list()
    .filter((c) => !referenced.has(c.id) && !captures.isProcessed(c.id))
    .sort((a, b) => a.recordedAt - b.recordedAt)
    .slice(0, batchSize)

  if (pending.length === 0) return { ran: false, reason: 'no-pending', processedCaptures: 0, recorded: 0, none: 0, invalid: 0 }
  if (route === undefined) return { ran: false, reason: 'no-route', processedCaptures: 0, recorded: 0, none: 0, invalid: 0 }
  if (llm === undefined) return { ran: false, reason: 'no-llm', processedCaptures: 0, recorded: 0, none: 0, invalid: 0 }

  const report: DistillReport = { ran: true, processedCaptures: pending.length, recorded: 0, none: 0, invalid: 0 }

  const state = foldEvents(store.list())
  const recentLines = state.records
    .filter((r) => !r.deleted && r.kind !== 'goal')
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 30)
    .map((r) => `- ${describeRecord(r)}`)
  const captureBlocks = pending.map((c) => {
    const iso = new Date(c.recordedAt).toISOString()
    const text = c.text.length > 500 ? `${c.text.slice(0, 500)}…` : c.text
    return `#cap:${c.id} [${iso}]\n${text}`
  })
  const prompt = [
    `今天是 ${new Date(now).toISOString().slice(0, 10)}。`,
    recentLines.length > 0 ? `已记录事件（最近，勿重复记录）：\n${recentLines.join('\n')}` : '已记录事件：无。',
    `待处理对话原文（${pending.length} 条）：\n${captureBlocks.join('\n---\n')}`,
  ].join('\n\n')

  let answer: string
  try {
    answer = await llm.complete({ provider: route.provider, model: route.model, system: SYSTEM_PROMPT, prompt, maxTokens: 2000 })
  } catch (error) {
    // LLM 失败不记账——原料留在 pending，下次重试（5.3 补跑语义）
    report.ran = false
    report.reason = 'no-llm'
    report.processedCaptures = 0
    console.warn(`openprism: 提炼 LLM 调用失败：${String(error)}`)
    return report
  }

  for (const decision of extractJsonArray(answer) as DistillDecision[]) {
    const captureRef = typeof decision?.captureId === 'string' ? decision.captureId : undefined
    const capture = captureRef !== undefined ? pending.find((c) => c.id === captureRef) : undefined
    if (capture === undefined) {
      report.invalid += 1
      continue
    }
    if (decision.action === 'none') {
      await captures.markProcessed(capture.id, 'none')
      report.none += 1
      continue
    }
    if (decision.action !== 'record') {
      report.invalid += 1
      continue
    }
    const kind = decision.kind as RecordKind
    if (kind !== 'expense' && kind !== 'mood' && kind !== 'activity') {
      report.invalid += 1
      continue
    }
    const normalized = normalizeRecordArgs(kind, {
      ...(decision.payload ?? {}),
      ...(decision.occurredAt !== undefined ? { occurredAt: decision.occurredAt } : {}),
    })
    if (!normalized.ok) {
      report.invalid += 1
      await captures.markProcessed(capture.id, 'invalid')
      continue
    }
    const event = {
      id: randomEventId('d'),
      kind,
      source: 'extraction',
      channel: capture.channel,
      sessionId: capture.sessionId,
      captureId: capture.id,
      recordedAt: now,
      ...(normalized.occurredAt !== undefined ? { occurredAt: normalized.occurredAt } : {}),
      payload: normalized.payload,
    } as OpenEvent
    await store.append(event)
    report.recorded += 1
  }
  return report
}
