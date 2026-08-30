/**
 * OpenPrism 事件折叠：全局事件日志 → 面板可用的当前状态（ADR 0002 的读路径）。
 *
 * - 记录事件 → FoldedRecord（occurredAt 缺省取 recordedAt，4.2）；
 * - correction → 按日志顺序应用到目标原始事件：后到者胜，原始事件永不改写（4.1）；
 * - category 事件 → 分类清单 + 改名链 + 删除墓碑；记录的 category 在解析时穿过改名链，
 *   被删分类的记录解析到兜底分类「其他」（v0.3 语义的仅追加版）；
 * - goal 事件与普通记录同构，是否生效（未被更正删除）由 deleted 表达（6.1）。
 * 纯函数，无 IO —— 天生可测。
 *
 * @module openprism/fold
 */

import type {
  ActivityPayload,
  CategoryPayload,
  ExpensePayload,
  GoalPayload,
  MoodPayload,
  OpenEvent,
  RecordPatch,
} from './events.js'
import type { CategoryDimension } from './types.js'
import { FALLBACK_CATEGORY } from './panel.js'

/** 折叠后的记录：payload 已应用全部 update 更正。 */
export interface FoldedRecord {
  id: string
  kind: 'expense' | 'mood' | 'activity' | 'goal'
  source: OpenEvent['source']
  channel?: OpenEvent['channel']
  sessionId?: string
  recordedAt: number
  occurredAt: number
  deleted: boolean
  payload: ExpensePayload | MoodPayload | ActivityPayload | GoalPayload
}

export type CategoryLists = Record<CategoryDimension, string[]>

export interface FoldedState {
  /** 日志顺序的记录（含 deleted=true 的墓碑记录；面板/统计层自行过滤）。 */
  records: FoldedRecord[]
  /** 各维度当前生效的分类清单（保证含兜底「其他」）。 */
  categories: CategoryLists
  /** 分类解析：穿过改名链；被删分类 → 「其他」。 */
  resolveCategory(dimension: CategoryDimension, name: string): string
}

const CATEGORY_DIMENSIONS: readonly CategoryDimension[] = ['finance', 'life', 'work', 'family', 'study']

function categoryKey(dimension: CategoryDimension, name: string): string {
  return `${dimension}\u0000${name}`
}

export function foldEvents(events: readonly OpenEvent[]): FoldedState {
  const records = new Map<string, FoldedRecord>()
  const order: string[] = []
  const createdCategories = new Map<string, number>()
  const renameMap = new Map<string, string>()
  const tombstones = new Set<string>()

  for (const event of events) {
    switch (event.kind) {
      case 'expense':
      case 'mood':
      case 'activity':
      case 'goal': {
        const record: FoldedRecord = {
          id: event.id,
          kind: event.kind,
          source: event.source,
          channel: event.channel,
          sessionId: event.sessionId,
          recordedAt: event.recordedAt,
          occurredAt: event.occurredAt ?? event.recordedAt,
          deleted: false,
          payload: event.payload,
        }
        if (!records.has(event.id)) order.push(event.id)
        records.set(event.id, record)
        break
      }
      case 'correction': {
        const target = records.get(event.payload.target)
        if (!target) break
        if (event.payload.op === 'delete') {
          target.deleted = true
        } else if (event.payload.patch) {
          applyPatch(target, event.payload.patch)
        }
        break
      }
      case 'category': {
        applyCategoryEvent(event.payload, createdCategories, renameMap, tombstones)
        break
      }
    }
  }

  const categories = buildCategoryLists(createdCategories, tombstones)

  return {
    records: order.map((id) => records.get(id)!),
    categories,
    resolveCategory(dimension, name) {
      let current = name
      for (let hop = 0; hop < 64; hop += 1) {
        const next = renameMap.get(categoryKey(dimension, current))
        if (next === undefined) break
        current = next
      }
      return tombstones.has(categoryKey(dimension, current)) ? FALLBACK_CATEGORY : current
    },
  }
}

function applyPatch(target: FoldedRecord, patch: RecordPatch): void {
  if (patch.occurredAt !== undefined && typeof patch.occurredAt === 'number' && Number.isFinite(patch.occurredAt)) {
    target.occurredAt = patch.occurredAt
  }
  const payload = target.payload as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'occurredAt') continue
    if (value !== undefined) payload[key] = value
  }
}

function applyCategoryEvent(
  payload: CategoryPayload,
  created: Map<string, number>,
  renameMap: Map<string, string>,
  tombstones: Set<string>,
): void {
  const key = categoryKey(payload.dimension, payload.name)
  if (payload.name === FALLBACK_CATEGORY && payload.op !== 'create') return
  if (payload.op === 'create') {
    tombstones.delete(key)
    created.set(key, created.get(key) ?? created.size)
    return
  }
  if (payload.op === 'rename') {
    if (payload.newName === undefined || payload.newName === payload.name) return
    created.delete(key)
    tombstones.delete(key)
    renameMap.set(key, payload.newName)
    const nextKey = categoryKey(payload.dimension, payload.newName)
    created.set(nextKey, created.get(key) ?? created.size)
    return
  }
  // delete：墓碑化；已创建的移出清单
  created.delete(key)
  tombstones.add(key)
}

function buildCategoryLists(
  created: Map<string, number>,
  tombstones: Set<string>,
): CategoryLists {
  const lists = { finance: [], life: [], work: [], family: [], study: [] } as CategoryLists
  const ordered = [...created.entries()].sort((a, b) => a[1] - b[1])
  for (const [key] of ordered) {
    const [dimension, name] = key.split('\u0000') as [CategoryDimension, string]
    if (tombstones.has(key)) continue
    if (!lists[dimension].includes(name)) lists[dimension].push(name)
  }
  for (const dimension of CATEGORY_DIMENSIONS) {
    if (!lists[dimension].includes(FALLBACK_CATEGORY)) lists[dimension].push(FALLBACK_CATEGORY)
  }
  return lists
}
