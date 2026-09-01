/**
 * 会话日志：App 内一次对话的消息与工具调用序列（CONTEXT.md「会话日志」），
 * 每会话一个 JSONL，仅追加，供回看与排错——事件由工具执行直接落事件日志，这里不是重建源。
 */

import type { ToolCall } from '../llm/client'
import { sessionFile } from './paths'

export interface StoredMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  at: number
}

const seqCounters = new Map<string, number>()

function nextSeq(sessionId: string): number {
  const known = seqCounters.get(sessionId)
  if (known !== undefined) {
    const next = known + 1
    seqCounters.set(sessionId, next)
    return next
  }
  // 冷启动：按已有行数初始化计数器
  const file = sessionFile(sessionId)
  let seq = 0
  if (file.exists) {
    const text = file.textSync()
    seq = text.length ? text.split('\n').filter((l) => l.trim()).length : 0
  }
  seqCounters.set(sessionId, seq)
  return nextSeq(sessionId)
}

export function appendMessage(
  sessionId: string,
  message: Omit<StoredMessage, 'seq' | 'at'>,
  now: number,
): void {
  const file = sessionFile(sessionId)
  const stored: StoredMessage = { ...message, seq: nextSeq(sessionId), at: now }
  file.write(JSON.stringify(stored) + '\n', { append: true })
}

export function loadSession(sessionId: string): StoredMessage[] {
  const file = sessionFile(sessionId)
  if (!file.exists) {
    seqCounters.set(sessionId, 0)
    return []
  }
  const messages: StoredMessage[] = []
  let seq = 0
  for (const line of file.textSync().split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as StoredMessage)
      seq += 1
    } catch {
      // 撕裂尾行：跳过（会话日志是回看材料，不做修复性重写）
    }
  }
  seqCounters.set(sessionId, seq)
  return messages
}
