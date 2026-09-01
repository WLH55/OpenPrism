/**
 * rebuild：从 dsh 会话日志重放 openprism_* 工具调用，重建全局事件日志中的
 * `mirror` 事件；`source ≠ mirror` 的事件原样保留（3.3）。事件 id 确定性派生，
 * 重复执行与增量运行都幂等（已存在的 id 自动跳过）。
 *
 * 调用凭据有两种形态（与镜像器一致，见 mirror.ts）：直接调用 `tool/call` 与
 * code 预设派发的完成事件 `tool/code-dispatch`（isError=true 的失败派发跳过）。
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
 * 从会话事件提取 openprism_* 调用凭据（直接调用与 code 派发两种形态）。
 * 返回 undefined 表示该事件不是 openprism_* 调用、参数不可解析、或派发失败。
 */
function extractInvocation(event: SessionEventLike): { name: string; raw: Record<string, unknown> } | undefined {
  if (event?.type !== 'tool/call' && event?.type !== 'tool/code-dispatch') return undefined
  const data = event.data as { name?: unknown; arguments?: unknown; isError?: unknown } | undefined
  if (!data || typeof data.name !== 'string') return undefined
  if (!data.name.startsWith('openprism_')) return undefined
  if (event.type === 'tool/code-dispatch' && data.isError === true) return undefined
  let raw: Record<string, unknown> | undefined
  if (typeof data.arguments === 'string') {
    try {
      const parsed = JSON.parse(data.arguments) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
    } catch {
      // 参数不是合法 JSON：与镜像器的跳过语义一致
    }
  } else if (data.arguments !== null && typeof data.arguments === 'object' && !Array.isArray(data.arguments)) {
    raw = data.arguments as Record<string, unknown>
  }
  if (raw === undefined) return undefined
  return { name: data.name, raw }
}

/**
 * 重放所有会话日志中的 openprism_* 调用（tool/call 直接调用 + tool/code-dispatch
 * code 派发）。记录类调用复用 Mirror（确定性 id、幂等）；openprism_correct 调用经
 * applyCorrection 重放（语义幂等：已删除目标被拒、重复同补丁无副作用，可能引入冗余
 * 更正事件--rebuild 是灾备路径，可接受）。
 */
export async function rebuildFromSessions(store: import('./store.js').EventStore, source: SessionLogSource): Promise<RebuildResult> {
  const mirror = new Mirror(store)
  let scannedSessions = 0
  let mirroredBefore = countMirrorEvents(store)
  for await (const entry of source.entries()) {
    scannedSessions += 1
    for (const event of entry.events) {
      const invocation = extractInvocation(event)
      if (invocation === undefined) continue
      try {
        if (invocation.name === 'openprism_correct') {
          const request = parseCorrectionRequest(invocation.raw)
          if (!('error' in request)) {
            await applyCorrection(store, request, { source: 'internal', sessionId: entry.sessionId, recordedAt: event.time })
          }
        } else {
          mirror.handleSessionEvent({ id: entry.sessionId }, event)
        }
      } catch (error) {
        console.warn(`openprism: rebuild 跳过一条调用（${invocation.name}）：${String(error)}`)
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
