/**
 * 会话镜像器：订阅 `session/event`，把 openprism_* 工具调用镜像为全局事件日志的
 * `mirror` 事件（3.1：事件 = openprism_* 工具的 tool/call；会话日志是录入凭据）。
 *
 * - 事件 id 由 `mirrorEventId(sessionId, callId, kind)` 确定性派生——callId 由模型分配、
 *   落盘即冻结（dsh 源码核实），append 按 id 幂等，所以镜像器、resume 回填、rebuild
 *   三条路径对同一调用只会产出一条事件；
 * - 载荷经 normalizeRecordArgs 规范化，与工具 execute 的语义一致；模型参数非法时
 *   跳过（execute 会抛同样的错，见 tool/result）；
 * - 记录的 category 存「写入时机的解析结果」；未知分类随即追加 internal 建类事件
 *   （与 v0.3 resolveCategory 的自动建类语义一致）；
 * - resume 会话的种子不触发 session/event（dsh 源码核实）——`backfillSession` 用
 *   session.events() 回补历史（尽力而为，失败只 warn 不影响宿主）。
 *
 * @module openprism/mirror
 */

import type { OpenEvent } from './events.js'
import { mirrorEventId, randomEventId } from './store.js'
import { foldEvents, type FoldedState } from './fold.js'
import { RECORD_TOOL_NAMES, normalizeRecordArgs } from './records.js'
import type { CategoryDimension } from './types.js'

/** dsh 会话事件的最小结构面（真实 dsh 事件是它的超集）。 */
export interface SessionEventLike {
  type: string
  time?: number
  data: unknown
}

export interface MirrorSessionLike {
  id?: string
  /** resume 回填用：dsh Session.events 是只读数组属性；兼容函数形式（测试桩）。 */
  events?: unknown
}

export class Mirror {
  private fold: FoldedState

  constructor(private readonly store: import('./store.js').EventStore) {
    this.fold = foldEvents(store.list())
  }

  private refresh(): void {
    this.fold = foldEvents(this.store.list())
  }

  /** cordis `ctx.on('session/event', mirror.handleSessionEvent)` 的处理器。 */
  readonly handleSessionEvent = (session: MirrorSessionLike, event: SessionEventLike): void => {
    try {
      if (event.type === 'tool/call') this.mirrorToolCall(session, event)
    } catch (error) {
      // 镜像失败不得影响宿主会话（dsh 对 emit 监听器已有容错，这里双保险）
      console.warn(`openprism: 镜像事件失败：${String(error)}`)
    }
  }

  /** resume/插件晚启动：回填该会话历史里的 openprism_* 调用。 */
  async backfillSession(session: MirrorSessionLike): Promise<void> {
    const source: unknown = session.events
    let history: unknown
    try {
      if (Array.isArray(source)) history = source
      else if (typeof source === 'function') history = await (source as () => unknown)()
      else return
    } catch (error) {
      console.warn(`openprism: 会话 ${String(session.id)} 回填失败：${String(error)}`)
      return
    }
    if (!Array.isArray(history)) return
    for (const event of history as SessionEventLike[]) {
      try {
        if (event?.type === 'tool/call') this.mirrorToolCall(session, event)
      } catch (error) {
        console.warn(`openprism: 会话 ${String(session.id)} 回填单条失败：${String(error)}`)
      }
    }
  }

  private mirrorToolCall(session: MirrorSessionLike, event: SessionEventLike): void {
    const data = event.data as { name?: unknown; arguments?: unknown; callId?: unknown } | undefined
    if (!data) return
    const name = typeof data.name === 'string' ? data.name : undefined
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    if (!name || !callId) return
    const kind = RECORD_TOOL_NAMES[name]
    if (!kind) return
    const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : 'unknown-session'
    const id = mirrorEventId(sessionId, callId, kind)
    if (this.store.has(id)) return

    let raw: Record<string, unknown>
    try {
      const parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}') as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      raw = parsed as Record<string, unknown>
    } catch {
      return
    }
    const normalized = normalizeRecordArgs(kind, raw)
    if (!normalized.ok) return // 非法参数：execute 会抛同样的错并出现在 tool/result

    const recordEvent = {
      id,
      kind,
      source: 'mirror',
      channel: 'chat',
      sessionId,
      recordedAt: typeof event.time === 'number' ? event.time : Date.now(),
      ...(normalized.occurredAt !== undefined ? { occurredAt: normalized.occurredAt } : {}),
      payload: normalized.payload,
    } as OpenEvent
    void this.store.append(recordEvent).then((appended) => {
      if (!appended) return
      this.ensureCategory(kind, normalized.payload)
      this.refresh()
    })
  }

  /** 未知分类自动建类（internal 来源，3.3）——与 v0.3 resolveCategory 语义一致。 */
  private async ensureCategory(kind: 'expense' | 'mood' | 'activity', payload: import('./events.js').ExpensePayload | import('./events.js').MoodPayload | import('./events.js').ActivityPayload): Promise<void> {
    const dimension: CategoryDimension | undefined =
      kind === 'expense' ? 'finance' : kind === 'activity' ? (payload as import('./events.js').ActivityPayload).dimension : undefined
    if (!dimension) return
    const category = (payload as { category: string }).category
    const canonical = this.fold.resolveCategory(dimension, category)
    if (this.fold.categories[dimension].includes(canonical)) return
    await this.store.append({
      id: randomEventId('c', () => Date.now()),
      kind: 'category',
      source: 'internal',
      recordedAt: Date.now(),
      payload: { op: 'create', dimension, name: canonical },
    })
  }
}
