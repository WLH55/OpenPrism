import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatlogConnector } from '../src/chatlog.js'
import { CaptureStore } from '../src/captures.js'
import { webhookDelivery, noopDelivery } from '../src/delivery.js'
import { distillPending } from '../src/distill.js'
import { EventStore } from '../src/store.js'

async function makeStores(): Promise<{ home: string; captures: CaptureStore; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'openprism-b6-'))
  const captures = new CaptureStore(join(home, 'captures'))
  await captures.load()
  return { home, captures, cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

const CHATLOG_RESPONSE = {
  messages: [
    { MsgId: 9001, createTime: 1756500000, talker: 'wxid_friend1', content: '今天午饭花了 30' },
    { MsgId: 9002, createTime: 1756500600, talker: 'wxid_friend1', content: '<sysmsg>不是文本</sysmsg>' },
    { MsgId: 9003, createTime: 1756501200, talker: 'wxid_friend2', message: '打卡！心情 5 分' },
  ],
}

describe('ChatlogConnector', () => {
  it('拉取 → 灌入采集日志（wechat 渠道）→ 游标推进 → 幂等', async () => {
    const { home, captures, cleanup } = await makeStores()
    try {
      const fetchImpl = (async () => new Response(JSON.stringify(CHATLOG_RESPONSE), { status: 200 })) as typeof fetch
      const connector = new ChatlogConnector('http://127.0.0.1:5030', captures, join(home, 'captures'), fetchImpl)
      await connector.load()

      const result = await connector.poll()
      expect(result.ran).toBe(true)
      expect(result.fetched).toBe(3)
      expect(result.appended).toBe(2) // 非文本被跳过

      const entries = captures.list()
      expect(entries.filter((c) => c.channel === 'wechat')).toHaveLength(2)
      expect(entries[0].sessionId).toBe('chatlog:wxid_friend1')
      expect(entries[0].recordedAt).toBe(1756500000 * 1000) // 秒 → 毫秒

      // 重跑：游标去重，不再追加
      const again = await connector.poll()
      expect(again.appended).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('提炼管线消化 wechat 渠道原料（连接器 → 提炼 → extraction 事件）', async () => {
    const { home, captures, cleanup } = await makeStores()
    try {
      const fetchImpl = (async () => new Response(JSON.stringify(CHATLOG_RESPONSE), { status: 200 })) as typeof fetch
      const connector = new ChatlogConnector('http://127.0.0.1:5030', captures, join(home, 'captures'), fetchImpl)
      await connector.load()
      await connector.poll()

      const store = new EventStore(join(home, 'events.jsonl'))
      await store.load()
      const wechatEntry = captures.list().find((c) => c.channel === 'wechat')!
      const report = await distillPending({
        store, captures,
        route: { provider: 'd', model: 'm' },
        llm: { complete: async (o) => JSON.stringify([{ action: 'record', captureId: wechatEntry.id, kind: 'expense', payload: { amount: 30, category: '餐饮' } }]) },
      })
      expect(report.recorded).toBe(1)
      const event = store.list().find((e) => e.captureId === wechatEntry.id)!
      expect(event.source).toBe('extraction')
      expect(event.channel).toBe('wechat') // 渠道轴贯通
    } finally {
      await cleanup()
    }
  })

  it('chatlog 不可达：报告 fetched=-1 不抛错', async () => {
    const { home, captures, cleanup } = await makeStores()
    try {
      const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
      const connector = new ChatlogConnector('http://127.0.0.1:59999', captures, join(home, 'captures'), fetchImpl)
      await connector.load()
      const result = await connector.poll()
      expect(result.fetched).toBe(-1)
      expect(captures.list()).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })
})

describe('webhookDelivery', () => {
  it('POST 标题+markdown；失败返回 false', async () => {
    let received: { url: string; body: string } | undefined
    const ok = webhookDelivery('http://hook.test/x', (async (url: string | URL, init?: { body?: string }) => {
      received = { url: String(url), body: init?.body ?? '' }
      return new Response('{}', { status: 200 })
    }) as typeof fetch)
    expect(await ok.deliver('每日简报', 'reports/2026-08/daily.md', '# 每日简报')).toBe(true)
    expect(received?.url).toBe('http://hook.test/x')
    const body = JSON.parse(received!.body) as { title: string; markdown: string; source: string }
    expect(body).toMatchObject({ title: '每日简报', source: 'openprism', markdown: '# 每日简报' })

    const fail = webhookDelivery('http://hook.test/x', (async () => new Response('{}', { status: 500 })) as typeof fetch)
    expect(await fail.deliver('t', 'p', 'm')).toBe(false)
    expect(noopDelivery().deliver('t', 'p', 'm')).resolves.toBe(false)
  })
})
