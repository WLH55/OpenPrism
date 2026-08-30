/**
 * 采集日志（ADR 0003）：always-record 的原始原料，按月分片 append-only，
 * 可按保留策略整月裁剪；提炼产物进全局事件日志并回链 captureId。
 *
 * - `captures-YYYY-MM.jsonl` —— 原料条目；
 * - `processed.jsonl` —— none 决策的记账（record 决策以事件里的 captureId 回链为准，
 *   不记这里——pending = 未回链且未记账）。
 *
 * @module openprism/captures
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Channel } from './events.js'

export interface CaptureEntry {
  id: string
  sessionId: string
  text: string
  channel: Channel
  recordedAt: number
}

/** 确定性 capture id：同一会话事件重放得到同一 id（幂等三路合一，与 mirrorEventId 同理）。 */
export function captureId(sessionId: string, ref: string): string {
  return `cap-${createHash('sha1').update(`${sessionId}\u0000${ref}`).digest('hex').slice(0, 16)}`
}

function monthFile(dir: string, time: number): string {
  const d = new Date(time)
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return join(dir, `captures-${month}.jsonl`)
}

interface ProcessedMark {
  captureId: string
  action: 'none' | 'invalid'
  at: number
}

export class CaptureStore {
  private entries: CaptureEntry[] = []
  private readonly seen = new Set<string>()
  private readonly processed = new Set<string>()
  private loadedOnce = false

  constructor(private readonly dir: string) {}

  async load(): Promise<number> {
    this.entries = []
    this.seen.clear()
    this.processed.clear()
    let files: string[] = []
    try {
      files = (await readdir(this.dir)).filter((f) => f.startsWith('captures-') && f.endsWith('.jsonl')).sort()
    } catch {
      this.loadedOnce = true
      return 0
    }
    for (const file of files) {
      const text = await readFile(join(this.dir, file), 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const entry = JSON.parse(trimmed) as CaptureEntry
          if (typeof entry.id === 'string' && entry.id.length > 0 && typeof entry.text === 'string' && !this.seen.has(entry.id)) {
            this.seen.add(entry.id)
            this.entries.push(entry)
          }
        } catch {
          // 崩溃半行容忍
        }
      }
    }
    const processedText = await readFile(join(this.dir, 'processed.jsonl'), 'utf8').catch(() => '')
    for (const line of processedText.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const mark = JSON.parse(trimmed) as ProcessedMark
        if (typeof mark.captureId === 'string') this.processed.add(mark.captureId)
      } catch {
        // 容忍
      }
    }
    this.loadedOnce = true
    return this.entries.length
  }

  private assertLoaded(): void {
    if (!this.loadedOnce) throw new Error('openprism: CaptureStore 未 load，先调用 load()')
  }

  list(): readonly CaptureEntry[] {
    this.assertLoaded()
    return this.entries
  }

  has(id: string): boolean {
    this.assertLoaded()
    return this.seen.has(id)
  }

  /** 原料落盘（月分片，按 id 幂等）。 */
  async append(entry: CaptureEntry): Promise<boolean> {
    this.assertLoaded()
    if (this.seen.has(entry.id)) return false
    await mkdir(this.dir, { recursive: true })
    await appendFile(monthFile(this.dir, entry.recordedAt), `${JSON.stringify(entry)}\n`, 'utf8')
    this.seen.add(entry.id)
    this.entries.push(entry)
    return true
  }

  /** none/invalid 决策记账：该原料不再进入 pending。 */
  async markProcessed(captureIdValue: string, action: 'none' | 'invalid'): Promise<void> {
    this.assertLoaded()
    if (this.processed.has(captureIdValue)) return
    await mkdir(this.dir, { recursive: true })
    const mark: ProcessedMark = { captureId: captureIdValue, action, at: Date.now() }
    await appendFile(join(this.dir, 'processed.jsonl'), `${JSON.stringify(mark)}\n`, 'utf8')
    this.processed.add(captureIdValue)
  }

  isProcessed(id: string): boolean {
    this.assertLoaded()
    return this.processed.has(id)
  }
}
