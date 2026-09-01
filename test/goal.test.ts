import { describe, expect, it } from 'vitest'
import { makeActivity, makeExpense, makeGoal, makeMood } from '../src/domain/events'
import { foldEvents, periodWindow } from '../src/domain/fold'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

let seq = 0
function gid(): { id: string; recordedAt: number; source: 'conversation' } {
  seq += 1
  return { id: `g${seq}`, recordedAt: at(2026, 1, 1), source: 'conversation' }
}

describe('周期窗口（本地时区日历窗，周一起始）', () => {
  it('周窗口：周三落在上周一至本周一', () => {
    const w = periodWindow('week', at(2026, 9, 2)) // 2026-09-02 是周三
    expect(new Date(w.start).getDate()).toBe(31) // 8-31 周一
    expect(new Date(w.start).getMonth()).toBe(7)
    expect(new Date(w.end).getDate()).toBe(7) // 9-07 周一
  })

  it('月窗口与年窗口', () => {
    const m = periodWindow('month', at(2026, 9, 15))
    expect(new Date(m.start).getMonth()).toBe(8)
    expect(new Date(m.end).getMonth()).toBe(9)
    const y = periodWindow('year', at(2026, 9, 15))
    expect(new Date(y.start).getMonth()).toBe(0)
    expect(new Date(y.start).getDate()).toBe(1)
    expect(new Date(y.end).getFullYear()).toBe(2027)
  })

  it('日窗口从本地零点起', () => {
    const d = periodWindow('day', at(2026, 9, 2, 5))
    const start = new Date(d.start)
    expect(start.getHours()).toBe(0)
    expect(start.getDate()).toBe(2)
  })
})

describe('组合式目标进度（M8）', () => {
  it('count 轴 + 分类限定：锚定日不构成约束', () => {
    // 目标：每周撸猫 ≥3 次，偏好周三/五/六
    const now = at(2026, 9, 3) // 周四；本周 = 8/31(一) ~ 9/6(日)
    const goal = makeGoal(gid(), {
      dimension: 'life',
      category: '撸猫',
      aggregate: 'count',
      target: 3,
      period: 'week',
      repeat: 'rolling',
      anchorDays: [3, 5, 6],
    })
    const acts = [
      // 周一、周二不在锚定日里，照样计数（锚定日只是督导时机）
      makeActivity(gid(), { dimension: 'life', category: '撸猫', minutes: 10, occurredAt: at(2026, 8, 31) }),
      makeActivity(gid(), { dimension: 'life', category: '撸猫', minutes: 10, occurredAt: at(2026, 9, 1) }),
      makeActivity(gid(), { dimension: 'life', category: '撸猫', minutes: 10, occurredAt: at(2026, 9, 2) }),
      // 别的分类不计入
      makeActivity(gid(), { dimension: 'life', category: '发呆', minutes: 99, occurredAt: at(2026, 9, 2) }),
    ]
    const folded = foldEvents([goal, ...acts], now)
    expect(folded.goalProgress).toHaveLength(1)
    expect(folded.goalProgress[0].current).toBe(3)
    expect(folded.goalProgress[0].met).toBe(true)
  })

  it('amount 轴是上限：≤达标', () => {
    const now = at(2026, 9, 3)
    const goal = makeGoal(gid(), {
      dimension: 'finance',
      aggregate: 'amount',
      target: 3000,
      period: 'month',
      repeat: 'rolling',
    })
    const spend = (day: number, n: number) =>
      makeExpense(gid(), { category: '随便', amount: n, occurredAt: at(2026, 9, day) })
    const ok = foldEvents([goal, spend(1, 1200), spend(2, 800)], now)
    expect(ok.goalProgress[0].met).toBe(true)
    expect(ok.goalProgress[0].current).toBe(2000)
    const over = foldEvents([goal, spend(1, 1200), spend(2, 800), spend(3, 1500)], now)
    expect(over.goalProgress[0].met).toBe(false)
  })

  it('minutes 轴按时长合计；count 轴配心情打卡（日窗口）', () => {
    const now = at(2026, 9, 2, 21)
    const minutesGoal = makeGoal(gid(), {
      dimension: 'study',
      category: '刷题',
      aggregate: 'minutes',
      target: 120,
      period: 'week',
      repeat: 'rolling',
    })
    const moodGoal = makeGoal(gid(), {
      dimension: 'mood',
      aggregate: 'count',
      target: 1,
      period: 'day',
      repeat: 'rolling',
    })
    const events = [
      minutesGoal,
      moodGoal,
      makeActivity(gid(), { dimension: 'study', category: '刷题', minutes: 40, occurredAt: at(2026, 9, 1) }),
      makeActivity(gid(), { dimension: 'study', category: '刷题', minutes: 40, occurredAt: at(2026, 9, 2) }),
      makeActivity(gid(), { dimension: 'study', category: '刷题', minutes: 40, occurredAt: at(2026, 9, 2) }),
      makeMood(gid(), { score: 7, occurredAt: at(2026, 9, 2, 20) }),
    ]
    const folded = foldEvents(events, now)
    const byDim = Object.fromEntries(folded.goalProgress.map((p) => [p.goal.event.dimension, p]))
    expect(byDim.study.current).toBe(120)
    expect(byDim.study.met).toBe(true)
    expect(byDim.mood.current).toBe(1)
    expect(byDim.mood.met).toBe(true)
  })

  it('滚动窗口按 occurredAt 落窗：上周的记录不进本周，昨天的不进本月窗口语义', () => {
    const now = at(2026, 9, 3)
    const weekGoal = makeGoal(gid(), {
      dimension: 'life',
      category: '撸猫',
      aggregate: 'count',
      target: 1,
      period: 'week',
      repeat: 'rolling',
    })
    // 8/25 属于上上周：不在本周窗口
    const lastLastWeek = makeActivity(gid(), { dimension: 'life', category: '撸猫', occurredAt: at(2026, 8, 25) })
    expect(foldEvents([weekGoal, lastLastWeek], now).goalProgress[0].current).toBe(0)

    // 月度目标：8/31 23:00 发生（9/1 才录入）不进 9 月窗口——occurredAt 是切片轴
    const monthGoal = makeGoal(gid(), {
      dimension: 'life',
      category: '撸猫',
      aggregate: 'count',
      target: 1,
      period: 'month',
      repeat: 'rolling',
    })
    const lateAugust = {
      ...makeActivity(gid(), { dimension: 'life', category: '撸猫', occurredAt: at(2026, 8, 31, 23) }),
    }
    lateAugust.recordedAt = at(2026, 9, 1)
    expect(foldEvents([monthGoal, lateAugust], now).goalProgress[0].current).toBe(0)
  })

  it('once 单次窗口固定：不随 now 滚动，过窗即失效', () => {
    const goal = makeGoal(gid(), {
      dimension: 'study',
      category: '复习',
      aggregate: 'count',
      target: 1,
      period: 'week',
      repeat: 'once',
      windowStart: at(2026, 8, 31),
    })
    const act = makeActivity(gid(), { dimension: 'study', category: '复习', occurredAt: at(2026, 9, 5) })
    const during = foldEvents([goal, act], at(2026, 9, 6))
    expect(during.goals).toHaveLength(1)
    expect(during.goalProgress[0].current).toBe(1)
    const after = foldEvents([goal, act], at(2026, 9, 8))
    expect(after.goals).toHaveLength(0)
  })
})
