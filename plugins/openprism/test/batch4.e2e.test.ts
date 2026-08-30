import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, lastAppliedStores } from '../src/index.js'
import { resolveEventsFile } from '../src/home.js'
import { periodStart } from '../src/panel.js'
import { createHarness, waitForFile, type Harness } from './harness.js'

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  await apply(harness.ctx as never)
})

afterEach(async () => {
  await harness.cleanup()
})

function emitToolCall(sessionId: string, callId: string, name: string, args: Record<string, unknown>, time = Date.now()): void {
  harness.emit('session/event', { id: sessionId }, {
    type: 'tool/call',
    time,
    data: { callId, name, arguments: JSON.stringify(args) },
  })
}

describe('批次4 E2E：目标/速记/切片', () => {
  it('openprism_set_goal：设定目标 → panel.json 出进度；重设覆盖旧目标', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 800, category: '餐饮' })
    await waitForFile(resolveEventsFile(), '"source":"mirror"')
    const goal = harness.registered.get('openprism_set_goal')!
    await goal.execute({ metric: 'expenseTotal', dimension: 'finance', target: 2000, period: 'monthly', note: '餐饮预算' }, {} as never)

    let panel = await harness.request('/openprism/panel.json')
    let summary = JSON.parse(panel.body) as { goals?: Array<{ current: number; target: number; ratio: number; dimension: string }> }
    expect(summary.goals).toHaveLength(1)
    expect(summary.goals![0]).toMatchObject({ dimension: 'finance', current: 800, target: 2000 })
    expect(summary.goals![0].ratio).toBeCloseTo(0.4)

    // 重设同 key → 旧目标被更正删除，只剩一个
    await goal.execute({ metric: 'expenseTotal', dimension: 'finance', target: 1500, period: 'monthly' }, {} as never)
    panel = await harness.request('/openprism/panel.json')
    summary = JSON.parse(panel.body) as { goals?: Array<{ target: number }> }
    expect(summary.goals).toHaveLength(1)
    expect(summary.goals![0].target).toBe(1500)

    // metric/dimension 组合非法
    await expect(goal.execute({ metric: 'moodCount', dimension: 'finance', target: 5, period: 'daily' }, {} as never)).rejects.toThrow(/dimension 必须是/)
  })

  it('POST /openprism/records 速记表单：ui 来源 + form 渠道 + 面板生效', async () => {
    const res = await harness.request('/openprism/records', {
      method: 'POST',
      body: { kind: 'expense', amount: 45, category: '饮品', note: '咖啡' },
    })
    expect(res.status).toBe(200)
    const { ok, id } = JSON.parse(res.body) as { ok: boolean; id: string }
    expect(ok).toBe(true)
    expect(id).toMatch(/^u/)

    const text = await (await import('node:fs/promises')).readFile(resolveEventsFile(), 'utf8')
    expect(text).toContain('"channel":"form"')
    expect(text).toContain('"source":"ui"')

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number }; slices?: Record<string, Record<string, { amount?: number }>> }
    expect(summary.finance.monthTotal).toBe(45)
    expect(summary.slices?.finance?.today?.amount).toBe(45)

    // 非法速记
    const bad = await harness.request('/openprism/records', { method: 'POST', body: { kind: 'expense', amount: -5, category: 'x' } })
    expect(bad.status).toBe(400)
  })

  it('周期切片按 occurredAt：年初的记录只进 year，不进 today', async () => {
    const { store } = lastAppliedStores()!
    const now = Date.now()
    const yearStart = periodStart('year', now)
    const earlyYear = yearStart + 36 * 3600 * 1000 // 1 月 2 日中午前后，必在本年、必不在今日
    await store.append({
      id: 'u-test', kind: 'expense', source: 'ui', channel: 'form', sessionId: 's',
      recordedAt: now, occurredAt: earlyYear, payload: { amount: 100, category: '购物' },
    })
    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { slices?: Record<string, Record<string, { count: number; amount?: number }>> }
    expect(summary.slices?.finance?.year?.count).toBe(1)
    expect(summary.slices?.finance?.year?.amount).toBe(100)
    expect(summary.slices?.finance?.today?.count).toBe(0)
    // 当月窗口：只有记录日期落在本月时才计
    const monthStart = periodStart('month', now)
    const expectedMonthCount = earlyYear >= monthStart ? 1 : 0
    expect(summary.slices?.finance?.month?.count).toBe(expectedMonthCount)
  })

  it('热力图：今天的记录计数为 1（finance 维度 91 天末位）', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 12, category: '交通' })
    await waitForFile(resolveEventsFile(), '"source":"mirror"')
    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { heatmap?: Record<string, Array<{ date: string; count: number }>> }
    const finance = summary.heatmap?.finance
    expect(finance).toHaveLength(91)
    expect(finance![finance.length - 1].count).toBe(1)
    expect(finance![finance.length - 1].count).toBe(finance![finance.length - 1].count)
    expect(summary.heatmap?.mood?.[90].count).toBe(0)
  })
})
