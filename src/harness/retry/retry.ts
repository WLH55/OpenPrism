// 重试器（设计 §4.2）：指数退避 + 对称抖动 + Retry-After 优先 + 预算从日志恢复。

import type { LlmFailure, LlmFailureCode } from "../llm/errors";
import { isLlmFailure } from "../llm/errors";
import { defaultSleep } from "../util";

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** 对称抖动比例：delay × (1 - j + 2j × random()) */
  jitterRatio: number;
  retryableCodes: LlmFailureCode[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
};

export function computeRetryDelayMs(
  attempt: number,
  failure: LlmFailure,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  // 厂商 Retry-After 有效且 ≤ maxDelay 时直接采用，不加抖动
  if (failure.retryAfterMs != null && failure.retryAfterMs > 0 && failure.retryAfterMs <= policy.maxDelayMs) {
    return failure.retryAfterMs;
  }
  const base = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jitter = policy.jitterRatio;
  return Math.round(base * (1 - jitter + 2 * jitter * random()));
}

export interface WithRetryDeps {
  policy: RetryPolicy;
  /** 注入以便确定性测试 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** 从日志恢复的已用预算（retryBudgetUsed）——崩溃重启预算不重置 */
  usedRetries?: number;
  /** 每次决定重试时回调（落 llm/retry 事件 + 活体通知） */
  onRetry?(attempt: number, failure: LlmFailure, delayMs: number): void | Promise<void>;
}

export async function withRetry<T>(fn: () => Promise<T>, deps: WithRetryDeps): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  let used = deps.usedRetries ?? 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isLlmFailure(error) || !deps.policy.retryableCodes.includes(error.code)) throw error;
      if (used >= deps.policy.maxRetries) throw error;
      used += 1;
      const delayMs = computeRetryDelayMs(used, error, deps.policy, deps.random);
      await deps.onRetry?.(used, error, delayMs);
      await sleep(delayMs);
    }
  }
}
