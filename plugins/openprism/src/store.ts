/**
 * OpenPrism 全局事件日志存储：append-only jsonl，单文件（面板数据唯一持久层，ADR 0002）。
 *
 * - append 按 id 幂等：重复 id 静默跳过（镜像器与工具执行竞态安全、rebuild 稳定）；
 * - load 尾部容忍：崩溃造成的半行跳过，不影响其余事件（3.2）；
 * - 内存持有全量事件（个人量级一年几千条），折叠由 fold.ts 派生。
 * 本模块只用 node:fs —— 不 import 任何 dsh 包。
 *
 * @module openprism/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OpenEvent } from './events.js'
import { validateEvent } from './events.js'

/** 生成非镜像事件（ui/internal/extraction/rule）的随机 id；mirror 事件的 id 由镜像器确定性派生。 */
export function randomEventId(prefix: string, now: () => number = Date.now): string {
  return `${prefix}${now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/** mirror 事件 id 的确定性派生：同一会话日志重放得到同一 id（4.1 的 rebuild 前提）。 */
export function mirrorEventId(sessionId: string, callRef: string, kind: string): string {
  const hash = createHash('sha1').update(`${sessionId}\u0000${callRef}\u0000${kind}`).digest('hex').slice(0, 16)
  return `m-${hash}`
}

export interface StoreStats {
  loaded: number
  skippedLines: number
}

export class EventStore {
  private events: OpenEvent[] = []
  private readonly seen = new Set<string>()
  private loadedOnce = false

  constructor(private readonly filePath: string) {}

  /** 全量读取并解析日志；尾部坏行跳过（崩溃半行容忍）。 */
  async load(): Promise<StoreStats> {
    this.events = []
    this.seen.clear()
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch {
      this.loadedOnce = true
      return { loaded: 0, skippedLines: 0 }
    }
    let skippedLines = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        skippedLines += 1
        continue
      }
      const event = parsed as OpenEvent
      if (validateEvent(event) !== null || this.seen.has(event.id)) {
        skippedLines += 1
        continue
      }
      this.seen.add(event.id)
      this.events.push(event)
    }
    this.loadedOnce = true
    return { loaded: this.events.length, skippedLines }
  }

  private assertLoaded(): void {
    if (!this.loadedOnce) throw new Error('openprism: EventStore 未 load，先调用 load()')
  }

  /** 幂等追加：id 已存在时返回 false 且不写盘。非法事件抛错。
   *  内存占位（seen/内存列表）在首个 await 之前同步完成——并发投递（镜像器/
   *  回填/rebuild 三路）下同一 id 只可能有一个写入者；写盘失败回滚内存并抛错。 */
  async append(event: OpenEvent): Promise<boolean> {
    this.assertLoaded()
    const invalid = validateEvent(event)
    if (invalid) throw new Error(`openprism: 拒绝非法事件——${invalid}`)
    if (this.seen.has(event.id)) return false
    this.seen.add(event.id)
    this.events.push(event)
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      this.seen.delete(event.id)
      this.events = this.events.filter((e) => e.id !== event.id)
      throw error
    }
    return true
  }

  list(): readonly OpenEvent[] {
    this.assertLoaded()
    return this.events
  }

  has(id: string): boolean {
    this.assertLoaded()
    return this.seen.has(id)
  }
}
