import { describe, expect, it } from 'vitest'
import {
  makeActivity,
  makeCategory,
  makeCorrection,
  makeExpense,
  makeGoal,
  makeMood,
  type OpenEvent,
} from '../src/domain/events'
import { foldEvents } from '../src/domain/fold'

/** 本地时区的定值时间（测试与日历窗口语义一致，不依赖跑测试的时区）。 */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

let seq = 0
function init(recordedAt: number) {
  seq += 1
  return { id: `t${seq}`, recordedAt, source: 'conversation' as const }
}

describe('更正链（ADR 0002：最后一条更正生效）', () => {
  const now = at(2026, 9, 1)

  it('update 合并补丁', () => {
    const events = [
      makeExpense({ id: 'r1', recordedAt: at(2026, 8, 31), source: 'conversation' }, {
        category: '餐饮',
        amount: 35,
        occurredAt: at(2026, 8, 31),
      }),
      makeCorrection(init(at(2026, 9, 1)), { target: 'r1', op: 'update', patch: { amount: 40 } }),
    ]
    const folded = foldEvents(events, now)
    const r = folded.records.find((x) => x.id === 'r1')
    expect(r && r.kind === 'expense' ? r.amount : null).toBe(40)
  })

  it('update 后 delete → 废止；delete 后 update → 复活带补丁', () => {
    const base = makeExpense({ id: 'r1', recordedAt: 1, source: 'conversation' }, {
      category: '餐饮',
      amount: 35,
      occurredAt: at(2026, 8, 31),
    })
    const upd = (t: number, patch: Record<string, unknown>) =>
      makeCorrection({ id: `c${t}`, recordedAt: t, source: 'ui' }, { target: 'r1', op: 'update', patch })
    const del = (t: number) =>
      makeCorrection({ id: `d${t}`, recordedAt: t, source: 'ui' }, { target: 'r1', op: 'delete' })

    const gone = foldEvents([base, upd(2, { amount: 40 }), del(3)], now)
    expect(gone.records).toHaveLength(0)

    const back = foldEvents([base, del(2), upd(3, { amount: 50 })], now)
    const r = back.records.find((x) => x.id === 'r1')
    expect(r && r.kind === 'expense' ? r.amount : null).toBe(50)
  })

  it('更正可以指向目标事件（改预算）', () => {
    const events = [
      makeGoal({ id: 'g1', recordedAt: 1, source: 'conversation' }, {
        dimension: 'finance',
        aggregate: 'amount',
        target: 3000,
        period: 'month',
        repeat: 'rolling',
      }),
      makeCorrection(init(2), { target: 'g1', op: 'update', patch: { target: 2500 } }),
    ]
    const folded = foldEvents(events, now)
    expect(folded.goals).toHaveLength(1)
    expect(folded.goals[0].event.target).toBe(2500)
  })
})

