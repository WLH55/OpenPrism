/**
 * 会话镜像器：订阅 `session/event`，把 openprism_* 工具调用镜像为全局事件日志的
 * `mirror` 事件（3.1：事件 = openprism_* 工具的 tool/call；会话日志是录入凭据）。
 *
 * 调用有两种会话日志形态，都要认（真机 2026-08-31 核实）：
 * - **直接调用**：`tool/call`，data.name 即 openprism_*，arguments 是模型产出的原始
 *   JSON 字符串；
 * - **code 预设派发**（agent preset = code 时的常态）：模型调用 run_code，在代码里
 *   `tools.openprism_*()` 派发--`tool/call` 的 name 是 run_code，真实凭据在完成事件
 *   `tool/code-dispatch`（arguments 是已解析对象，isError 标记成败）；失败派发不落账。
 *
 * - 事件 id 由 `mirrorEventId(sessionId, callRef, kind)` 确定性派生（callRef = 直接
 *   调用的 callId 或派发的 subCallId，两者都由 dsh 分配、落盘即冻结），append 按 id
 *   幂等，所以镜像器、resume 回填、rebuild 三条路径对同一调用只会产出一条事件；
 * - 载荷经 normalizeRecordArgs 规范化，与工具 execute 的语义一致；模型参数非法时
 *   跳过（execute 会抛同样的错，见 tool/result）；
 * - 记录的 category 存「写入时机的解析结果」；未知分类随即追加 internal 建类事件
 *   （与 v0.3 resolveCategory 的自动建类语义一致）；
 * - resume 会话的种子不触发 session/event（dsh 源码核实）--`backfillSession` 用
 *   session.events() 回补历史（尽力而为，失败只 warn 不影响宿主）。
 *
 * @module openprism/mirror
 */

import type { OpenEvent } from './events.js'
import { mirrorEventId, randomEventId } from './store.js'
import { foldEvents, type FoldedState } from './fold.js'
import { RECORD_TOOL_NAMES, normalizeRecordArgs } from './records.js'
import { captureId, type CaptureEntry, type CaptureStore } from './captures.js'
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
  /** 从 request/header 事件捕获的模型路由（提炼器用；dsh 源码核实 header.config）。 */
  private route: { provider: string; model: string } | undefined

  constructor(
    private readonly store: import('./store.js').EventStore,
    private readonly captures?: CaptureStore,
  ) {
    this.fold = foldEvents(store.list())
  }

  /** 提炼器用的模型路由（主对话最近一次 request/header）。 */
  getRoute(): { provider: string; model: string } | undefined {
    return this.route
  }

  private refresh(): void {
    this.fold = foldEvents(this.store.list())
  }

  /** cordis `ctx.on('session/event', mirror.handleSessionEvent)` 的处理器。 */
  readonly handleSessionEvent = (session: MirrorSessionLike, event: SessionEventLike): void => {
    try {
      this.handleEventLike(session, event)
    } catch (error) {
      // 镜像失败不得影响宿主会话（dsh 对 emit 监听器已有容错，这里双保险）
      console.warn(`openprism: 镜像事件失败：${String(error)}`)
    }
  }

  private handleEventLike(session: MirrorSessionLike, event: SessionEventLike): void {
    if (event.type === 'tool/call') this.mirrorToolCall(session, event)
    else if (event.type === 'tool/code-dispatch') this.mirrorCodeDispatch(session, event)
    else if (event.type === 'user/message') this.captureUserMessage(session, event)
    else if (event.type === 'request/header') this.captureRoute(event)
  }

  /** resume/插件晚启动：回填该会话历史（工具调用镜像 + 用户消息采集 + 路由捕获）。 */
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
        this.handleEventLike(session, event)
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
    let raw: Record<string, unknown>
    try {
      const parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}') as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      raw = parsed as Record<string, unknown>
    } catch {
      return
    }
    this.appendRecordEvent(session, event, callId, kind, raw)
  }

  /**
   * code 预设派发的镜像：模型经 run_code 间接调用 openprism_* 工具时，`tool/call`
   * 的 name 是 run_code，真实凭据是完成事件 `tool/code-dispatch`。只认完成事件且
   * isError !== true（失败的派发在 tool/code-dispatch 里带错误结果，不构成记录）；
   * arguments 是 dsh 已解析绑定的对象（与 tool/call 的原始 JSON 字符串不同）。
   */
  private mirrorCodeDispatch(session: MirrorSessionLike, event: SessionEventLike): void {
    const data = event.data as { name?: unknown; arguments?: unknown; subCallId?: unknown; isError?: unknown } | undefined
    if (!data) return
    if (data.isError === true) return
    const name = typeof data.name === 'string' ? data.name : undefined
    const subCallId = typeof data.subCallId === 'string' ? data.subCallId : undefined
    if (!name || !subCallId) return
    const kind = RECORD_TOOL_NAMES[name]
    if (!kind) return
    if (data.arguments === null || typeof data.arguments !== 'object' || Array.isArray(data.arguments)) return
    this.appendRecordEvent(session, event, subCallId, kind, data.arguments as Record<string, unknown>)
  }

  /** 直接调用与 code 派发共用的落账尾巴：规范化 -> 确定性 id -> 幂等追加 -> 自动建类。 */
  private appendRecordEvent(
    session: MirrorSessionLike,
    event: SessionEventLike,
    callRef: string,
    kind: 'expense' | 'mood' | 'activity',
    raw: Record<string, unknown>,
  ): void {
    const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : 'unknown-session'
    const id = mirrorEventId(sessionId, callRef, kind)
    if (this.store.has(id)) return
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

  // ─── 采集（5.1/5.2：always-record 用户消息 → 采集日志） ───

  private captureUserMessage(session: MirrorSessionLike, event: SessionEventLike): void {
    if (!this.captures) return
    const data = event.data as {
      id?: unknown
      content?: Array<{ type?: unknown; text?: unknown }>
      source?: { kind?: unknown }
    } | undefined
    if (!data) return
    // 合成注入（schedule/插件 followup）不采集——防止提炼回环（dsh 源码核实 source.kind）
    if (data.source?.kind !== undefined && data.source.kind !== 'user') return
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n').trim()
      : ''
    if (text.length === 0) return
    const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : 'unknown-session'
    const ref = typeof data.id === 'string' && data.id.length > 0 ? data.id : `${event.time ?? ''}`
    const entry: CaptureEntry = {
      id: captureId(sessionId, ref),
      sessionId,
      text,
      channel: 'chat',
      recordedAt: typeof event.time === 'number' ? event.time : Date.now(),
    }
    void this.captures.append(entry).catch((error: unknown) => {
      console.warn(`openprism: 采集落盘失败：${String(error)}`)
    })
  }

  /** 捕获主对话的模型路由（header.config: LlmCallConfig），供夜间提炼使用。 */
  private captureRoute(event: SessionEventLike): void {
    const data = event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined
    const config = data?.header?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      this.route = { provider: config.provider, model: config.model }
    }
  }
}
