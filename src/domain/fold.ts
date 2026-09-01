/**
 * 折叠（ADR 0002/0003 + M8）：事件日志 → 有效记录 / 分类清单 / 活跃目标与进度。
 * 纯函数、确定性——同一输入永远同一输出，数据章节零 token 的根基。
 *
 * 规则：
 * - 更正：按文件顺序合并补丁，最后一条更正的 op 决定存亡（delete=废止）；
 * - 分类：add/rename/delete 按序折叠成改名映射，已有记录跟随迁移，删除归入兜底「其他」；
 * - 目标：按 key（维度|分类|聚合轴）后者覆盖前者；rolling 永远活跃，once 过窗即失效；
 * - 锚定日不参与完成判定（M8：偏好锚，非硬约束）。
 */

import type { CategoryDimension, Dimension, GoalPeriod } from './types'
import type { GoalEvent, OpenEvent, RecordEvent } from './events'
import { CATEGORY_DIMENSIONS } from './types'
import { dedupeById } from './events'

export interface ActiveGoal {
  event: GoalEvent
  key: string
  windowStart: number
  windowEnd: number
}

export interface GoalProgress {
  goal: ActiveGoal
  current: number
  /** amount 轴是上限（≤达标），count/minutes 是下限（≥达标）。 */
  met: boolean
}

export interface Folded {
  /** 更正生效后的记录（删除移除、补丁合并、分类按改名迁移解析）。 */
  records: RecordEvent[]
  categories: Record<CategoryDimension, string[]>
  goals: ActiveGoal[]
  goalProgress: GoalProgress[]
}

/** 本地时区日历窗口；week 以周一为一周之始。 */
export function periodWindow(period: GoalPeriod, at: number): { start: number; end: number } {
  const start = new Date(at)
  start.setHours(0, 0, 0, 0)
  switch (period) {
    case 'day':
      break
    case 'week':
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      break
    case 'month':
      start.setDate(1)
      break
    case 'year':
      start.setMonth(0, 1)
      break
  }
  const end = new Date(start)
  switch (period) {
    case 'day':
      end.setDate(end.getDate() + 1)
      break
    case 'week':
      end.setDate(end.getDate() + 7)
      break
    case 'month':
      end.setMonth(end.getMonth() + 1)
      break
    case 'year':
      end.setFullYear(end.getFullYear() + 1)
      break
  }
  return { start: start.getTime(), end: end.getTime() }
}

/** 目标覆盖键：同键后设覆盖先设。 */
export function goalKey(g: GoalEvent): string {
  return `${g.dimension}|${g.category ?? ''}|${g.aggregate}`
}

