import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/fold.js'
import type { OpenEvent } from '../src/events.js'

let seq = 0
function baseEvent(overrides: Partial<OpenEvent> & Pick<OpenEvent, 'kind' | 'payload'>): OpenEvent {
  seq += 1
  return {
    id: `ev-${seq}`,
    source: 'mirror',
    sessionId: 's1',
    recordedAt: 1725000000000 + seq * 1000,
    ...overrides,
  } as OpenEvent

}

describe('foldEvents 记录与更正', () => {
  it('occurredAt 缺省取 recordedAt（4.2）', () => {
    const state = foldEvents([baseEvent({ kind: 'expense', payload: { amount: 35, category: '餐饮' } })])
    const record = state.records[0]
    expect(record.occurredAt).toBe(record.recordedAt)
  })

  it('update 更正合并 patch（含 occurredAt 修正），后到者胜（4.1）', () => {
    const original = baseEvent({ id: 'rec-1', kind: 'expense', payload: { amount: 35, category: '餐饮' } })
    const fix1 = baseEvent({ kind: 'correction', payload: { target: 'rec-1', op: 'update', patch: { amount: 25 } } })
    const fix2 = baseEvent({ kind: 'correction', payload: { target: 'rec-1', op: 'update', patch: { amount: 28, occurredAt: 1724900000000 } } })
    const state = foldEvents([original, fix1, fix2])
    const record = state.records.find((r) => r.id === 'rec-1')!
    expect(record.payload).toMatchObject({ amount: 28, category: '餐饮' })
    expect(record.occurredAt).toBe(1724900000000)
    expect(record.deleted).toBe(false)
  })

  it('delete 更正标记墓碑，原始事件保留在日志里', () => {
    const original = baseEvent({ id: 'rec-2', kind: 'mood', payload: { score: 2 } })
    const del = baseEvent({ kind: 'correction', payload: { target: 'rec-2', op: 'delete' } })
    const state = foldEvents([original, del])
    expect(state.records).toHaveLength(1)
    expect(state.records[0].deleted).toBe(true)
  })

  it('指向不存在目标的更正被忽略', () => {
    const state = foldEvents([baseEvent({ kind: 'correction', payload: { target: 'nope', op: 'delete' } })])
    expect(state.records).toHaveLength(0)
  })

  it('goal 记录与普通记录同构，可被更正（6.1）', () => {
    const goal = baseEvent({ kind: 'goal', payload: { dimension: 'finance', metric: 'expenseTotal', target: 2000, period: 'monthly' } })
    const fix = baseEvent({ kind: 'correction', payload: { target: goal.id, op: 'update', patch: { target: 1500 } } })
    const state = foldEvents([goal, fix])
    expect(state.records[0].payload).toMatchObject({ target: 1500 })
  })
})

describe('foldEvents 分类', () => {
  it('create/rename/delete：清单、改名链、墓碑解析到「其他」', () => {
    const events = [
      baseEvent({ kind: 'category', payload: { op: 'create', dimension: 'finance', name: '餐饮' } }),
      baseEvent({ kind: 'category', payload: { op: 'create', dimension: 'finance', name: '吃饭' } }),
      baseEvent({ kind: 'category', payload: { op: 'create', dimension: 'finance', name: '猫咪' } }),
      baseEvent({ kind: 'expense', payload: { amount: 35, category: '吃饭' } }),
      baseEvent({ kind: 'category', payload: { op: 'rename', dimension: 'finance', name: '吃饭', newName: '餐饮' } }),
      baseEvent({ kind: 'category', payload: { op: 'delete', dimension: 'finance', name: '猫咪' } }),
    ]
    const state = foldEvents(events)
    expect(state.categories.finance).toContain('餐饮')
    expect(state.categories.finance).not.toContain('吃饭')
    expect(state.categories.finance).not.toContain('猫咪')
    expect(state.categories.finance).toContain('其他')
    // 记录的 category 穿过改名链：吃饭 → 餐饮
    expect(state.resolveCategory('finance', '吃饭')).toBe('餐饮')
    // 被删分类的记录解析到兜底
    expect(state.resolveCategory('finance', '猫咪')).toBe('其他')
  })

  it('每个维度永远保留兜底「其他」', () => {
    const state = foldEvents([])
    for (const dim of ['finance', 'life', 'work', 'family', 'study'] as const) {
      expect(state.categories[dim]).toContain('其他')
    }
  })

  it('删除后重建同名分类（墓碑解除）', () => {
    const events = [
      baseEvent({ kind: 'category', payload: { op: 'create', dimension: 'life', name: '跑步' } }),
      baseEvent({ kind: 'category', payload: { op: 'delete', dimension: 'life', name: '跑步' } }),
      baseEvent({ kind: 'category', payload: { op: 'create', dimension: 'life', name: '跑步' } }),
    ]
    const state = foldEvents(events)
    expect(state.categories.life).toContain('跑步')
    expect(state.resolveCategory('life', '跑步')).toBe('跑步')
  })
})
