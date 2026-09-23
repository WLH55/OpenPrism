// 真实厂商冒烟（设计 §10.4）：环境变量门控，默认不跑。
// 配置来源（二选一）：进程环境变量，或仓库根目录 .env.local（已被 .gitignore 罩住，永不入库）。
//   SMOKE_BASE_URL / SMOKE_API_KEY / SMOKE_MODEL
// 覆盖面：SSE 流式文本往返（含中文）、工具调用两步往返、abort 部分保留、usage 归一。

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlatformEnv } from "../src/harness/env";
import type { LlmRequest, ToolPublicSchema } from "../src/harness/llm/adapter";
import { isLlmFailure } from "../src/harness/llm/errors";
import { createOpenAICompatAdapter } from "../src/harness/llm/openai-compat";
import type { Message } from "../src/harness/types";

// —— env 门控（模块顶层同步判定，缺配置整组跳过）——

function loadDotEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!;
    }
  }
}
loadDotEnvLocal();

const baseURL = process.env.SMOKE_BASE_URL;
const apiKey = process.env.SMOKE_API_KEY;
const model = process.env.SMOKE_MODEL;
const enabled = Boolean(baseURL && apiKey && model);

const env: PlatformEnv = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
};

// 未启用（缺 env）时给占位 baseURL：构造是惰性的不发请求，下面的用例整组跳过（存量问题：顶层无条件构造会在缺配置时崩）。
const adapter = createOpenAICompatAdapter(env, { baseURL: baseURL ?? "https://smoke.invalid", apiKey: apiKey ?? "" });
const TIMEOUT = 60_000;

const echoTool: ToolPublicSchema = {
  name: "echo",
  description: "Echoes the given text back. Use when asked to echo.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "text to echo" } },
    required: ["text"],
  },
};

describe.skipIf(!enabled)("真实厂商冒烟（DeepSeek / deepseek-v4-flash）", () => {
  it(
    "流式文本往返：中文无损、deltas 拼接等于最终文本、usage 归一",
    async () => {
      const request: LlmRequest = {
        provider: "smoke",
        model: model!,
        system: "你是冒烟测试助手。",
        messages: [{ role: "user", content: [{ type: "text", text: "用一句话介绍你自己，不超过 20 个字。" }] }],
        maxTokens: 512,
      };
      const deltas: string[] = [];
      const reasoningDeltas: string[] = [];
      const response = await adapter.complete(request, {
        onTextDelta: (delta) => deltas.push(delta),
        onReasoningDelta: (delta) => reasoningDeltas.push(delta),
      });
      const text = response.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(text.length).toBeGreaterThan(0);
      expect([...text].length).toBeGreaterThan(3); // 中文没有被解码器吞掉
      expect(deltas.join("")).toBe(text); // 流式拼接 == 最终文本
      expect(response.usage).toBeDefined();
      expect(response.usage!.input).toBeGreaterThan(0);
      expect(response.usage!.output).toBeGreaterThan(0);
      expect(response.usage!.cacheRead).toBeGreaterThanOrEqual(0);
      expect(response.finishReason).toBe("stop");
      // reasoning 模型：思维链增量无损、拼接与最终字段一致，且与正文分开
      const reasoning = reasoningDeltas.join("");
      expect(reasoning.length).toBeGreaterThan(0);
      expect(response.message.reasoning).toBe(reasoning);
      // eslint-disable-next-line no-console
      console.log("[smoke] 文本往返:", JSON.stringify(text), "usage:", response.usage);
      // eslint-disable-next-line no-console
      console.log("[smoke] 思维链(前60字):", reasoning.slice(0, 60));
    },
    TIMEOUT,
  );

  it(
    "工具调用两步往返：模型调 echo → 喂回 tool_result → 得到最终回答",
    async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: 'Call the echo tool with text "smoke-ok". Then say done.' }] },
      ];
      const first = await adapter.complete(
        { provider: "smoke", model: model!, system: "You are a test assistant.", messages, tools: [echoTool], maxTokens: 1024 },
      );
      const calls = first.message.content.filter((b): b is { type: "tool_call"; id: string; name: string; arguments: unknown } => b.type === "tool_call");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]!.name).toBe("echo");
      expect((calls[0]!.arguments as { text?: string }).text).toBe("smoke-ok");

      messages.push(first.message);
      messages.push({
        role: "tool_result",
        callId: calls[0]!.id,
        isError: false,
        content: [{ type: "text", text: "smoke-ok" }],
      });
      const second = await adapter.complete(
        { provider: "smoke", model: model!, system: "You are a test assistant.", messages, maxTokens: 512 },
      );
      const answer = second.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(answer.toLowerCase()).toContain("done");
      // eslint-disable-next-line no-console
      console.log("[smoke] 工具往返最终回答:", JSON.stringify(answer));
    },
    TIMEOUT,
  );

  it(
    "abort 部分保留：流中途取消 → LlmFailure(ABORTED)",
    async () => {
      const controller = new AbortController();
      const deltas: string[] = [];
      const request: LlmRequest = {
        provider: "smoke",
        model: model!,
        system: "直接输出内容，不要思考太久。",
        messages: [
          { role: "user", content: [{ type: "text", text: "从 1 数到 30，每行一个数字，直接开始输出。" }] },
        ],
        maxTokens: 1024,
      };
      let failure: unknown;
      try {
        await adapter.complete(request, {
          signal: controller.signal,
          onTextDelta: (delta) => {
            deltas.push(delta);
            if (deltas.join("").length >= 3) controller.abort(); // 收到首批内容即取消
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(isLlmFailure(failure)).toBe(true);
      expect((failure as { code: string }).code).toBe("ABORTED");
      expect(deltas.join("").length).toBeGreaterThan(0); // 确实收到过部分输出
    },
    TIMEOUT,
  );
});
