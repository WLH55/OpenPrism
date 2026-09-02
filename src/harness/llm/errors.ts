// LlmFailure：一切厂商错误归一为统一码表（设计 §4.1）。
// 适配器边界之外不允许任何原始错误形态进入循环。

export type LlmFailureCode =
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMIT"
  | "SERVER"
  | "TIMEOUT"
  | "TRANSPORT"
  | "EMPTY_RESPONSE"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "INVALID_REQUEST"
  | "ABORTED";

export interface LlmFailure {
  name: "LlmFailure";
  code: LlmFailureCode;
  message: string;
  status?: number;
  /** 厂商 Retry-After（毫秒）；重试器在有效且 ≤ maxDelay 时直接采用 */
  retryAfterMs?: number;
}

export function llmFailure(
  code: LlmFailureCode,
  message: string,
  extra?: { status?: number; retryAfterMs?: number },
): LlmFailure {
  return {
    name: "LlmFailure",
    code,
    message,
    ...(extra && extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra && extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
  };
}

export function isLlmFailure(error: unknown): error is LlmFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "LlmFailure" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

// 溢出文案识别：4 类模式，覆盖主流 OpenAI 兼容厂商的 400 报错（设计 §4.1）。
const OVERFLOW_PATTERNS: RegExp[] = [
  /maximum\s+context\s+length/i,
  /context\s+length\s+is\s+too\s+long/i,
  /prompt\s+is\s+too\s+long/i,
  /exceeds?\s+(?:the\s+)?context\s+window|context\s+window\s+(?:is\s+)?exceeded/i,
];

export function looksLikeContextOverflow(text: string): boolean {
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

// 余额/配额文案识别（401/403 之外的 4xx 先于状态码判断）。
const QUOTA_PATTERNS: RegExp[] = [
  /insufficient\s+(?:balance|quota|credits?)/i,
  /balance\s+is\s+insufficient/i,
  /exceeded\s+your\s+(?:current\s+)?quota/i,
];

export function looksLikeQuota(text: string): boolean {
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

export function isAbortLike(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
