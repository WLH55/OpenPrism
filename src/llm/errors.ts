/**
 * LLM 错误（规格源自 dsh-llm 的 provider 中立设计）：把各厂商 HTTP/网络错误
 * 翻译成统一错误码，UI 与循环按码处理，不猜厂商文案。
 */

export type LlmErrorCode =
  | 'ABORTED'
  | 'TRANSPORT'
  | 'INVALID_CREDENTIAL'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONTEXT_OVERFLOW'
  | 'PROVIDER'

export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly status?: number

  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
  }
}

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context\s*(?:length|window)/i,
  /maximum\s+context/i,
  /too\s+many\s+tokens/i,
  /prompt\s+is\s+too\s+long/i,
  /input\s+too\s+long/i,
  /exceeds\s+the\s+(?:context|token)/i,
]

const QUOTA_PATTERNS: RegExp[] = [/quota/i, /balance/i, /insufficient/i, /arrear/i, /欠费/, /余额/]

export function classifyHttpError(status: number, body: string): LlmError {
  const detail = body.slice(0, 400)
  if (status === 401 || status === 403) {
    return new LlmError('INVALID_CREDENTIAL', `API Key 无效或无权限（HTTP ${status}）`, status)
  }
  if (status === 402) {
    return new LlmError('QUOTA_EXCEEDED', `账户欠费（HTTP 402）`, status)
  }
  if (status === 429) {
    if (QUOTA_PATTERNS.some((p) => p.test(detail))) {
      return new LlmError('QUOTA_EXCEEDED', '配额或余额耗尽（HTTP 429）', status)
    }
    return new LlmError('RATE_LIMITED', '请求过于频繁（HTTP 429）', status)
  }
  if (status === 400 && CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(detail))) {
    return new LlmError('CONTEXT_OVERFLOW', '上下文超限（HTTP 400）', status)
  }
  if (status >= 500) {
    return new LlmError('PROVIDER', `厂商服务异常（HTTP ${status}）`, status)
  }
  return new LlmError('PROVIDER', `请求被拒绝（HTTP ${status}）：${detail}`, status)
}

export function toTransportError(cause: unknown): LlmError {
  if (cause instanceof LlmError) return cause
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new LlmError('ABORTED', '请求已取消')
  }
  return new LlmError('TRANSPORT', `网络错误：${cause instanceof Error ? cause.message : String(cause)}`)
}

/** 给用户看的中文一句话。 */
export function friendlyLlmMessage(err: LlmError): string {
  switch (err.code) {
    case 'ABORTED':
      return '已取消'
    case 'TRANSPORT':
      return '网络连不上厂商端点，检查网络或 baseURL'
    case 'INVALID_CREDENTIAL':
      return 'API Key 无效——去设置里检查'
    case 'QUOTA_EXCEEDED':
      return '账户配额或余额不足，去厂商控制台看看'
    case 'RATE_LIMITED':
      return '请求太频繁了，稍等再试'
    case 'CONTEXT_OVERFLOW':
      return '对话太长超出模型上下文——新建会话或稍后压缩'
    case 'PROVIDER':
      return err.message
  }
}
