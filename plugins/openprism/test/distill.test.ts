import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, randomEventId } from '../src/store.js'
import { CaptureStore, captureId } from '../src/captures.js'
import { distillPending, extractJsonArray } from '../src/distill.js'
import { foldEvents } from '../src/fold.js'

async function makeStores(): Promise<{ home: string; store: EventStore; captures: CaptureStore; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'openprism-distill-'))
  const store = new EventStore(join(home, 'events.jsonl'))
  await store.load()
  const captures = new CaptureStore(join(home, 'captures'))
  await captures.load()
  return { home, store, captures, cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

describe('CaptureStore', () => {
  it('按月分片落盘 + 往返 + 幂等', async () => {
    const { home, captures, cleanup } = await makeStores()
    try {
      const id1 = captureId('s1', 'msg-1')
      await captures.append({ id: id1, sessionId: 's1', text: '打车花了30', channel: 'chat', recordedAt: Date.UTC(2026, 7, 15) })
      await captures.append({ id: 'cap-x', sessionId: 's1', text: '八月前的事', channel: 'chat', recordedAt: Date.UTC(2026, 6, 1) })
      expect(await captures.append({ id: id1, sessionId: 's1', text: '打车花了30', channel: 'chat', recordedAt: Date.UTC(2026, 7, 15) })).toBe(false)

      const files = await readdir(join(home, 'captures'))
      expect(files.filter((f) => f.startsWith('captures-'))).toHaveLength(2) // 7月 + 8月

      const reread = new CaptureStore(join(home, 'captures'))
      expect(await reread.load()).toBe(2)
      expect(reread.list().map((c) => c.id).sort()).toEqual([id1, 'cap-x'].sort())
    } finally {
      await cleanup()
    }
  })

  it('markProcessed 记账后不再 pending（重启后仍生效）', async () => {
    const { home, captures, cleanup } = await makeStores()
    try {
      await captures.append({ id: 'cap-1', sessionId: 's1', text: 'x', channel: 'chat', recordedAt: Date.now() })
      await captures.markProcessed('cap-1', 'none')
      expect(captures.isProcessed('cap-1')).toBe(true)

      const reread = new CaptureStore(join(home, 'captures'))
      await reread.load()
      expect(reread.isProcessed('cap-1')).toBe(true)
    } finally {
      await cleanup()
    }
  })
})

describe('extractJsonArray', () => {
  it('剥代码围栏与杂讯', () => {
    const text = '好的，以下是结果：\n```json\n[{"action":"none","captureId":"cap-1"}]\n```\n完毕'
    expect(extractJsonArray(text)).toEqual([{ action: 'none', captureId: 'cap-1' }])
  })
  it('无数组返回空', () => {
    expect(extractJsonArray('我不知道')).toEqual([])
  })
})

describe('distillPending', () => {
  it('record 决策 → extraction 事件回链 captureId；none → 记账；两轮不重复处理', async () => {
    const { store, captures, cleanup } = await makeStores()
    try {
      const c1 = captureId('s1', 'm1')
      const c2 = captureId('s1', 'm2')
      await captures.append({ id: c1, sessionId: 's1', text: '打车花了30', channel: 'chat', recordedAt: Date.now() - 1000 })
      await captures.append({ id: c2, sessionId: 's1', text: '今天天气不错', channel: 'chat', recordedAt: Date.now() })

      const llm = async (call: { prompt: string }) => JSON.stringify([
        { action: 'record', captureId: c1, kind: 'activity', payload: { dimension: 'life', category: '出行', durationMinutes: 20 } },
        { action: 'none', captureId: c2 },
      ])
      let called = 0
      const report = await distillPending({
        store,
        captures,
        route: { provider: 'deepseek', model: 'chat' },
        llm: { complete: async (options) => { called += 1; return llm(options) } },
      })
      expect(report).toMatchObject({ ran: true, recorded: 1, none: 1, invalid: 0 })
      expect(called).toBe(1)

      const events = store.list()
      const extracted = events.find((e) => e.captureId === c1)!
      expect(extracted).toMatchObject({ kind: 'activity', source: 'extraction', sessionId: 's1' })
      expect(captures.isProcessed(c2)).toBe(true)
      expect(captures.isProcessed(c1)).toBe(false) // record 靠事件回链，不靠记账

      // 二轮：无 pending（c1 已回链，c2 已记账）
      const report2 = await distillPending({ store, captures, route: { provider: 'd', model: 'm' }, llm: { complete: async () => '[]' } })
      expect(report2).toMatchObject({ ran: false, reason: 'no-pending' })
      expect(called).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('已录事件摘要进 prompt（去重上下文）+ 提炼事件带 occurredAt', async () => {
    const { store, captures, cleanup } = await makeStores()
    try {
      await store.append({
        id: randomEventId('e'), kind: 'expense', source: 'mirror', sessionId: 's0',
        recordedAt: Date.now(), payload: { amount: 35, category: '餐饮' },
      })
      const c1 = captureId('s1', 'm1')
      await captures.append({ id: c1, sessionId: 's1', text: '前天买书花了80', channel: 'chat', recordedAt: Date.now() })

      let seenPrompt = ''
      const report = await distillPending({
        store, captures,
        route: { provider: 'd', model: 'm' },
        llm: { complete: async (o) => { seenPrompt = o.prompt; return JSON.stringify([{ action: 'record', captureId: c1, kind: 'expense', payload: { amount: 80, category: '学习' }, occurredAt: '2026-08-29' }]) } },
      })
      expect(report.recorded).toBe(1)
      expect(seenPrompt).toContain('支出 ¥35.00（餐饮）')
      expect(seenPrompt).toContain(`#cap:${c1}`)

      const event = store.list().find((e) => e.captureId === c1)!
      expect(event.occurredAt).toBe(Date.parse('2026-08-29'))
      expect(foldEvents(store.list()).records.find((r) => r.id === event.id)!.occurredAt).toBe(Date.parse('2026-08-29'))
    } finally {
      await cleanup()
    }
  })

  it('无路由/无 LLM/无 pending 的短路行为', async () => {
    const { store, captures, cleanup } = await makeStores()
    try {
      expect(await distillPending({ store, captures })).toMatchObject({ ran: false, reason: 'no-pending' })
      await captures.append({ id: 'cap-1', sessionId: 's1', text: 'x', channel: 'chat', recordedAt: Date.now() })
      expect(await distillPending({ store, captures })).toMatchObject({ ran: false, reason: 'no-route' })
      expect(await distillPending({ store, captures, route: { provider: 'd', model: 'm' } })).toMatchObject({ ran: false, reason: 'no-llm' })
    } finally {
      await cleanup()
    }
  })

  it('非法决策计数且不落库；LLM 抛错时原料保留重试', async () => {
    const { store, captures, cleanup } = await makeStores()
    try {
      const c1 = captureId('s1', 'm1')
      await captures.append({ id: c1, sessionId: 's1', text: 'x', channel: 'chat', recordedAt: Date.now() })
      const report = await distillPending({
        store, captures,
        route: { provider: 'd', model: 'm' },
        llm: { complete: async () => JSON.stringify([{ action: 'record', captureId: c1, kind: 'alien', payload: {} }, { action: 'whatever' }]) },
      })
      expect(report).toMatchObject({ ran: true, recorded: 0, invalid: 2 })
      expect(store.list().filter((e) => e.captureId === c1)).toHaveLength(0)

      // LLM 抛错：不记账，可重试
      const failing = await distillPending({ store, captures, route: { provider: 'd', model: 'm' }, llm: { complete: async () => { throw new Error('boom') } } })
      expect(failing.ran).toBe(false)
      expect(captures.isProcessed(c1)).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
