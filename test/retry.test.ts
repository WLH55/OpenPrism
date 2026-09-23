// H3·retry 层：白名单、退避数学、抖动边界、Retry-After、预算耗尽与恢复。

import { describe, expect, it } from "vitest";
import { llmFailure } from "../src/harness/llm/errors";
import {
  DEFAULT_RETRY_POLICY,
  computeRetryDelayMs,
  withRetry,
  type RetryPolicy,
} from "../src/harness/retry/retry";

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY };

describe("退避数学", () => {
  it("指数退避 500/1000/2000/4000/8000（封顶 10s），random=0.5 时无偏移", () => {
    const failure = llmFailure("RATE_LIMIT", "x");
    expect(computeRetryDelayMs(1, failure, policy, () => 0.5)).toBe(500);
    expect(computeRetryDelayMs(2, failure, policy, () => 0.5)).toBe(1000);
    expect(computeRetryDelayMs(3, failure, policy, () => 0.5)).toBe(2000);
    expect(computeRetryDelayMs(4, failure, policy, () => 0.5)).toBe(4000);
    expect(computeRetryDelayMs(5, failure, policy, () => 0.5)).toBe(8000);
    expect(computeRetryDelayMs(6, failure, policy, () => 0.5)).toBe(10000); // 封顶
  });

  it("对称抖动：random 0 → ×0.9；random 1 → ×1.1", () => {
    const failure = llmFailure("SERVER", "x");
    expect(computeRetryDelayMs(1, failure, policy, () => 0)).toBe(450);
    expect(computeRetryDelayMs(1, failure, policy, () => 1)).toBe(550);
  });

  it("Retry-After 有效且 ≤ maxDelay 时直接采用、不加抖动；超出则走退避", () => {
    const honored = llmFailure("RATE_LIMIT", "x", { retryAfterMs: 7000 });
    expect(computeRetryDelayMs(1, honored, policy, () => 0)).toBe(7000);
    const tooBig = llmFailure("RATE_LIMIT", "x", { retryAfterMs: 60000 });
    expect(computeRetryDelayMs(1, tooBig, policy, () => 0.5)).toBe(500);
  });
});

describe("withRetry", () => {
  it("白名单外（AUTH）立即抛出，不 sleep", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw llmFailure("AUTH", "no");
        },
        {
          policy,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH" });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("重试到成功；onRetry 收到 attempt/失败/延迟", async () => {
    const sleeps: number[] = [];
    const retries: { attempt: number; code: string; delayMs: number }[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw llmFailure("SERVER", "down");
        return "ok";
      },
      {
        policy,
        random: () => 0.5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        onRetry: (attempt, failure, delayMs) => {
          retries.push({ attempt, code: failure.code, delayMs });
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(retries).toEqual([
      { attempt: 1, code: "SERVER", delayMs: 500 },
      { attempt: 2, code: "SERVER", delayMs: 1000 },
    ]);
  });

  it("预算耗尽后抛出原始失败（maxRetries=3 → 共 4 次调用）", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw llmFailure("TIMEOUT", "slow");
        },
        {
          policy: { ...policy, maxRetries: 3 },
          random: () => 0.5,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(calls).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("恢复的预算立即生效：usedRetries=3 且 maxRetries=3 → 不再重试", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw llmFailure("TRANSPORT", "x");
        },
        { policy: { ...policy, maxRetries: 3 }, usedRetries: 3 },
      ),
    ).rejects.toMatchObject({ code: "TRANSPORT" });
    expect(calls).toBe(1);
  });

  it("非 LlmFailure 的普通错误直接穿透", async () => {
    await expect(
      withRetry(async () => {
        throw new Error("bug");
      }, { policy }),
    ).rejects.toThrow("bug");
  });
});