export function foldEvents(events: readonly OpenEvent[], now: number): Folded {
  const ordered = dedupeById(events)

  // ─── 更正（记录与目标皆可被更正；分类事件不支持更正） ───
  interface Mutable {
    event: RecordEvent | GoalEvent
    patch: Record<string, unknown>
    lastOp: 'update' | 'delete' | null
  }
  const mutables = new Map<string, Mutable>()
  for (const e of ordered) {
    if (e.kind === 'expense' || e.kind === 'mood' || e.kind === 'activity' || e.kind === 'goal') {
      mutables.set(e.id, { event: e, patch: {}, lastOp: null })
    }
  }
  for (const e of ordered) {
    if (e.kind !== 'correction') continue
    const m = mutables.get(e.target)
    if (!m) continue
    if (e.op === 'delete') {
      m.lastOp = 'delete'
    } else {
      Object.assign(m.patch, e.patch ?? {})
      m.lastOp = 'update'
    }
  }

  // ─── 分类时间线：改名映射 + 存活集合（「其他」为兜底，恒在） ───
  interface CatState {
    current: Map<string, string>
    alive: Set<string>
  }
  const cats = new Map<CategoryDimension, CatState>()
  for (const dim of CATEGORY_DIMENSIONS) cats.set(dim, { current: new Map(), alive: new Set(['其他']) })
  for (const e of ordered) {
    if (e.kind !== 'category') continue
    const st = cats.get(e.dimension)
    if (!st) continue
    if (e.op === 'add') {
      st.current.set(e.name, e.name)
      st.alive.add(e.name)
    } else if (e.op === 'rename') {
      if (!st.alive.has(e.name) || !e.newName) continue
      for (const [from, cur] of st.current) if (cur === e.name) st.current.set(from, e.newName)
      st.current.set(e.name, e.newName)
      st.alive.delete(e.name)
      st.alive.add(e.newName)
    } else {
      if (!st.alive.has(e.name)) continue
      for (const [from, cur] of st.current) if (cur === e.name) st.current.set(from, '其他')
      st.current.set(e.name, '其他')
      st.alive.delete(e.name)
    }
  }
  const resolveCategory = (dim: CategoryDimension, name: string): string =>
    cats.get(dim)?.current.get(name) ?? name

  // ─── 有效记录：补丁合并 + 分类迁移 ───
  const records: RecordEvent[] = []
  for (const m of mutables.values()) {
    if (m.lastOp === 'delete') continue
    if (m.event.kind === 'goal') continue
    records.push(applyPatch(m.event as RecordEvent, m.patch, resolveCategory))
  }
  // 记录引用了未见分类事件的分类（如导入数据）时，防御性并入清单
  for (const r of records) {
    if (r.kind === 'mood') continue
    const st = cats.get(r.dimension)
    if (st && !st.alive.has(r.category)) st.alive.add(r.category)
  }

  // ─── 活跃目标：同 key 后者覆盖；once 过窗失效 ───
  const goalsByKey = new Map<string, GoalEvent>()
  for (const m of mutables.values()) {
    if (m.event.kind !== 'goal' || m.lastOp === 'delete') continue
    const g = m.event as GoalEvent
    goalsByKey.set(goalKey(g), m.lastOp === 'update' ? (applyGoalPatch(g, m.patch) as GoalEvent) : g)
  }
  const goals: ActiveGoal[] = []
  for (const g of goalsByKey.values()) {
    if (g.repeat === 'once') {
      const anchor = g.windowStart ?? g.recordedAt
      const win = periodWindow(g.period, anchor)
      if (win.end <= now) continue
      goals.push({ event: g, key: goalKey(g), windowStart: win.start, windowEnd: win.end })
    } else {
      const win = periodWindow(g.period, now)
      goals.push({ event: g, key: goalKey(g), windowStart: win.start, windowEnd: win.end })
    }
  }

  // ─── 目标进度（按 occurredAt 落窗；锚定日不参与判定） ───
  const goalProgress: GoalProgress[] = goals.map((goal) => {
    const g = goal.event
    const inWindow = records.filter((r) => r.occurredAt >= goal.windowStart && r.occurredAt < goal.windowEnd)
    const scoped = inWindow.filter((r) => {
      if (g.dimension === 'mood') return r.kind === 'mood'
      if (r.kind === 'mood') return false
      if (r.dimension !== g.dimension) return false
      return !g.category || r.category === g.category
    })
    let current = 0
    if (g.aggregate === 'count') current = scoped.length
    else if (g.aggregate === 'amount') {
      for (const r of scoped) if (r.kind === 'expense') current += r.amount
    } else {
      for (const r of scoped) if (r.kind === 'activity') current += r.minutes ?? 0
    }
    const met = g.aggregate === 'amount' ? current <= g.target : current >= g.target
    return { goal, current, met }
  })

  const categories = {} as Record<CategoryDimension, string[]>
  for (const dim of CATEGORY_DIMENSIONS) {
    const st = cats.get(dim)!
    const list = [...st.alive].filter((n) => n !== '其他').sort((a, b) => a.localeCompare(b, 'zh'))
    if (st.alive.has('其他')) list.push('其他')
    categories[dim] = list
  }

  return { records, categories, goals, goalProgress }
}

const PATCHABLE = ['category', 'amount', 'score', 'minutes', 'note', 'occurredAt'] as const

function applyPatch(
  event: RecordEvent,
  patch: Record<string, unknown>,
  resolveCategory: (dim: CategoryDimension, name: string) => string,
): RecordEvent {
  const out = { ...event } as Record<string, unknown>
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) out[key] = patch[key]
  }
  if (out.kind !== 'mood' && typeof out.category === 'string') {
    const dim = (out.kind === 'expense' ? 'finance' : out.dimension) as CategoryDimension
    out.category = resolveCategory(dim, out.category)
  }
  return out as unknown as RecordEvent
}

function applyGoalPatch(goal: GoalEvent, patch: Record<string, unknown>): GoalEvent {
  const out = { ...goal } as Record<string, unknown>
  for (const key of ['category', 'target', 'period', 'repeat', 'anchorDays', 'followUpTime', 'note'] as const) {
    if (patch[key] !== undefined) out[key] = patch[key]
  }
  return out as unknown as GoalEvent
}

/** 维度显示序（面板与摘要共用）。 */
export const DIMENSION_ORDER: readonly Dimension[] = ['finance', 'mood', 'life', 'work', 'family', 'study']
