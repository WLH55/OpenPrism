import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/** code 预设派发形态：run_code 内 `tools.openprism_*()`，凭据在完成事件 tool/code-dispatch。 */
function emitCodeDispatch(
  sessionId: string,
  subCallId: string,
  name: string,
  args: Record<string, unknown>,
  isError = false,
  time = Date.now(),
): void {
  const root = subCallId.split(':')[0]
  harness.emit('session/event', { id: sessionId }, {
    type: 'tool/code-dispatch',
    time,
    data: { rootCallId: root, parentCallId: root, subCallId, name, arguments: args, isError, content: [] },
  })
}

async function readEvents(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(resolveEventsFile(), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('批次1 E2E：会话事件 → 镜像 → 事件日志 → 折叠 → 工具/端点', () => {
  it('镜像 tool/call：记录事件落库、分类自动建类、面板端点出数', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 35, category: ' 餐饮 ' })
    await drain()
    await waitForFile(resolveEventsFile(), '"source":"mirror"')

    const events = await readEvents()
    const mirrored = events.filter((e) => e.source === 'mirror')
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({
      kind: 'expense',
      source: 'mirror',
      channel: 'chat',
      sessionId: 'sess-1',
      payload: { amount: 35, category: '餐饮' },
    })
    const created = events.filter((e) => e.kind === 'category' && (e.payload as Record<string, unknown>).name === '餐饮')
    expect(created.length).toBeGreaterThanOrEqual(1)

    const panel = await harness.request('/openprism/panel.json')
    expect(panel.status).toBe(200)
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number; monthCount: number }; categories: Record<string, string[]> }
    expect(summary.finance.monthTotal).toBe(35)
    expect(summary.finance.monthCount).toBe(1)
    expect(summary.categories.finance).toContain('餐饮')
  })

  it('同一 callId 重复投递幂等（在线镜像/回填/rebuild 三路合一）', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 35, category: '餐饮' })
    await waitForFile(resolveEventsFile(), '"source":"mirror"')
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 35, category: '餐饮' })
    await drain()
    const events = await readEvents()
    const mirrored = events.filter((e) => e.source === 'mirror')
    expect(mirrored).toHaveLength(1)
  })

  it('非法参数：镜像器跳过，工具 execute 抛同样的错', async () => {
    emitToolCall('sess-1', 'bad', 'openprism_record_expense', { amount: -5, category: 'x' })
    await waitForFile(resolveEventsFile(), '其他') // 播种事件已落盘 = 系统活着
    const events = await readEvents()
    expect(events.filter((e) => e.source === 'mirror')).toHaveLength(0)

    const expense = harness.registered.get('openprism_record_expense')!
    await expect(expense.execute({ amount: -5, category: 'x' }, {} as never)).rejects.toThrow(/openprism/)
  })

  it('工具 execute 校验 + 面板工具读折叠（记录已由镜像落库）', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 20, category: '饮品' })
    emitToolCall('sess-1', 'c2', 'openprism_record_mood', { score: 4 })
    await drain()
    const panel = harness.registered.get('openprism_panel')!
    const result = (await panel.execute({}, {} as never)) as { monthTotal: number; moodCount: number; summary: string }
    expect(result.monthTotal).toBe(20)
    expect(result.moodCount).toBe(1)
    expect(result.summary).toContain('本月')
  })

  it('UI 分类改名 → 折叠改名链生效（面板分类跟着走）', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 35, category: '餐饮' })
    await drain()
    const renamed = await harness.request('/openprism/categories', { method: 'POST', body: { op: 'rename', dimension: 'finance', name: '餐饮', newName: '吃饭' } })
    expect(renamed.status).toBe(200)

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { byCategory: Array<{ category: string }> }; categories: Record<string, string[]> }
    expect(summary.finance.byCategory[0].category).toBe('吃饭')
    expect(summary.categories.finance).toContain('吃饭')
    expect(summary.categories.finance).not.toContain('餐饮')

    // UI 兜底规则：其他 不可删
    const forbidden = await harness.request('/openprism/categories', { method: 'POST', body: { op: 'delete', dimension: 'finance', name: '其他' } })
    expect(forbidden.status).toBe(400)
  })

  it('occurredAt 参数进载荷（4.2 时间语义的管道已通）', async () => {
    emitToolCall('sess-1', 'c1', 'openprism_record_expense', { amount: 35, category: '餐饮', occurredAt: '2026-08-01' }, 1725000000000)
    await waitForFile(resolveEventsFile(), '"occurredAt"')
    const events = await readEvents()
    const mirrored = events.find((e) => e.source === 'mirror') as Record<string, unknown>
    expect(mirrored.occurredAt).toBe(Date.parse('2026-08-01'))
    expect(mirrored.recordedAt).toBe(1725000000000)
  })

  it('rebuild：从会话日志重放（确定性 id），非镜像事件保留', async () => {
    emitToolCall('sess-A', 'c1', 'openprism_record_expense', { amount: 12, category: '交通' })
    // UI 写入一条非镜像事件（rebuild 必须保留）
    await harness.request('/openprism/categories', { method: 'POST', body: { op: 'add', dimension: 'life', name: '攀岩' } })
    await waitForFile(resolveEventsFile(), '攀岩')

    const eventsFile = resolveEventsFile()
    const before = await readEvents()
    const uiBefore = before.filter((e) => e.source === 'ui')
    const mirrorIdsBefore = before.filter((e) => e.source === 'mirror').map((e) => e.id).sort()
    expect(mirrorIdsBefore).toHaveLength(1)

    // 换一个空库重放同一会话日志 → 生成同一批确定性 id（rebuild 语义的核心）
    const { EventStore } = await import('../src/store.js')
    const { rebuildFromSessions } = await import('../src/rebuild.js')
    const fakeSource = {
      async *entries() {
        yield {
          sessionId: 'sess-A',
          events: [{
            type: 'tool/call',
            time: 1725000000000,
            data: { callId: 'c1', name: 'openprism_record_expense', arguments: JSON.stringify({ amount: 12, category: '交通' }) },
          }],
        }
      },
    }

    // 主库重放：事件已存在 → 幂等（mirrored=0），UI 事件原样保留
    const main = new EventStore(eventsFile)
    await main.load()
    const result = await rebuildFromSessions(main, fakeSource)
    expect(result.scannedSessions).toBe(1)
    expect(result.mirrored).toBe(0)
    await waitForFile(eventsFile, '攀岩')
    const after = await readEvents()
    expect(after.filter((e) => e.source === 'ui')).toEqual(uiBefore)
    expect(after.filter((e) => e.source === 'mirror').map((e) => e.id).sort()).toEqual(mirrorIdsBefore)

    // 空库重放：重建出与在线镜像完全相同的确定性 id
    const orphan = new EventStore(join(harness.home, 'orphan.jsonl'))
    await orphan.load()
    const result2 = await rebuildFromSessions(orphan, fakeSource)
    expect(result2.mirrored).toBe(1)
    const rebuiltIds = orphan.list().filter((e) => e.source === 'mirror').map((e) => e.id).sort()
    expect(rebuiltIds).toEqual(mirrorIdsBefore)
  })
})

