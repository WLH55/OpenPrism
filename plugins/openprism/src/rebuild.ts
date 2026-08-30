/**
 * rebuild：从 dsh 会话日志重放 openprism_* 工具调用，重建全局事件日志中的
 * `mirror` 事件；`source ≠ mirror` 的事件原样保留（3.3）。事件 id 确定性派生，
 * 重复执行与增量运行都幂等（已存在的 id 自动跳过）。
 *
 * @module openprism/rebuild
 */

import { Mirror, type SessionEventLike } from './mirror.js'
import { applyCorrection, parseCorrectionRequest } from './corrections.js'

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
 * 重放所有会话日志中的 openprism_* tool/call。记录类调用复用 Mirror（确定性 id、
 * 幂等）；openprism_correct 调用经 applyCorrection 重放（语义幂等：已删除目标被
 * 拒、重复同补丁无副作用，可能引入冗余更正事件——rebuild 是灾备路径，可接受）。
 */
export async function rebuildFromSessions(store: import('./store.js').EventStore, source: SessionLogSource): Promise<RebuildResult> {
  const mirror = new Mirror(store)
  let scannedSessions = 0
  let mirroredBefore = countMirrorEvents(store)
  for await (const entry of source.entries()) {
    scannedSessions += 1
    for (const event of entry.events) {
      if (event?.type !== 'tool/call') continue
      const data = event.data as { name?: unknown; arguments?: unknown } | undefined
      if (!data || typeof data.name !== 'string') continue
      try {
        if (data.name === 'openprism_correct') {
          const raw = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}') as Record<string, unknown>
          const request = parseCorrectionRequest(raw)
          if (!('error' in request)) {
            await applyCorrection(store, request, { source: 'internal', sessionId: entry.sessionId, recordedAt: event.time })
          }
        } else {
          mirror.handleSessionEvent({ id: entry.sessionId }, event)
        }
      } catch (error) {
        console.warn(`openprism: rebuild 跳过一条调用（${data.name}）：${String(error)}`)
      }
    }
    // 批内异步 append 全部落定后再继续（mirror 内部 fire-and-forget）
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
