/**
 * EventStore（M3 窄接口）：append / loadAll 两个动作，JSONL 实现。
 * - 追加走单一串行队列 + 同步 write({append:true})——单 JS 上下文内无交错；
 * - 加载容忍撕裂尾行（App 被杀留下半行）：丢弃并整文件重写修复。
 * SQLite 替换后端将来实现同一接口即可（设计纪要 M3 的保险）。
 */

import type { File } from 'expo-file-system'
import type { OpenEvent } from '../domain/events'
import { dedupeById, parseEvents } from '../domain/events'

export interface EventStore {
  loadAll(): Promise<OpenEvent[]>
  append(...events: OpenEvent[]): Promise<void>
}

export function createEventStore(getFile: () => File): EventStore {
  let queue: Promise<unknown> = Promise.resolve()
  let cache: OpenEvent[] | null = null

  /** 一切读写排队执行，天然串行。 */
  function enqueue<T>(job: () => T): Promise<T> {
    const run = queue.then(job)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    loadAll: () =>
      enqueue(() => {
        if (cache) return cache
        const file = getFile()
        if (!file.exists) {
          cache = []
          return cache
        }
        const parsed = parseEvents(file.textSync())
        if (parsed.tornTail || parsed.skippedLines > 0) {
          // 修复性重写：只保留有效行（撕裂尾行与坏行一并丢弃）
          file.write(parsed.events.map((e) => JSON.stringify(e)).join('\n') + (parsed.events.length ? '\n' : ''))
        }
        cache = dedupeById(parsed.events)
        return cache
      }),

    append: (...events) =>
      enqueue(() => {
        if (events.length === 0) return
        const file = getFile()
        file.write(
          events.map((e) => JSON.stringify(e)).join('\n') + '\n',
          { append: true },
        )
        if (cache) {
          const fresh = dedupeById([...cache, ...events])
          cache.length = 0
          cache.push(...fresh)
        }
      }),
  }
}
