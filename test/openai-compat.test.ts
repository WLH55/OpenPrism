// H2·openai-compat adapter：非流式映射、SSE 流式累积（中文跨 chunk、工具参数分片）、
// usage 归一、错误码表映射（含溢出正则与 Retry-After）、流空闲看门狗、abort。

import { describe, expect, it } from "vitest";
import type { EnvFetchResponse, EnvFetchRequest, PlatformEnv } from "../src/harness/env";
import type { LlmRequest } from "../src/harness/llm/adapter";
import { createOpenAICompatAdapter } from "../src/harness/llm/openai-compat";
import { isLlmFailure } from "../src/harness/llm/errors";
import { sleep } from "./helpers";

const encoder = new TextEncoder();

function envWith(responder: (url: string, init?: EnvFetchRequest) => Promise<EnvFetchResponse>): PlatformEnv {
  return {
    fetch: responder as PlatformEnv["fetch"],
    now: () => 0,
    randomUUID: () => "u",
  };
}

function jsonResponse(body: unknown): EnvFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, text: string, headers: Record<string, string> = {}): EnvFetchResponse {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => ({}),
    text: async () => text,
  };
}

/** 把整段 SSE 文本按任意字节位置切片成 chunk 流（检验增量 UTF-8 解码） */
function sseResponse(sseText: string, sliceSize = 17): EnvFetchResponse {
  const bytes = encoder.encode(sseText);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += sliceSize) {
    chunks.push(bytes.slice(i, i + sliceSize));
  }
  let cursor = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
    body: {
      getReader: () => ({
        read: async () =>
          cursor < chunks.length
            ? { done: false, value: chunks[cursor++] }
            : { done: true, value: undefined },
      }),
    },
  };
}

const baseRequest: LlmRequest = {
  provider: "p",
  model: "deepseek-chat",
  system: "SYS",
  messages: [
    { role: "user", content: [{ type: "text", text: "你好" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "echo", arguments: { a: 1 } }] },
    { role: "tool_result", callId: "c1", isError: false, content: [{ type: "text", text: "结果" }] },
  ],
  tools: [{ name: "echo", description: "回", parameters: { type: "object" } }],
  maxTokens: 512,
};

describe("非流式", () => {
  it("映射消息/工具/usage；tool_call 参数字符串解析为对象", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = createOpenAICompatAdapter(
      envWith(async (_url, init) => {
        sentBody = JSON.parse(init!.body as string);
        return jsonResponse({
          choices: [
            {
              message: {
                content: "回答",
                tool_calls: [{ id: "c9", function: { name: "echo", arguments: "{\"text\":\"嗨\"}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 40 },
        });
      }),
      { baseURL: "https://api.example.com/v1", apiKey: "k", stream: false },
    );
    const response = await adapter.complete(baseRequest);
    expect(response.message.content).toEqual([
      { type: "text", text: "回答" },
      { type: "tool_call", id: "c9", name: "echo", arguments: { text: "嗨" } },
    ]);
    expect(response.usage).toEqual({ input: 100, output: 7, cacheRead: 40 });
    expect(response.finishReason).toBe("tool_calls");

    const messages = sentBody!.messages as { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }[];
    expect(messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(messages[1]).toEqual({ role: "user", content: "你好" });
    expect(messages[2]!.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "echo", arguments: "{\"a\":1}" } },
    ]);
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "结果" });
    expect(sentBody!.max_tokens).toBe(512);
  });

  it("空完成 → EMPTY_RESPONSE", async () => {
    const adapter = createOpenAICompatAdapter(
      envWith(async () => jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })),
      { baseURL: "https://x/v1", apiKey: "k", stream: false },
    );
    await expect(adapter.complete(baseRequest)).rejects.toMatchObject({ code: "EMPTY_RESPONSE" });
  });
});

