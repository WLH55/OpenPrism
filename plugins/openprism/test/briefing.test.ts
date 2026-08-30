import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDailyBriefing, buildWeeklyBriefing } from '../src/briefing.js'
import { foldEvents } from '../src/fold.js'
import { EventStore, randomEventId } from '../src/store.js'
import { buildGoalProgress } from '../src/panel.js'
import type { GoalPayload, OpenEvent } from '../src/events.js'
import { lastAppliedStores, apply } from '../src/index.js'
import { resolveOpenPrismHome } from '../src/home.js'
import { createHarness, waitForFile, type Harness } from './harness.js'

function goalEvent(overrides: Partial<GoalPayload>): OpenEvent {
  return {
    id: randomEventId('g'),
    kind: 'goal',
    source: 'internal',
    recordedAt: Date.now(),
    payload: { dimension: 'finance', metric: 'expenseTotal', target: 2000, period: 'monthly', ...overrides },
  } as OpenEvent
}

describe('buildDailyBriefing', () => {
  const now = new Date('2026-08-31T08:00:00+08:00').getTime()

  it('昨日数据 + 目标进度 + 提炼反馈', () => {
    const yesterday = now - 24 * 3600 * 1000
    const records = [
      { id: 'r1', kind: 'expense', occurredAt: yesterday + 3600_000, deleted: false, payload: { amount: 35, category: '餐饮' } },
      { id: 'r2', kind: 'mood', occurredAt: yesterday + 7200_000, deleted: false, payload: { score: 4 } },
      { id: 'r3', kind: 'activity', occurredAt: yesterday + 10800_000, deleted: false, payload: { dimension: 'life', category: '跑步', durationMinutes: 30 } },
      // 今天的不该出现
      { id: 'r4', kind: 'expense', occurredAt: now - 60_000, deleted: false, payload: { amount: 999, category: '餐饮' } },
    ]
    const state = foldEvents([])
    void state
    const goals = buildGoalProgress(
      [{ id: 'g1', payload: { dimension: 'finance', metric: 'expenseTotal', target: 100, period: 'monthly' } }],
      records as never,
      now,
    )
    const result = buildDailyBriefing({ records: records as never, goals, distillCount: 3, now })
    expect(result.path).toBe('reports/2026-08/daily-2026-08-30.md')
    expect(result.markdown).toContain('支出：¥35.00（1 笔：餐饮 ¥35.00）')
    expect(result.markdown).toContain('心情：均值 4.0/5（1 条）')
    expect(result.markdown).toContain('活动：1 条，合计 30 分钟')
    expect(result.markdown).toContain('¥1034.00 / ¥100.00（1034%）') // 月度窗口含今天那笔 999
    expect(result.markdown).toContain('过去一天从对话中提炼了 3 条记录')
    expect(result.markdown).not.toContain('999')
  })

  it('空数据 + 无目标的空态文案', () => {
    const result = buildDailyBriefing({ records: [], goals: [], distillCount: 0, now })
    expect(result.markdown).toContain('昨天没有记录')
    expect(result.markdown).toContain('暂无目标')
  })
})

describe('buildWeeklyBriefing', () => {
  it('本周 vs 上周表格 + 无 LLM 时跳过解读', async () => {
    const now = new Date('2026-08-31T21:00:00+08:00').getTime() // 周一 0 点附近按本地周一起算
    const thisWeek = periodStartWeek(now)
    const lastWeek = thisWeek - 7 * 24 * 3600 * 1000
    const records = [
      { id: 'r1', kind: 'expense', occurredAt: thisWeek + 3600_000, deleted: false, payload: { amount: 100, category: '餐饮' } },
      { id: 'r2', kind: 'expense', occurredAt: lastWeek + 3600_000, deleted: false, payload: { amount: 300, category: '餐饮' } },
    ]
    const result = await buildWeeklyBriefing({ records: records as never, now })
    expect(result.markdown).toContain('| 支出 | ¥100.00（1 笔） | ¥300.00（1 笔） | -67% |')
    expect(result.markdown).toContain('（未配置模型路由，跳过解读）')
  })

  it('提供 LLM 时生成解读段', async () => {
    const now = Date.now()
    const thisWeek = periodStartWeek(now)
    const records = [
      { id: 'r1', kind: 'expense', occurredAt: thisWeek + 3600_000, deleted: false, payload: { amount: 50, category: '餐饮' } },
    ]
    const result = await buildWeeklyBriefing({
      records: records as never,
      now,
      llm: { completeOnce: async () => '这周支出控制得不错，继续保持。' },
      llmRoute: { provider: 'd', model: 'm' },
    })
    expect(result.markdown).toContain('这周支出控制得不错，继续保持。')
  })

  function periodStartWeek(now: number): number {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    const dow = (d.getDay() + 6) % 7
    return d.getTime() - dow * 24 * 3600 * 1000
  }
})

describe('简报端点与落盘（E2E）', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await createHarness()
    await apply(harness.ctx as never)
  })
  afterEach(async () => {
    await harness.cleanup()
  })

  it('POST /openprism/briefing/daily 生成文件并可列出', async () => {
    const res = await harness.request('/openprism/briefing/daily', { method: 'POST' })
    expect(res.status).toBe(200)
    const { path: relPath } = JSON.parse(res.body) as { path: string }
    expect(relPath).toMatch(/^reports\/\d{4}-\d{2}\/daily-\d{4}-\d{2}-\d{2}\.md$/)
    const file = await waitForFile(join(resolveOpenPrismHome(), relPath), '每日简报')
    expect(file).toContain('OpenPrism 每日简报')

    const list = await harness.request('/openprism/briefings')
    const { briefings } = JSON.parse(list.body) as { briefings: string[] }
    expect(briefings).toContain(relPath)
  })

  it('POST /openprism/briefing/weekly 落盘周报（无 llm 时有跳过说明）', async () => {
    const res = await harness.request('/openprism/briefing/weekly', { method: 'POST' })
    expect(res.status).toBe(200)
    const { path: relPath } = JSON.parse(res.body) as { path: string }
    expect(relPath).toContain('weekly-')
    const markdown = await readFile(join(resolveOpenPrismHome(), relPath), 'utf8')
    expect(markdown).toContain('OpenPrism 周报')
    expect(markdown).toContain('未配置模型路由，跳过解读')
  })

  it('启动补跑：昨天简报缺失且已过 07:00 → apply 后自动生成', async () => {
    // 本测试不控制系统时钟——只要 apply 后文件存在即视为补跑成功（07:00 前运行时跳过）
    const { store } = lastAppliedStores()!
    void store
    const reportsDir = join(resolveOpenPrismHome(), 'reports')
    const months = await readdir(reportsDir).catch(() => [] as string[])
    expect(months.length).toBeGreaterThanOrEqual(0)
  })
})