describe('分类时间线（改名链折叠、删除归兜底）', () => {
  const now = at(2026, 9, 1)

  it('改名链：已有记录跟随迁移', () => {
    const events: OpenEvent[] = [
      makeCategory({ id: 'c1', recordedAt: 1, source: 'internal' }, { dimension: 'finance', op: 'add', name: '餐饮' }),
      makeExpense({ id: 'r1', recordedAt: 2, source: 'conversation' }, {
        category: '餐饮',
        amount: 35,
        occurredAt: at(2026, 8, 31),
      }),
      makeCategory({ id: 'c2', recordedAt: 3, source: 'ui' }, { dimension: 'finance', op: 'rename', name: '餐饮', newName: '吃饭' }),
      makeCategory({ id: 'c3', recordedAt: 4, source: 'ui' }, { dimension: 'finance', op: 'rename', name: '吃饭', newName: '伙食' }),
    ]
    const folded = foldEvents(events, now)
    const r = folded.records.find((x) => x.id === 'r1')
    expect(r && r.kind === 'expense' ? r.category : null).toBe('伙食')
    expect(folded.categories.finance).toContain('伙食')
    expect(folded.categories.finance).not.toContain('餐饮')
  })

  it('删除分类：记录归入「其他」', () => {
    const events: OpenEvent[] = [
      makeCategory({ id: 'c1', recordedAt: 1, source: 'internal' }, { dimension: 'life', op: 'add', name: '撸猫' }),
      makeActivity({ id: 'r1', recordedAt: 2, source: 'conversation' }, {
        dimension: 'life',
        category: '撸猫',
        minutes: 30,
        occurredAt: at(2026, 8, 31),
      }),
      makeCategory({ id: 'c2', recordedAt: 3, source: 'ui' }, { dimension: 'life', op: 'delete', name: '撸猫' }),
    ]
    const folded = foldEvents(events, now)
    const r = folded.records.find((x) => x.id === 'r1')
    expect(r && r.kind === 'activity' ? r.category : null).toBe('其他')
    expect(folded.categories.life).toContain('其他')
    expect(folded.categories.life).not.toContain('撸猫')
  })

  it('记录引用未见分类事件的分类时防御性并入清单（导入场景）', () => {
    const events: OpenEvent[] = [
      makeExpense({ id: 'r1', recordedAt: 1, source: 'ui' }, {
        category: '神秘分类',
        amount: 10,
        occurredAt: at(2026, 8, 31),
      }),
    ]
    const folded = foldEvents(events, now)
    expect(folded.categories.finance).toContain('神秘分类')
  })
})

describe('目标活跃（M8：同 key 后设覆盖，once 过窗失效）', () => {
  const now = at(2026, 9, 1)

  it('同 key 目标后者覆盖前者', () => {
    const events = [
      makeGoal({ id: 'g1', recordedAt: 1, source: 'conversation' }, {
        dimension: 'life',
        category: '撸猫',
        aggregate: 'count',
        target: 3,
        period: 'week',
        repeat: 'rolling',
      }),
      makeGoal({ id: 'g2', recordedAt: 2, source: 'conversation' }, {
        dimension: 'life',
        category: '撸猫',
        aggregate: 'count',
        target: 5,
        period: 'week',
        repeat: 'rolling',
      }),
    ]
    const folded = foldEvents(events, now)
    expect(folded.goals).toHaveLength(1)
    expect(folded.goals[0].event.target).toBe(5)
  })

  it('不同 key（不同分类）并存；once 过窗失效', () => {
    const events = [
      makeGoal({ id: 'g1', recordedAt: 1, source: 'conversation' }, {
        dimension: 'life',
        category: '撸猫',
        aggregate: 'count',
        target: 3,
        period: 'week',
        repeat: 'rolling',
      }),
      makeGoal({ id: 'g2', recordedAt: 2, source: 'conversation' }, {
        dimension: 'life',
        category: '写作',
        aggregate: 'count',
        target: 2,
        period: 'week',
        repeat: 'rolling',
      }),
      // 单次目标：窗口锚在上上周的周窗口，早已过期
      makeGoal({ id: 'g3', recordedAt: 3, source: 'conversation' }, {
        dimension: 'study',
        category: '办证',
        aggregate: 'count',
        target: 1,
        period: 'week',
        repeat: 'once',
        windowStart: at(2026, 8, 10),
      }),
      // 单次目标：本周窗口，仍活跃
      makeGoal({ id: 'g4', recordedAt: 4, source: 'conversation' }, {
        dimension: 'study',
        category: '复习',
        aggregate: 'count',
        target: 1,
        period: 'week',
        repeat: 'once',
        windowStart: at(2026, 8, 31),
      }),
    ]
    const folded = foldEvents(events, now)
    expect(folded.goals.map((g) => g.event.id).sort()).toEqual(['g1', 'g2', 'g4'])
  })
})

describe('心情记录', () => {
  it('无分类维度照常折叠', () => {
    const events = [
      makeMood({ id: 'm1', recordedAt: 1, source: 'conversation' }, { score: 7, occurredAt: at(2026, 9, 1) }),
    ]
    const folded = foldEvents(events, at(2026, 9, 1))
    expect(folded.records).toHaveLength(1)
    expect(folded.records[0].kind).toBe('mood')
  })
})