describe('批次1 补充：code 预设派发镜像（run_code -> tool/code-dispatch，真机 2026-08-31 发现）', () => {
  it('镜像 tool/code-dispatch：对象参数落库、面板出数', async () => {
    emitCodeDispatch('sess-1', 'call_00_x:code:1', 'openprism_record_activity', {
      dimension: 'study',
      category: '阅读',
      note: '周末学习 ETF 投资知识',
    })
    await drain()
    await waitForFile(resolveEventsFile(), '"source":"mirror"')

    const events = await readEvents()
    const mirrored = events.filter((e) => e.source === 'mirror')
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({
      kind: 'activity',
      source: 'mirror',
      channel: 'chat',
      sessionId: 'sess-1',
      payload: { dimension: 'study', category: '阅读', note: '周末学习 ETF 投资知识' },
    })

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { activities: Record<string, { monthCount: number }> }
    expect(summary.activities.study.monthCount).toBe(1)
  })

  it('同一 subCallId 重复投递幂等；失败派发（isError）不落账', async () => {
    emitCodeDispatch('sess-1', 'call_00_y:code:1', 'openprism_record_expense', { amount: 35, category: '餐饮' })
    await waitForFile(resolveEventsFile(), '"source":"mirror"')
    emitCodeDispatch('sess-1', 'call_00_y:code:1', 'openprism_record_expense', { amount: 35, category: '餐饮' })
    emitCodeDispatch('sess-1', 'call_00_z:code:1', 'openprism_record_expense', { amount: 99, category: '娱乐' }, true)
    await drain()
    const events = await readEvents()
    const mirrored = events.filter((e) => e.source === 'mirror')
    expect(mirrored).toHaveLength(1)
    expect((mirrored[0].payload as Record<string, unknown>).amount).toBe(35)
  })

  it('rebuild：从 code-dispatch 重放，与在线镜像产出同一确定性 id', async () => {
    emitCodeDispatch('sess-B', 'call_00_w:code:1', 'openprism_record_mood', { score: 4 }, false, 1725000000000)
    await waitForFile(resolveEventsFile(), '"source":"mirror"')
    const before = await readEvents()
    const liveIds = before.filter((e) => e.source === 'mirror').map((e) => e.id).sort()
    expect(liveIds).toHaveLength(1)

    const { EventStore } = await import('../src/store.js')
    const { rebuildFromSessions } = await import('../src/rebuild.js')
    const fakeSource = {
      async *entries() {
        yield {
          sessionId: 'sess-B',
          events: [{
            type: 'tool/code-dispatch',
            time: 1725000000000,
            data: {
              rootCallId: 'call_00_w',
              parentCallId: 'call_00_w',
              subCallId: 'call_00_w:code:1',
              name: 'openprism_record_mood',
              arguments: { score: 4 },
              isError: false,
              content: [],
            },
          }],
        }
      },
    }

    const orphan = new EventStore(join(harness.home, 'orphan.jsonl'))
    await orphan.load()
    const result = await rebuildFromSessions(orphan, fakeSource)
    expect(result.mirrored).toBe(1)
    const rebuiltIds = orphan.list().filter((e) => e.source === 'mirror').map((e) => e.id).sort()
    expect(rebuiltIds).toEqual(liveIds)
  })
})

