import { describe, expect, it } from 'vitest'
import {
  dedupeById,
  makeActivity,
  makeCategory,
  makeCorrection,
  makeExpense,
  makeGoal,
  makeMood,
  parseEvents,
  validateEvent,
} from '../src/domain/events'

const INIT = { id: 'e1', recordedAt: 1_000, source: 'conversation' as const }

describe('事件工厂与校验', () => {
  it('六种事件经 JSON 往返后均通过校验', () => {
    const events = [
      makeExpense(INIT, { category: '猫咪', amount: 35, occurredAt: 999 }),
      makeMood({ ...INIT, id: 'e2' }, { score: 7, occurredAt: 999 }),
      makeActivity({ ...INIT, id: 'e3' }, { dimension: 'life', category: '打滚', minutes: 40, occurredAt: 999 }),
      makeCorrection({ ...INIT, id: 'e4' }, { target: 'e1', op: 'update', patch: { amount: 40 } }),
      makeCategory({ ...INIT, id: 'e5' }, { dimension: 'finance', op: 'rename', name: '猫咪', newName: '吃饭' }),
      makeGoal({ ...INIT, id: 'e6' }, {
        dimension: 'life',
        category: '打滚',
        aggregate: 'count',
        target: 3,
        period: 'week',
        repeat: 'rolling',
        anchorDays: [3, 5, 6],
      }),
    ]
    for (const e of events) {
      expect(validateEvent(JSON.parse(JSON.stringify(e)))).toEqual(e)
    }
  })

  it('拒绝未知种类 / 缺 id / 坏来源 / 心情越界 / 负金额 / 坏锚定日', () => {
    const bad = (raw: unknown) => {
      let err: unknown
      try {
        validateEvent(raw)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
    }
    bad({ ...INIT, kind: 'banana' })
    bad({ recordedAt: 1_000, source: 'conversation', kind: 'expense', category: 'x', amount: 1, occurredAt: 1 })
    bad({ ...INIT, kind: 'mood', score: 11, occurredAt: 1 })
    bad({ ...INIT, kind: 'mood', score: 7, occurredAt: 1, source: 'mirror' })
    bad({ ...INIT, kind: 'expense', category: 'x', amount: -1, occurredAt: 1 })
    bad({
      ...INIT,
      kind: 'goal',
      dimension: 'life',
      aggregate: 'count',
      target: 3,
      period: 'week',
      repeat: 'rolling',
      anchorDays: [7],
    })
  })
})

describe('JSONL 容错解析（M3 撕裂尾行）', () => {
  it('正常多行全部解析', () => {
    const text = [
      JSON.stringify(makeExpense(INIT, { category: '猫咪', amount: 35, occurredAt: 999 })),
      JSON.stringify(makeMood({ ...INIT, id: 'e2' }, { score: 7, occurredAt: 999 })),
    ].join('\n')
    const parsed = parseEvents(text)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.tornTail).toBe(false)
    expect(parsed.skippedLines).toBe(0)
  })

  it('末行撕裂被识别并剔除', () => {
    const text =
      JSON.stringify(makeExpense(INIT, { category: '猫咪', amount: 35, occurredAt: 999 })) +
      '\n{"kind":"expens'
    const parsed = parseEvents(text)
    expect(parsed.events).toHaveLength(1)
    expect(parsed.tornTail).toBe(true)
  })

  it('中部坏行跳过计数', () => {
    const text = [
      JSON.stringify(makeExpense(INIT, { category: '猫咪', amount: 35, occurredAt: 999 })),
      'not json at all',
      JSON.stringify(makeMood({ ...INIT, id: 'e2' }, { score: 7, occurredAt: 999 })),
    ].join('\n')
    const parsed = parseEvents(text)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.skippedLines).toBe(1)
    expect(parsed.tornTail).toBe(false)
  })
})

describe('按 id 幂等', () => {
  it('同 id 重复追加只保留首见', () => {
    const a = makeExpense(INIT, { category: '猫咪', amount: 35, occurredAt: 999 })
    const b = makeExpense(INIT, { category: '猫咪', amount: 35, occurredAt: 999 })
    expect(dedupeById([a, b])).toHaveLength(1)
  })
})
