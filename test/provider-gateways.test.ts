// provider-gateways：OpenCode Go 网关头（x-opencode-session / 自报 User-Agent）+ 连接测试超时工具。
// 零网络：adapter 用注入 fetch 断言头确实上线；超时用 fake timers 推进（确定性）。

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvFetchResponse, PlatformEnv } from "../src/harness/env";
import { createOpenAICompatAdapter } from "../src/harness/llm/openai-compat";
import { gatewayExtraHeaders, timeoutSignal } from "../src/app/provider-gateways";

describe("gatewayExtraHeaders（OpenCode Go 网关头）", () => {
  it("opencode.ai 与其子域带 x-opencode-session + 自报 User-Agent，sessionKey 原样透传", () => {
    for (const baseURL of ["https://opencode.ai/zen/go/v1", "https://OPENCODE.ai/zen/go/v1", "https://go.opencode.ai/v1"]) {
      const headers = gatewayExtraHeaders(baseURL, "sess-1");
      expect(headers["x-opencode-session"]).toBe("sess-1");
      expect(headers["User-Agent"]).toMatch(/^OpenPrism\//);
    }
  });

  it("其余平台与非法 URL 不加头（含 opencode.ai 出现在域名中段的主机）", () => {
    expect(gatewayExtraHeaders("https://api.deepseek.com", "s")).toEqual({});
    expect(gatewayExtraHeaders("https://opencode.ai.evil.com/v1", "s")).toEqual({});
    expect(gatewayExtraHeaders("https://evil-opencode.ai.example.com/v1", "s")).toEqual({});
    expect(gatewayExtraHeaders("not a url", "s")).toEqual({});
  });
});

describe("adapter 携带网关头（main/server 装配口径）", () => {
  it("extraHeaders 并入请求头：OpenCode Go 会话头随请求实际发出", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const env: PlatformEnv = {
      fetch: (async (_url: string, init?: { headers?: Record<string, string> }): Promise<EnvFetchResponse> => {
        seen.push({ url: _url, headers: init?.headers ?? {} });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ choices: [{ message: { content: "pong" } }] }),
          text: async () => "{}",
        };
      }) as PlatformEnv["fetch"],
      now: () => 0,
      randomUUID: () => "u",
    };
    const baseURL = "https://opencode.ai/zen/go/v1";
    const adapter = createOpenAICompatAdapter(env, {
      baseURL,
      apiKey: "sk-x",
      stream: false,
      extraHeaders: gatewayExtraHeaders(baseURL, "conv-42"),
    });
    await adapter.complete({
      provider: "byok",
      model: "kimi-k3",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${baseURL}/chat/completions`);
    expect(seen[0]!.headers["x-opencode-session"]).toBe("conv-42");
    expect(seen[0]!.headers.Authorization).toBe("Bearer sk-x");
  });
});

describe("timeoutSignal（连接测试总时长兜底）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("到点触发 abort 且 timedOut() 为真；cleanup 后不再触发", () => {
    vi.useFakeTimers();
    const guard = timeoutSignal(1000);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBe(true);

    const guard2 = timeoutSignal(1000);
    guard2.cleanup();
    vi.advanceTimersByTime(5000);
    expect(guard2.signal.aborted).toBe(false);
    expect(guard2.timedOut()).toBe(false);
  });
});
