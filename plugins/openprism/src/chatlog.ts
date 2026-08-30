/**
 * Chatlog 连接器（D8，第一个数据源连接器）：从 chatlog（sjzar/chatlog，微信/QQ
 * 聊天记录解密后的本地 HTTP 服务）拉取消息，灌入采集日志，走同一提炼管线。
 *
 * - 配置 `OPENPRISM_CHATLOG_URL`（如 http://127.0.0.1:5030）后启用；
 * - 游标持久化在 `captures/chatlog-cursor.json`（最后一条消息的记录时间戳），
 *   重启不重复灌入；消息 id 作 capture id 的确定性来源（幂等）；
 * - 字段宽松映射（chatlog 版本间字段名有差异）：id → MsgId/id，时间 → createTime/
 *   timestamp/ts（秒或毫秒），文本 → message/content/text；非文本消息跳过；
 * - 只读外部数据源：连接器永不写 chatlog 侧任何东西。
 *
 * @module openprism/chatlog
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { captureId, type CaptureStore } from './captures.js'

export interface ChatlogMessage {
  id?: unknown
  msgId?: unknown
  MsgId?: unknown
  createTime?: unknown
  timestamp?: unknown
  ts?: unknown
  content?: unknown
  message?: unknown
  text?: unknown
  talker?: unknown
  senderName?: unknown
  [key: string]: unknown
}

export interface ChatlogPollResult {
  ran: boolean
  reason?: 'no-url'
  fetched: number
  appended: number
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10 ** 12 ? value * 1000 : value // 秒 → 毫秒
  }
  return undefined
}

function asId(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

export interface CursorState {
  lastRecordedAt: number
}

export class ChatlogConnector {
  private readonly cursorFile: string
  private lastRecordedAt = 0

  constructor(
    private readonly baseUrl: string,
    private readonly captures: CaptureStore,
    private readonly capturesDir: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly pageSize = 200,
  ) {
    this.cursorFile = join(capturesDir, 'chatlog-cursor.json')
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.cursorFile, 'utf8')
      const state = JSON.parse(text) as CursorState
      if (typeof state.lastRecordedAt === 'number') this.lastRecordedAt = state.lastRecordedAt
    } catch {
      // 首次运行无游标
    }
  }

  private async saveCursor(): Promise<void> {
    await mkdir(this.capturesDir, { recursive: true })
    const state: CursorState = { lastRecordedAt: this.lastRecordedAt }
    await writeFile(this.cursorFile, JSON.stringify(state), 'utf8')
  }

  /** 拉取当日消息并灌入采集日志；游标推进到最后一条成功入库的消息时间。 */
  async poll(now: number = Date.now()): Promise<ChatlogPollResult> {
    const result: ChatlogPollResult = { ran: true, fetched: 0, appended: 0 }
    const day = new Date(now)
    const timeParam = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
    let payload: unknown
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/v1/chat-log?time=${timeParam}&limit=${String(this.pageSize)}`)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      payload = await response.json()
    } catch (error) {
      console.warn(`openprism: chatlog 拉取失败：${String(error)}`)
      result.fetched = -1
      return result
    }
    const items = Array.isArray(payload)
      ? payload as ChatlogMessage[]
      : Array.isArray((payload as { messages?: unknown[] }).messages)
        ? (payload as { messages: ChatlogMessage[] }).messages
        : Array.isArray((payload as { items?: unknown[] }).items)
          ? (payload as { items: ChatlogMessage[] }).items
          : []
    result.fetched = items.length

    let maxSeen = this.lastRecordedAt
    for (const item of items) {
      const text = asText(item.message) || asText(item.content) || asText(item.text)
      // 微信非文本消息（引用/图片/撤回等）在导出里是 XML 串——跳过
      if (text.trim().length === 0 || text.trimStart().startsWith('<')) continue
      const time = asTime(item.createTime) ?? asTime(item.timestamp) ?? asTime(item.ts)
      if (time === undefined) continue
      if (time <= this.lastRecordedAt) continue // 游标去重（captureId 幂等兜底）
      const ref = asId(item.MsgId) || asId(item.msgId) || asId(item.id) || `${time}`
      const talker = asText(item.talker) || asText(item.senderName) || 'unknown'
      const appended = await this.captures.append({
        id: captureId(`chatlog:${talker}`, ref),
        sessionId: `chatlog:${talker}`,
        text: text.trim(),
        channel: 'wechat',
        recordedAt: time,
      })
      if (appended) {
        result.appended += 1
        if (time > maxSeen) maxSeen = time
      }
    }
    if (maxSeen > this.lastRecordedAt) {
      this.lastRecordedAt = maxSeen
      await this.saveCursor()
    }
    return result
  }
}