describe("SSE 流式", () => {
  it("中文跨 chunk 截断不丢字；工具调用按 index 跨 chunk 累积；usage 从末 chunk 归一", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"你好世界"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ec"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_cache_hit_tokens":6}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const deltas: string[] = [];
    const adapter = createOpenAICompatAdapter(
      envWith(async () => sseResponse(sse)),
      { baseURL: "https://x/v1", apiKey: "k" },
    );
    const response = await adapter.complete(baseRequest, { onTextDelta: (d) => deltas.push(d) });
    expect(deltas.join("")).toBe("你好世界");
    expect(response.message.content).toEqual([
      { type: "text", text: "你好世界" },
      { type: "tool_call", id: "c1", name: "ec", arguments: { a: 1 } },
    ]);
    expect(response.usage).toEqual({ input: 10, output: 3, cacheRead: 6 });
    expect(response.finishReason).toBe("tool_calls");
  });

  it("思维链：流式 reasoning_content 增量累积与回调；回传请求的 wire 映射剔除思维链", async () => {
    let call = 0;
    let secondBody: Record<string, unknown> | undefined;
    const reasoningDeltas: string[] = [];
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"怎么回答"}}]}',
      'data: {"choices":[{"delta":{"content":"答案是 42"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
      'data: [DONE]',
      "",
    ].join("\n\n");
    const adapter = createOpenAICompatAdapter(
      envWith(async (_url, init) => {
        call += 1;
        if (call === 1) return sseResponse(sse, 11); // 切片切开中文，验证增量解码
        secondBody = JSON.parse(init!.body as string);
        return sseResponse('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }),
      { baseURL: "https://x/v1", apiKey: "k" },
    );
    const request: LlmRequest = {
      provider: "p",
      model: "m",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    };
    const response = await adapter.complete(request, {
      onReasoningDelta: (delta) => reasoningDeltas.push(delta),
    });
    expect(reasoningDeltas.join("")).toBe("让我想想怎么回答");
    expect(response.message.reasoning).toBe("让我想想怎么回答");
    expect((response.message.content[0] as { text: string }).text).toBe("答案是 42");

    // 第二轮：带思维链的 assistant 消息回传，wire 上不得出现任何思维链字段
    const messages: import("../src/harness/types").Message[] = [
      request.messages[0]!,
      response.message,
      { role: "user", content: [{ type: "text", text: "再问" }] },
    ];
    await adapter.complete({ ...request, messages });
    const wire = JSON.stringify(secondBody);
    expect(wire).not.toContain("reasoning");
    expect(wire).not.toContain("让我想想");
  });

  it("非流式 reasoning_content / reasoning 字段捕获", async () => {
    const adapter = createOpenAICompatAdapter(
      envWith(async () => jsonResponse({ choices: [{ message: { content: "答", reasoning_content: "推理" }, finish_reason: "stop" }] })),
      { baseURL: "https://x/v1", apiKey: "k", stream: false },
    );
    const response = await adapter.complete({ provider: "p", model: "m", system: "", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] });
    expect(response.message.reasoning).toBe("推理");
  });

  it("多字节中文按单字节切片后重组无损", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"你好吗"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const collected: string[] = [];
    const adapter = createOpenAICompatAdapter(
      envWith(async () => sseResponse(sse, 7)), // 7 字节一切，必然切开中文
      { baseURL: "https://x/v1", apiKey: "k" },
    );
    const response = await adapter.complete(
      { ...baseRequest, messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] },
      { onTextDelta: (d) => collected.push(d) },
    );
    expect((response.message.content[0] as { text: string }).text).toBe("你好吗");
    expect(collected.join("")).toBe("你好吗");
  });
});

describe("错误码表映射", () => {
  async function codeOf(responder: () => Promise<EnvFetchResponse>, signal?: AbortSignal) {
    const adapter = createOpenAICompatAdapter(
      envWith(async () => responder()),
      { baseURL: "https://x/v1", apiKey: "k", stream: false },
    );
    try {
      await adapter.complete(baseRequest, { signal });
      throw new Error("expected failure");
    } catch (error) {
      if (!isLlmFailure(error)) throw error;
      return error;
    }
  }

  it("401/403 → AUTH；余额文案 → QUOTA；429 + Retry-After → RATE_LIMIT（秒转毫秒）", async () => {
    expect((await codeOf(async () => errorResponse(401, "unauthorized"))).code).toBe("AUTH");
    expect((await codeOf(async () => errorResponse(402, "Insufficient balance"))).code).toBe("QUOTA");
    const limited = await codeOf(async () => errorResponse(429, "too many", { "retry-after": "2" }));
    expect(limited.code).toBe("RATE_LIMIT");
    expect(limited.retryAfterMs).toBe(2000);
  });

  it("5xx → SERVER；400 溢出文案 → CONTEXT_WINDOW_EXCEEDED；400 其他 → INVALID_REQUEST", async () => {
    expect((await codeOf(async () => errorResponse(500, "oops"))).code).toBe("SERVER");
    expect(
      (await codeOf(async () => errorResponse(400, "This model's maximum context length is 4096 tokens..."))).code,
    ).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect((await codeOf(async () => errorResponse(400, "bad json"))).code).toBe("INVALID_REQUEST");
  });

  it("fetch 抛错 → TRANSPORT；调用方 abort → ABORTED", async () => {
    const transport = await (async () => {
      const adapter = createOpenAICompatAdapter(
        envWith(async () => {
          throw new TypeError("fetch failed");
        }),
        { baseURL: "https://x/v1", apiKey: "k", stream: false },
      );
      try {
        await adapter.complete(baseRequest);
        throw new Error("expected failure");
      } catch (error) {
        if (!isLlmFailure(error)) throw error;
        return error;
      }
    })();
    expect(transport.code).toBe("TRANSPORT");

    const controller = new AbortController();
    const adapter = createOpenAICompatAdapter(
      envWith(async () => {
        controller.abort();
        throw new TypeError("fetch failed");
      }),
      { baseURL: "https://x/v1", apiKey: "k", stream: false },
    );
    await expect(adapter.complete(baseRequest, { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
  });

  it("流空闲看门狗：chunk 之间静默超时 → TIMEOUT", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"开"}}]\n\n'; // 故意不完整也不结束
    let served = false;
    const adapter = createOpenAICompatAdapter(
      envWith(async () => {
        served = true;
        const bytes = encoder.encode(sse);
        let cursor = 0;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({}),
          text: async () => "",
          body: {
            getReader: () => ({
              read: async () => {
                if (cursor < bytes.length) {
                  const value = bytes.slice(cursor, cursor + 8);
                  cursor += 8;
                  return { done: false, value };
                }
                await sleep(5000); // 之后永远静默
                return { done: true, value: undefined };
              },
            }),
          },
        };
      }),
      { baseURL: "https://x/v1", apiKey: "k", idleTimeoutMs: 40 },
    );
    await expect(adapter.complete(baseRequest)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(served).toBe(true);
  });
});
