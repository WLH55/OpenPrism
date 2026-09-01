/**
 * agent 循环（M6）：消息 → LLM → 工具调用 → 执行 → 回灌，多轮直至收敛。
 * 不依赖 UI——前台对话与将来的无头会话（批次 3）共用同一循环。
 * 系统提示词每次请求动态生成（实时分类/目标注入）；超长历史按尾部截断（压缩是后续演进）。
 */

import type { ResolvedProvider } from '../store/providers'
import type { EventStore } from '../store/eventStore'
import type { ChatMessage } from '../llm/client'
import { chatCompletion } from '../llm/client'
import { foldEvents } from '../domain/fold'
import { buildSystemPrompt } from './prompts'
import { TOOL_DEFINITIONS, executeTool } from './tools'

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'assistant'; message: ChatMessage }
  | { type: 'tool-call'; name: string; args: string }
  | { type: 'tool-result'; name: string; result: string }

export interface LoopDeps {
  provider: ResolvedProvider
  store: EventStore
  sessionId: string
  now(): number
  newId(): string
  /** 发给模型的尾部历史条数上限（超长截断；默认 60）。 */
  historyLimit?: number
  /** 单次对话的最大工具轮数（默认 8）。 */
  maxRounds?: number
  signal?: AbortSignal
}

export interface LoopResult {
  /** 完整历史（旧历史 + 本次新消息，不含 system）。 */
  messages: ChatMessage[]
  /** 本次新增的消息（user / assistant / tool，按发生序——会话日志按此追加）。 */
  newMessages: ChatMessage[]
}

export async function runAgentLoop(
  deps: LoopDeps,
  history: readonly ChatMessage[],
  userText: string,
  onEvent: (event: AgentEvent) => void,
): Promise<LoopResult> {
  const limit = deps.historyLimit ?? 60
  const maxRounds = deps.maxRounds ?? 8
  const newMessages: ChatMessage[] = [{ role: 'user', content: userText }]
  const messages: ChatMessage[] = [...history.slice(-limit), ...newMessages]

  for (let round = 0; round < maxRounds; round++) {
    const folded = foldEvents(await deps.store.loadAll(), deps.now())
    const system: ChatMessage = { role: 'system', content: buildSystemPrompt(folded, deps.now()) }

    const result = await chatCompletion(
      {
        baseURL: deps.provider.baseURL,
        apiKey: deps.provider.apiKey,
        model: deps.provider.model,
        messages: [system, ...messages],
        tools: TOOL_DEFINITIONS,
        stream: true,
        signal: deps.signal,
      },
      (text) => onEvent({ type: 'text-delta', text }),
    )

    const assistant = result.message
    messages.push(assistant)
    newMessages.push(assistant)
    onEvent({ type: 'assistant', message: assistant })

    const toolCalls = assistant.toolCalls ?? []
    if (toolCalls.length === 0) break

    for (const call of toolCalls) {
      onEvent({ type: 'tool-call', name: call.function.name, args: call.function.arguments })
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        // 参数不完整时让工具的校验错误回给模型
      }
      const result2 = await executeTool(call.function.name, args, {
        store: deps.store,
        sessionId: deps.sessionId,
        now: deps.now,
        newId: deps.newId,
      })
      onEvent({ type: 'tool-result', name: call.function.name, result: result2 })
      const toolMessage: ChatMessage = { role: 'tool', toolCallId: call.id, content: result2 }
      messages.push(toolMessage)
      newMessages.push(toolMessage)
    }
  }

  return { messages, newMessages }
}
