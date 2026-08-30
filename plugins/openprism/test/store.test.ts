import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore, mirrorEventId, randomEventId } from '../src/store.js'
import type { OpenEvent } from '../src/events.js'

function expenseEvent(overrides: Partial<OpenEvent> = {}): OpenEvent {
  return {
    id: 'e1',
    kind: 'expense',
    source: 'mirror',
    sessionId: 's1',
    recordedAt: 1725000000000,
    payload: { amount: 35, category: '餐饮' },
    ...overrides,
  } as OpenEvent
}

describe('EventStore', () => {
  it('append 后 load 完整往返', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openprism-store-'))
    try {
      const path = join(dir, 'events.jsonl')
      const store = new EventStore(path)
      await store.load()
      await store.append(expenseEvent())
      await store.append({ ...expenseEvent({ id: 'e2' }), kind: 'mood', payload: { score: 4 } } as OpenEvent)
      const reread = new EventStore(path)
      const stats = await reread.load()
      expect(stats.loaded).toBe(2)
      expect(stats.skippedLines).toBe(0)
      expect(reread.list().map((e) => e.id)).toEqual(['e1', 'e2'])
      expect(reread.list()[1].payload).toEqual({ score: 4 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('append 按 id 幂等：重复 id 不写盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openprism-store-'))
    try {
      const path = join(dir, 'events.jsonl')
      const store = new EventStore(path)
      await store.load()
      expect(await store.append(expenseEvent())).toBe(true)
      expect(await store.append(expenseEvent())).toBe(false)
      const text = await readFile(path, 'utf8')
      expect(text.trim().split('\n')).toHaveLength(1)
      expect(store.list()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('load 尾部容忍：坏行跳过不影响其余事件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openprism-store-'))
    try {
      const path = join(dir, 'events.jsonl')
      await writeFile(path, `${JSON.stringify(expenseEvent())}\n`, 'utf8')
      await appendFile(path, '{"id":"half-line"}\n{"id":"torn"', 'utf8') // 一行非法 + 崩溃半行
      const store = new EventStore(path)
      const stats = await store.load()
      expect(stats.loaded).toBe(1)
      expect(stats.skippedLines).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('拒绝非法事件（payload/source/kind 校验）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openprism-store-'))
    try {
      const store = new EventStore(join(dir, 'events.jsonl'))
      await store.load()
      await expect(store.append(expenseEvent({ payload: { amount: -5, category: 'x' } } as never))).rejects.toThrow(/payload/)
      await expect(store.append(expenseEvent({ source: 'hack' } as never))).rejects.toThrow(/source/)
      await expect(store.append(expenseEvent({ kind: 'alien' } as never))).rejects.toThrow(/kind/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('未 load 直接 append/list 报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openprism-store-'))
    try {
      const store = new EventStore(join(dir, 'events.jsonl'))
      await expect(store.append(expenseEvent())).rejects.toThrow(/load/)
      expect(() => store.list()).toThrow(/load/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('mirrorEventId 确定性：同输入同 id，不同输入不同 id', () => {
    expect(mirrorEventId('sess1', 'call-7', 'expense')).toBe(mirrorEventId('sess1', 'call-7', 'expense'))
    expect(mirrorEventId('sess1', 'call-7', 'expense')).not.toBe(mirrorEventId('sess1', 'call-8', 'expense'))
    expect(mirrorEventId('sess1', 'call-7', 'expense')).not.toBe(mirrorEventId('sess2', 'call-7', 'expense'))
    expect(mirrorEventId('s', 'c', 'expense')).toMatch(/^m-[0-9a-f]{16}$/)
  })

  it('randomEventId 生成不重复 id', () => {
    const a = randomEventId('u')
    const b = randomEventId('u')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^u/)
  })
})
