import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { resolveEventsFile } from '../src/home.js'
import { createHarness, drain, waitForFile, type Harness } from './harness.js'

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

async function seedOneExpense(amount = 35, category = '餐饮'): Promise<string> {
  emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount, category })
  await waitForFile(resolveEventsFile(), '"source":"mirror"')
  const panel = await harness.request('/openprism/panel.json')
  const summary = JSON.parse(panel.body) as { recent: Array<{ id: string }> }
  return summary.recent[0].id
}

describe('批次2 E2E：更正回路（4.1）', () => {
  it('openprism_correct update：改金额，折叠生效（面板月合计变化）', async () => {
    await seedOneExpense(35)
    const correct = harness.registered.get('openprism_correct')!
    const result = (await correct.execute({ op: 'update', kind: 'expense', amount: 28 }, {} as never)) as {
      corrected: boolean
      target: string
      entry: string
    }
    expect(result.corrected).toBe(true)
    expect(result.entry).toContain('¥35.00')

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number } }
    expect(summary.finance.monthTotal).toBe(28)
  })

  it('openprism_correct delete：删最近一条，面板归零、recent 不再出现', async () => {
    const target = await seedOneExpense(35)
    const correct = harness.registered.get('openprism_correct')!
    const result = (await correct.execute({ op: 'delete', kind: 'expense' }, {} as never)) as { corrected: boolean; target: string }
    expect(result.target).toBe(target)

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number }; recent: Array<{ id: string }> }
    expect(summary.finance.monthTotal).toBe(0)
    expect(summary.recent.find((r) => r.id === target)).toBeUndefined()
  })

  it('用 recent 里的 id 精确更正（note + occurredAt）', async () => {
    const target = await seedOneExpense(35)
    const correct = harness.registered.get('openprism_correct')!
    await correct.execute({ op: 'update', target, note: '午饭', occurredAt: '2026-08-15' }, {} as never)

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { recent: Array<{ id: string; title: string; date: string }> }
    const item = summary.recent.find((r) => r.id === target)!
    expect(item.date).toBe('2026-08-15')
    expect(item.title).toContain('午饭')
  })

  it('重复更正安全：已删除的目标再删一次报错，不影响日志', async () => {
    const target = await seedOneExpense(35)
    const correct = harness.registered.get('openprism_correct')!
    await correct.execute({ op: 'delete', target }, {} as never)
    await expect(correct.execute({ op: 'delete', target }, {} as never)).rejects.toThrow(/已被删除/)
  })

  it('无匹配与非法请求：抛出可读错误', async () => {
    const correct = harness.registered.get('openprism_correct')!
    await expect(correct.execute({ op: 'delete', kind: 'mood' }, {} as never)).rejects.toThrow(/最近没有匹配/)
    await expect(correct.execute({ op: 'nope' }, {} as never)).rejects.toThrow(/op 必须是/)
    await expect(correct.execute({ op: 'update', kind: 'expense' }, {} as never)).rejects.toThrow(/至少提供一个/)
    await expect(correct.execute({ op: 'update', kind: 'expense', amount: 1 }, {} as never)).rejects.toThrow(/最近没有匹配|找不到/)
  })

  it('UI 端点 POST /openprism/corrections（source: ui）', async () => {
    const target = await seedOneExpense(35)
    const res = await harness.request('/openprism/corrections', { method: 'POST', body: { op: 'update', target, amount: 50 } })
    expect(res.status).toBe(200)
    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number } }
    expect(summary.finance.monthTotal).toBe(50)

    const bad = await harness.request('/openprism/corrections', { method: 'POST', body: { op: 'update', target: 'ghost', amount: 1 } })
    expect(bad.status).toBe(400)
  })

  it('rebuild 重放 openprism_correct：空库重放记录+更正后折叠一致', async () => {
    const { EventStore } = await import('../src/store.js')
    const { rebuildFromSessions } = await import('../src/rebuild.js')
    const store = new EventStore(join2())
    await store.load()
    const now = Date.now()
    const result = await rebuildFromSessions(store, {
      async *entries() {
        yield {
          sessionId: 'sess-R',
          events: [
            { type: 'tool/call', time: now - 2000, data: { callId: 'r1', name: 'openprism_record_expense', arguments: JSON.stringify({ amount: 99, category: '娱乐' }) } },
            { type: 'tool/call', time: now - 1000, data: { callId: 'r2', name: 'openprism_correct', arguments: JSON.stringify({ op: 'update', kind: 'expense', amount: 88 }) } },
          ],
        }
      },
    })
    expect(result.mirrored).toBe(1)
    const corrections = store.list().filter((e) => e.kind === 'correction')
    expect(corrections).toHaveLength(1)
    expect(corrections[0].payload).toMatchObject({ op: 'update', patch: { amount: 88 } })
    expect(corrections[0].source).toBe('internal')

    function join2(): string {
      return `${harness.home}/rebuild-batch2.jsonl`
    }
  })
})
