/**
 * rebuild：从 dsh 会话日志重放 openprism_* 工具调用，重建全局事件日志中的
 * `mirror` 事件；`source ≠ mirror` 的事件原样保留（3.3）。事件 id 确定性派生，
 * 重复执行与增量运行都幂等（已存在的 id 自动跳过）。
 *
 * @module openprism/rebuild
 */

import { Mirror, type MirrorSessionLike, type SessionEventLike } from './mirror.js'

export interface SessionLogEntry {
  sessionId: string
  events: SessionEventLike[]
}

/** 会话日志来源端口：dsh 文件扫描（session-files.ts）或测试桩。 */
export interface SessionLogSource {
  entries(): AsyncIterable<SessionLogEntry>
}

export interface RebuildResult {
  scannedSessions: number
  mirrored: number
}

/**
 * 重放所有会话日志中的 openprism_* tool/call。复用 Mirror 的规范化与幂等追加，
 * 保证 rebuild 产生的事件与在线镜像逐字节一致。
 */
export async function rebuildFromSessions(store: import('./store.js').EventStore, source: SessionLogSource): Promise<RebuildResult> {
  const mirror = new Mirror(store)
  let scannedSessions = 0
  let mirroredBefore = countMirrorEvents(store)
  for await (const entry of source.entries()) {
    scannedSessions += 1
    const session: MirrorSessionLike = { id: entry.sessionId }
    for (const event of entry.events) {
      if (event?.type === 'tool/call') mirror.handleSessionEvent(session, event)
    }
    // 批内异步 append 全部落定后再继续（handleSessionEvent 内部 fire-and-forget）
    await drainMicrotasks()
  }
  await drainMicrotasks()
  return { scannedSessions, mirrored: countMirrorEvents(store) - mirroredBefore }
}

function countMirrorEvents(store: import('./store.js').EventStore): number {
  return store.list().filter((event) => event.source === 'mirror').length
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
