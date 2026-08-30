import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { resolveEventsFile, resolveOpenPrismHome } from '../src/home.js'
import { captureId } from '../src/captures.js'
import { distillPending, type DistillLlmPort } from '../src/distill.js'
import { createHarness, drain, waitForFile, type Harness } from './harness.js'

let harness: Harness

/** 轮询等待采集日志目录下任一月分片包含指定内容。 */
async function waitForCaptures(contains: string, timeout = 3000): Promise<string> {
  const dir = join(resolveOpenPrismHome(), 'captures')
  const start = Date.now()
  let text = ''
  while (Date.now() - start < timeout) {
    try {
      const files = (await readdir(dir)).filter((f) => f.startsWith('captures-') && f.endsWith('.jsonl'))
      text = ''
      for (const file of files) {
        text += await readFile(join(dir, file), 'utf8')
      }
      if (text.includes(contains)) return text
    } catch {
      // 目录未建
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitForCaptures 超时（${contains}）`)
}

beforeEach(async () => {
  harness = await createHarness()
  await apply(harness.ctx as never)
})

afterEach(async () => {
  await harness.cleanup()
})

function emitUserMessage(sessionId: string, messageId: string, text: string, time = Date.now(), sourceKind = 'user'): void {
  harness.emit('session/event', { id: sessionId }, {
    type: 'user/message',
    time,
    data: {
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
    },
  })
}

describe('批次3 E2E：捕获 → 采集日志 → 提炼 → 面板', () => {
  it('用户消息落采集日志（月分片）；合成注入（plugin 来源）不采集', async () => {
    emitUserMessage('sess-1', 'm1', '今天跑步 5 公里')
    emitUserMessage('sess-1', 'm2', '系统提醒：该喝水了', Date.now(), 'plugin')
    const text = await waitForCaptures('跑步')
    expect(text).toContain('今天跑步 5 公里')
    expect(text).not.toContain('该喝水了')
    expect(text).toContain(captureId('sess-1', 'm1'))
  })

  it('直录 + 捕获共存：提炼时 LLM 收到已录摘要，重复事实判 none 由记账承担', async () => {
    const { lastAppliedStores } = await import('../src/index.js')
    // 直录一笔
    harness.emit('session/event', { id: 'sess-1' }, {
      type: 'tool/call', time: Date.now(),
      data: { callId: 'c1', name: 'openprism_record_expense', arguments: JSON.stringify({ amount: 35, category: '餐饮' }) },
    })
    await waitForFile(resolveEventsFile(), '"source":"mirror"')
    // 用户又说起同一笔（应被提炼判 none）
    emitUserMessage('sess-1', 'm1', '对了中午那顿花了35')
    await waitForCaptures('那顿花了35')

    const { store, captures } = lastAppliedStores()!

    let seenPrompt = ''
    const llm: DistillLlmPort = {
      complete: async (o) => {
        seenPrompt = o.prompt
        return JSON.stringify([{ action: 'none', captureId: captureId('sess-1', 'm1') }])
      },
    }
    const report = await distillPending({ store, captures, route: { provider: 'd', model: 'm' }, llm })
    expect(report).toMatchObject({ ran: true, recorded: 0, none: 1 })
    expect(seenPrompt).toContain('支出 ¥35.00（餐饮）') // 已录摘要进 prompt
    expect(seenPrompt).toContain('那顿花了35')

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number } }
    expect(summary.finance.monthTotal).toBe(35) // 没有重复记录
  })

  it('提炼出的 expense 进面板（source: extraction → 折叠 → monthTotal）', async () => {
    const { lastAppliedStores } = await import('../src/index.js')
    emitUserMessage('sess-1', 'm1', '打车去机场花了 60')
    await waitForCaptures('打车')

    const { store, captures } = lastAppliedStores()!

    const llm: DistillLlmPort = {
      complete: async (o) => {
        const capId = /#cap:(cap-[0-9a-f]+)/.exec(o.prompt)?.[1]
        return JSON.stringify([
          { action: 'record', captureId: capId, kind: 'expense', payload: { amount: 60, category: '交通', note: '机场' } },
        ])
      },
    }
    const report = await distillPending({ store, captures, route: { provider: 'd', model: 'm' }, llm })
    expect(report.recorded).toBe(1)

    const panel = await harness.request('/openprism/panel.json')
    const summary = JSON.parse(panel.body) as { finance: { monthTotal: number; byCategory: Array<{ category: string; amount: number }> } }
    expect(summary.finance.monthTotal).toBe(60)
    expect(summary.finance.byCategory[0]).toMatchObject({ category: '交通', amount: 60 })

    // 幂等：重跑提炼不重复记录
    const report2 = await distillPending({ store, captures, route: { provider: 'd', model: 'm' }, llm })
    expect(report2).toMatchObject({ ran: false, reason: 'no-pending' })
  })

  it('POST /openprism/distill 端点（无 llm 缝时报告 no-llm）', async () => {
    emitUserMessage('sess-1', 'm1', '随手一句')
    await waitForCaptures("随手一句")
    const res = await harness.request('/openprism/distill', { method: 'POST' })
    expect(res.status).toBe(200)
    const report = JSON.parse(res.body) as { ran: boolean; reason?: string }
    expect(report.ran).toBe(false)
    expect(['no-llm', 'no-route']).toContain(report.reason)
  })

  it('backfill：晚启动插件回填历史会话的工具调用与用户消息', async () => {
    await harness.cleanup()
    harness = await createHarness()
    await apply(harness.ctx as never)
    // 新插件实例收到 session/created（resume 语义）→ 回填历史
    const history = [
      { type: 'user/message', time: Date.now() - 5000, data: { id: 'old-msg', role: 'user', content: [{ type: 'text', text: '昨天买了猫粮 120' }], source: { kind: 'user' } } },
      { type: 'tool/call', time: Date.now() - 4000, data: { callId: 'old-c1', name: 'openprism_record_expense', arguments: JSON.stringify({ amount: 120, category: '猫咪' }) } },
    ]
    harness.emit('session/created', { id: 'sess-old', events: history })
    await drain()
    await new Promise((r) => setTimeout(r, 50))

    const eventsText = await readFile(resolveEventsFile(), 'utf8')
    expect(eventsText).toContain('"amount":120')
    const capturesText = await (async () => {
      const fs = await import('node:fs/promises')
      const dir = join(resolveOpenPrismHome(), 'captures')
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith('captures-'))
      return files.length > 0 ? fs.readFile(join(dir, files[0]), 'utf8') : ''
    })()
    expect(capturesText).toContain('猫粮 120')
  })
})