describe('批次1 补充：定时任务端点（面板 ⚙ 设置，D7 2026-08-31）', () => {
  it('GET 默认值、POST 保存落 schedule.json 并热生效、非法输入 400', async () => {
    const initial = await harness.request('/openprism/schedule')
    expect(initial.status).toBe(200)
    const initialBody = JSON.parse(initial.body) as { schedule: { dailyBriefingTime: string }; customized: boolean }
    expect(initialBody.schedule.dailyBriefingTime).toBe('07:00')
    expect(initialBody.customized).toBe(false)

    const saved = await harness.request('/openprism/schedule', { method: 'POST', body: { dailyBriefingTime: '08:30', distillTime: null } })
    expect(saved.status).toBe(200)
    const savedBody = JSON.parse(saved.body) as { description: string }
    expect(savedBody.description).toContain('08:30')
    expect(savedBody.description).toContain('关闭')

    const again = await harness.request('/openprism/schedule')
    const againBody = JSON.parse(again.body) as { schedule: { dailyBriefingTime: string; distillTime: string | null }; customized: boolean }
    expect(againBody.schedule.dailyBriefingTime).toBe('08:30')
    expect(againBody.schedule.distillTime).toBeNull()
    expect(againBody.customized).toBe(true)

    const bad = await harness.request('/openprism/schedule', { method: 'POST', body: { dailyBriefingTime: '25:00' } })
    expect(bad.status).toBe(400)

    // 面板设置持久化：schedule.json 落在 openprism 主目录
    const text = await readFile(join(harness.home, 'openprism', 'schedule.json'), 'utf8')
    expect(text).toContain('"dailyBriefingTime": "08:30"')
  })
})
