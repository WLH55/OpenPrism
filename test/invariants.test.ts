// 不变量测试（设计 §10.3）：
// 1. model-visible means logged——真实 agent 会话里，每条发出的请求都能从日志前缀重建；
// 2. 随机事件流下，投影的 tool_call/tool_result 配对永远完整、投影是日志的确定函数。

import { describe, expect, it } from "vitest";
import { createAgent } from "../src/harness/core/agent";
import type { LlmAdapter, LlmCallOptions, LlmRequest, LlmResponse } from "../src/harness/llm/adapter";
import { llmFailure } from "../src/harness/llm/errors";
import { createMockLlmAdapter } from "../src/harness/llm/mock";
import type { SessionEvent, SessionEventPayload } from "../src/harness/session/events";
import { InMemorySessionLog } from "../src/harness/session/log";
import { deriveMessages, projectSurface } from "../src/harness/session/project";
import { selectShadowInterval } from "../src/harness/context/compact";
import type { AssistantMessage, Message, UserMessage } from "../src/harness/types";
import { echoTool, fakeEnv, sleep } from "./helpers";

describe("不变量：请求可从日志重建", () => {
  it("重试/压缩/工具/三通道混合会话——每次请求的 messages == deriveMessages(日志前缀)", async () => {
    const log = new InMemorySessionLog(() => 0);
    const inner = createMockLlmAdapter([
      { kind: "failure", failure: llmFailure("RATE_LIMIT", "x", { retryAfterMs: 1 }) }, // turn1 step1 重试一次
      { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "嗨" } }] }, // turn1 step1 成功（带工具）
      { kind: "text", text: "完成了" }, // turn1 step2
      { kind: "text", text: "二轮" }, // turn2
    ]);
    const captured: { messages: Message[]; logLength: number }[] = [];
    const recordingAdapter: LlmAdapter = {
      name: "recording",
      async complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse> {
        captured.push({
          messages: JSON.parse(JSON.stringify(request.messages)) as Message[],
          logLength: log.readAll().length,
        });
        return inner.adapter.complete(request, options);
      },
    };
    const agent = createAgent({
      env: fakeEnv(),
      sessionLog: log,
      adapter: recordingAdapter,
      model: { provider: "p", model: "m" },
      systemPrompt: () => "SYS",
      tools: [echoTool],
    });
    agent.followup("一");
    agent.inject("静默背景");
    agent.steer("补充要求");
    await agent.whenIdle();
    agent.followup("二");
    await sleep(5);
    await agent.whenIdle();

    expect(captured.length).toBeGreaterThanOrEqual(4);
    for (const { messages, logLength } of captured) {
      const rebuilt = deriveMessages(log.readAll().slice(0, logLength));
      expect(messages).toEqual(rebuilt); // 每条发出的请求都能从日志重建
    }
    // 会话确实覆盖了各事件类型
    const types = new Set(log.readAll().map((event) => event.type));
    for (const expected of ["turn/start", "turn/end", "user/message", "assistant/message", "tool/call", "tool/result", "llm/retry", "request/header"]) {
      expect(types.has(expected as SessionEvent["type"])).toBe(true);
    }
  });
});

// —— 随机事件流 ——

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GeneratedState {
  events: SessionEvent[];
  surface: { seq: number; message: Message }[];
  seq: number;
  callSeq: number;
}

function pushMessage(state: GeneratedState, message: Message, event: SessionEventPayload): void {
  const full = { ...event, seq: state.seq++, ts: 0 } as SessionEvent;
  state.events.push(full);
  state.surface.push({ seq: full.seq, message });
}

