import { describe, expect, it } from 'vitest'
import { makeActivity, makeExpense, makeGoal, makeMood } from '../src/domain/events'
import { foldEvents } from '../src/domain/fold'
import { buildPanel, formatPanelSummary } from '../src/domain/panel'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

let seq = 0
function nid(): { id: string; recordedAt: number; source: 'conversation' } {
  seq += 1
  return { id: `p${seq}`, recordedAt: at(2026, 1, 1), source: 'conversation' }
}

function fixture(now: number) {
  const events = [
    // 9 月：两笔支出
    makeExpense(nid(), { category: '猫粮', amount: 200, occurredAt: at(2026, 9, 1, 9) }),
    makeExpense(nid(), { category: '买书', amount: 80, occurredAt: at(2026, 9, 1, 15) }),
    // 8 月：不该进 9 月统计
    makeExpense(nid(), { category: '猫粮', amount: 50, occurredAt: at(2026, 8, 28) }),
    // 心情
    makeMood(nid(), { score: 7, occurredAt: at(2026, 9, 1, 21) }),
    makeMood(nid(), { score: 8, occurredAt: at(2026, 8, 30) }),
    // 活动
    makeActivity(nid(), { dimension: 'life', category: '撸猫', minutes: 30, occurredAt: at(2026, 9, 1, 20) }),
    makeActivity(nid(), { dimension: 'study', category: '刷题', minutes: 40, occurredAt: at(2026, 9, 1, 8) }),
    // 目标：每周撸猫 3 次（当前 1/3）
    makeGoal(nid(), {
      dimension: 'life',
      category: '撸猫',
      aggregate: 'count',
      target: 3,
      period: 'week',
      repeat: 'rolling',
      anchorDays: [3, 5, 6],
    }),
  ]
  return foldEvents(events, now)
}

describe('面板聚合', () => {
  const now = at(2026, 9, 1, 22)

  it('理财月合计只算本月；分类聚合降序', () => {
    const p = buildPanel(fixture(now), now)
    expect(p.finance.monthTotal).toBe(280)
    expect(p.finance.monthCount).toBe(2)
    expect(p.finance.byCategory[0].category).toBe('猫粮')
    expect(p.finance.byCategory[0].amount).toBe(200)
  })

  it('心情月均值只算本月', () => {
    const p = buildPanel(fixture(now), now)
    expect(p.mood.monthCount).toBe(1)
    expect(p.mood.average).toBe(7)
  })

  it('今日切片与热力图按 occurredAt 落格', () => {
    const p = buildPanel(fixture(now), now)
    expect(p.slices.finance?.today.amount).toBe(280)
    expect(p.heatmap.finance?.['2026-09-01']).toBe(2)
    expect(p.heatmap.finance?.['2026-08-28']).toBe(1)
    expect(p.slices.life?.today.count).toBe(1)
  })

  it('最近记录带 id 与标题（供更正引用）', () => {
    const p = buildPanel(fixture(now), now)
    expect(p.recent.length).toBeGreaterThanOrEqual(5)
    expect(p.recent[0].id).toBeTruthy()
    expect(p.recent.some((r) => r.title.includes('猫粮'))).toBe(true)
  })
})

describe('模型摘要文本（openprism_panel 返回）', () => {
  const now = at(2026, 9, 1, 22)

  it('包含月合计、目标进度（锚定日）、最近记录 id、可录分类', () => {
    const text = formatPanelSummary(fixture(now), now)
    expect(text).toContain('¥280')
    expect(text).toContain('撸猫')
    expect(text).toContain('每周≥3次')
    expect(text).toContain('当前 1次')
    expect(text).toContain('周三、周五、周六')
    expect(text).toMatch(/🕘 最近记录[\s\S]*p\d+/)
    expect(text).toContain('可录分类')
  })
})
