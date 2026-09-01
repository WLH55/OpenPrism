/**
 * OpenAI 兼容聊天客户端（M6/M7）：一个适配器覆盖 DeepSeek/GLM/Qwen/Moonshot/OpenRouter 等厂商。
 * 流式走 expo/fetch 的 ReadableStream（RN 全局 fetch 不支持流式）；非流式供无头会话（批次 3）。
 * 工具调用片段按 index 累积（OpenAI 流式协议），跨 chunk 的 UTF-8 用带状态的 TextDecoder。
 */

import { fetch } from 'expo/fetch'
import { LlmError, classifyHttpError, toTransportError } from './errors'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  /** assistant 消息携带的工具调用（序列化时映射为 tool_calls）。 */
  toolCalls?: ToolCall[]
  /** tool 消息对应的调用 id（序列化时映射为 tool_call_id）。 */
  toolCallId?: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CompletionRequest {
  baseURL: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  stream?: boolean
  signal?: AbortSignal
}

export interface CompletionResult {
  message: ChatMessage
  finishReason: string | null
}

interface WireMessage {
  role: string
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toWireMessage(m: ChatMessage): WireMessage {
  const wire: WireMessage = { role: m.role, content: m.content }
  if (m.toolCalls?.length) {
    wire.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.function.name, arguments: c.function.arguments },
    }))
  }
  if (m.toolCallId) wire.tool_call_id = m.toolCallId
  return wire
}

export async function chatCompletion(
  req: CompletionRequest,
  onTextDelta?: (text: string) => void,
): Promise<CompletionResult> {
  const base = req.baseURL.replace(/\/+$/, '')
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  const stream = req.stream ?? true
  body.stream = stream

  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })
  } catch (e) {
    throw toTransportError(e)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw classifyHttpError(res.status, text)
  }

  if (!stream) {
    const json = (await res.json()) as {
      choices?: Array<{ message?: WireMessage; finish_reason?: string | null }>
    }
    const choice = json.choices?.[0]
    return { message: fromWire(choice?.message), finishReason: choice?.finish_reason ?? null }
  }

  if (!res.body) throw new LlmError('PROVIDER', '厂商未返回流式响应体')
  return readStream(res.body, req.signal, onTextDelta)
}

interface ToolAcc {
  id: string
  name: string
  args: string
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onTextDelta?: (text: string) => void,
): Promise<CompletionResult> {
  const decoder = makeDecoder()
  const reader = body.getReader()
  let buffer = ''
  let text = ''
  let finishReason: string | null = null
  let done = false
  const toolAcc = new Map<number, ToolAcc>()

  const handleEvent = (data: string): void => {
    if (data === '[DONE]') {
      done = true
      return
    }
    let chunk: {
      choices?: Array<{
        delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
        finish_reason?: string | null
      }>
    }
    try {
      chunk = JSON.parse(data)
    } catch {
      return // 厂商偶尔夹非 JSON 心跳行，忽略
    }
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta
    if (delta?.content) {
      text += delta.content
      onTextDelta?.(delta.content)
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0
      const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' }
      if (tc.id) acc.id = tc.id
      if (tc.function?.name) acc.name = tc.function.name
      if (tc.function?.arguments) acc.args += tc.function.arguments
      toolAcc.set(index, acc)
    }
  }

  try {
    while (!done) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new LlmError('ABORTED', '请求已取消')
      }
      const { done: streamDone, value } = await reader.read()
      if (streamDone) break
      buffer += decoder(value)
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        handleEvent(line.slice(5).trim())
        if (done) break
      }
    }
  } catch (e) {
    throw toTransportError(e)
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, acc]) => acc.id && acc.name)
    .map(([, acc]) => ({
      id: acc.id,
      type: 'function' as const,
      function: { name: acc.name, arguments: acc.args || '{}' },
    }))

  const message: ChatMessage = { role: 'assistant' }
  if (text) message.content = text
  if (toolCalls.length) message.toolCalls = toolCalls
  if (!text && !toolCalls.length) {
    throw new LlmError('PROVIDER', '厂商返回了空响应')
  }
  return { message, finishReason }
}

function fromWire(wire?: WireMessage): ChatMessage {
  if (!wire) return { role: 'assistant' }
  const m: ChatMessage = { role: 'assistant', content: wire.content }
  if (wire.tool_calls?.length) {
    m.toolCalls = wire.tool_calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.function.name, arguments: c.function.arguments },
    }))
  }
  return m
}

/** 带状态的 UTF-8 解码：跨 chunk 的多字节中文不会被截断；无 TextDecoder 时退化为字节直拼。 */
function makeDecoder(): (chunk: Uint8Array) => string {
  if (typeof TextDecoder !== 'undefined') {
    const decoder = new TextDecoder('utf-8')
    return (chunk) => decoder.decode(chunk, { stream: true })
  }
  return (chunk) => {
    let out = ''
    for (const byte of chunk) out += String.fromCharCode(byte)
    return out
  }
}