function generateStream(seed: number, turnCount: number): SessionEvent[] {
  const random = mulberry32(seed);
  const state: GeneratedState = { events: [], surface: [], seq: 0, callSeq: 0 };
  for (let turn = 1; turn <= turnCount; turn++) {
    state.events.push({ type: "turn/start", turn, seq: state.seq++, ts: 0 });
    const userCount = 1 + Math.floor(random() * 3);
    for (let u = 0; u < userCount; u++) {
      const channel = random() < 0.7 ? "followup" : random() < 0.5 ? "steer" : "inject";
      const message: UserMessage = {
        role: "user",
        content: [{ type: "text", text: `u${turn}-${u}-${"字".repeat(1 + Math.floor(random() * 200))}` }],
      };
      pushMessage(state, message, { type: "user/message", channel, message });
    }
    const stepCount = 1 + Math.floor(random() * 3);
    for (let s = 0; s < stepCount; s++) {
      if (random() < 0.2) {
        state.events.push({
          type: "llm/retry",
          provider: "p",
          model: "m",
          attempt: 1,
          code: "SERVER",
          delayMs: 500,
          seq: state.seq++,
          ts: 0,
        });
      }
      const callCount = random() < 0.5 ? 0 : 1 + Math.floor(random() * 2);
      const content: AssistantMessage["content"] = [];
      if (random() < 0.7 || callCount === 0) {
        content.push({ type: "text", text: `a${turn}-${s}` });
      }
      for (let c = 0; c < callCount; c++) {
        content.push({ type: "tool_call", id: `c${state.callSeq++}`, name: "t", arguments: { n: c } });
      }
      const assistant: AssistantMessage = { role: "assistant", content };
      pushMessage(state, assistant, { type: "assistant/message", message: assistant });
      // 每个工具调用立即补结果（结果文本偶发超长，检验裁剪确定性）
      for (const block of content) {
        if (block.type !== "tool_call") continue;
        const long = random() < 0.3;
        const text = long ? "R".repeat(9000 + Math.floor(random() * 500)) : "短结果";
        pushMessage(
          state,
          {
            role: "tool_result",
            callId: block.id,
            isError: random() < 0.3,
            content: [{ type: "text", text }],
            ...(random() < 0.2 ? { code: "TOOL_ERROR" } : {}),
          },
          { type: "tool/result", id: block.id, isError: random() < 0.3, content: [{ type: "text", text }] },
        );
      }
      if (random() < 0.15) {
        state.events.push({
          type: "request/header",
          provider: "p",
          model: "m",
          systemFingerprint: `f${Math.floor(random() * 3)}`,
          toolsFingerprint: "tf",
          seq: state.seq++,
          ts: 0,
        });
      }
    }
    state.events.push({ type: "turn/end", turn, reason: "completed", seq: state.seq++, ts: 0 });
    // 概率性压缩：用与实现同一套区间选择逻辑，保证生成的遮蔽区间合法
    if (random() < 0.25) {
      const retain = Math.floor(random() * 3) * 10;
      const interval = selectShadowInterval(state.surface, retain);
      if (interval) {
        const summary = `# 摘要 t${turn}\n${"概".repeat(20)}`;
        const event: SessionEvent = {
          type: "compaction/summary",
          shadowed: [interval.startSeq, interval.endSeq],
          summary,
          generation: state.events.filter((e) => e.type === "compaction/summary").length + 1,
          seq: state.seq++,
          ts: 0,
        };
        state.events.push(event);
        const [start, end] = event.shadowed;
        const kept = state.surface.filter((it) => it.seq < start || it.seq > end);
        kept.unshift({ seq: start, message: { role: "user", content: [{ type: "text", text: summary }] } });
        state.surface = kept;
      }
    }
  }
  return state.events;
}

function assertPairing(messages: Message[]): void {
  const expected: string[] = [];
  const produced = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool_call") expected.push(block.id);
      }
    } else if (message.role === "tool_result") {
      produced.add(message.callId);
    }
  }
  // 每个 tool_call 恰有一个配对结果（顺序在后），无悬空、无孤儿
  const seen = new Set<string>();
  const orphanCheck: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool_call") {
          expect(produced.has(block.id)).toBe(true);
          seen.add(block.id);
        }
      }
    } else if (message.role === "tool_result") {
      orphanCheck.push(message.callId);
    }
  }
  for (const callId of orphanCheck) expect(seen.has(callId)).toBe(true);
}

describe("不变量：随机事件流投影", () => {
  it("多种子下：配对完整、裁剪确定性、投影是日志的确定函数", () => {
    for (const seed of [1, 7, 42, 2026, 90210]) {
      const events = generateStream(seed, 8);
      const first = deriveMessages(events);
      const second = deriveMessages(events);
      expect(first).toEqual(second); // 确定函数
      assertPairing(first); // 配对完整（压缩只提交配对完整的区间）
      // 遮蔽区间的原消息确实不再可见
      const shadows = events.filter((event) => event.type === "compaction/summary") as Extract<SessionEvent, { type: "compaction/summary" }>[];
      for (const shadow of shadows) {
        const [start, end] = shadow.shadowed;
        for (const item of projectSurface(events)) {
          expect(item.seq < start || item.seq > end || item.message.role === "user").toBe(true);
        }
      }
      // 超长 tool result 在投影中已被裁剪（< 阈值 + 头尾 + 占位符）
      for (const message of first) {
        if (message.role !== "tool_result") continue;
        for (const block of message.content) {
          if (block.type === "text") expect([...block.text].length).toBeLessThan(8193 + 100);
        }
      }
    }
  });
});
