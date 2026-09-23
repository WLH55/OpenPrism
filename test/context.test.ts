// H5·context 层：启发式计量、压缩区间选择（配对边界回退）、两阶段压缩事务、
// shrink 校验、稳定性检查、压力触发（含失败仅告警）、溢出路由与替换代数闸门。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION,
  compactConversation,
  selectShadowInterval,
  type CompactDeps,
} from "../src/harness/context/compact";
import {
  IMAGE_HEURISTIC_TOKENS,
  heuristicMessageTokens,
  heuristicRequestTokens,
  heuristicTextTokens,
} from "../src/harness/context/meter";
import { createAgent } from "../src/harness/core/agent";
import { llmFailure } from "../src/harness/llm/errors";
import { createMockLlmAdapter, type MockScriptStep } from "../src/harness/llm/mock";
import { InMemorySessionLog } from "../src/harness/session/log";
import { projectSurface, type SurfaceItem } from "../src/harness/session/project";
import { currentGeneration } from "../src/harness/session/queries";
import type { AssistantMessage, Message, UserMessage } from "../src/harness/types";
import { echoTool, fakeEnv } from "./helpers";

const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistantWithCall = (id: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name: "t", arguments: {} }],
});
const toolResult = (id: string): Message => ({
  role: "tool_result",
  callId: id,
  isError: false,
  content: [{ type: "text", text: "r" }],
});

function depsOf(log: InMemorySessionLog, script: MockScriptStep[], contextWindow = 1000): CompactDeps {
  const mock = createMockLlmAdapter(script);
  return {
    sessionLog: log,
    adapter: mock.adapter,
    model: { provider: "p", model: "m" },
    system: "S",
    tools: [],
    config: { ...DEFAULT_COMPACTION, contextWindow },
  };
}

async function seedConversation(log: InMemorySessionLog): Promise<void> {
  await log.append({ type: "user/message", channel: "followup", message: user("第一个问题") });
  await log.append({ type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "第一个回答" }] } });
  await log.append({ type: "user/message", channel: "followup", message: user("第二个问题") });
}

describe("启发式计量", () => {
  it("chars/4 + 每内容块 4 + 每消息 role 4；请求级含 system 与工具表", () => {
    expect(heuristicTextTokens("abcd")).toBe(1);
    expect(heuristicTextTokens("abc")).toBe(1);
    expect(heuristicTextTokens("abcde")).toBe(2);
    expect(heuristicMessageTokens(user("abcd"))).toBe(4 + 4 + 1);
    expect(heuristicRequestTokens("abcd", [], [user("abcd")])).toBe(1 + 9);
    const tools = [{ name: "t", description: "d", parameters: { type: "object" } }];
    expect(heuristicRequestTokens("", tools, [])).toBe(heuristicTextTokens(JSON.stringify(tools)));
  });

  it("图片按单图固定视觉开销计（与 base64 长度无关）；文本附件按正文长度计", () => {
    const image: UserMessage = { role: "user", content: [{ type: "image", mediaType: "image/webp", data: "A".repeat(400_000) }] };
    expect(heuristicMessageTokens(image)).toBe(4 + 4 + IMAGE_HEURISTIC_TOKENS);
    const file: UserMessage = { role: "user", content: [{ type: "file", name: "a.txt", mediaType: "text/plain", text: "abcd" }] };
    expect(heuristicMessageTokens(file)).toBe(4 + 4 + 1);
  });
});

describe("selectShadowInterval", () => {
  it("从头部选区间，遮蔽后尾部至少保留 retainTokens", () => {
    const surface: SurfaceItem[] = [
      { seq: 0, message: user("a") },
      { seq: 1, message: user("b") },
      { seq: 2, message: user("c") },
    ];
    const interval = selectShadowInterval(surface, heuristicMessageTokens(user("c")))!;
    expect(interval.endSeq).toBe(1); // 尾部保留 c
    expect(interval.items).toHaveLength(2);
  });

  it("边界回退：不切开 tool-call/result 配对", () => {
    const surface: SurfaceItem[] = [
      { seq: 0, message: user("u1") },
      { seq: 1, message: assistantWithCall("c1") },
      { seq: 2, message: toolResult("c1") },
      { seq: 3, message: user("u2") },
    ];
    // retain 恰为 h(r1)+h(u2)：切点将落在 a1（切开配对）→ 回退到 u1
    const retain = heuristicMessageTokens(toolResult("c1")) + heuristicMessageTokens(user("u2"));
    const interval = selectShadowInterval(surface, retain)!;
    expect(interval.endSeq).toBe(0);
    // retain 只留 u2：切点落在 r1 之后，a1/r1 整对入区间，无需回退
    const interval2 = selectShadowInterval(surface, heuristicMessageTokens(user("u2")))!;
    expect(interval2.endSeq).toBe(2);
  });

  it("retain=0（溢出路径）也至少保留 1 条", () => {
    const surface: SurfaceItem[] = [
      { seq: 0, message: user("a") },
      { seq: 1, message: user("b") },
    ];
    const interval = selectShadowInterval(surface, 0)!;
    expect(interval.endSeq).toBe(0);
    expect(selectShadowInterval([surface[0]!], 0)).toBeNull(); // 单条不可压
  });
});

describe("compactConversation", () => {
  it("未过阈且未 force → changed false，不消耗摘要请求", async () => {
    const log = new InMemorySessionLog(() => 0);
    await seedConversation(log);
    const deps = depsOf(log, [{ kind: "text", text: "不该被调用" }], 100_000);
    const result = await compactConversation(deps, {});
    expect(result.changed).toBe(false);
    expect(result.generation).toBe(0);
    expect((deps.adapter as { name: string }).name).toBe("mock");
  });

  it("force 压缩：摘要提交、遮蔽生效、代数 +1", async () => {
    const log = new InMemorySessionLog(() => 0);
    await seedConversation(log);
    const deps = depsOf(log, [{ kind: "text", text: "# 摘要\n聊了两个问题" }]);
    const result = await compactConversation(deps, { force: true, retainTokens: heuristicMessageTokens(user("第二个问题")) });
    expect(result.changed).toBe(true);
    expect(result.generation).toBe(1);
    const summaryEvent = log.readAll().find((event) => event.type === "compaction/summary");
    expect(summaryEvent).toBeDefined();
    expect(currentGeneration(log.readAll())).toBe(1);
    // 投影：遮蔽区间被 checkpoint 替换
    const surface = projectSurface(log.readAll());
    expect((surface[0]!.message.content[0] as { text: string }).text).toBe("# 摘要\n聊了两个问题");
    expect(surface[surface.length - 1]!.message).toEqual(user("第二个问题"));
  });

  it("shrink 校验：摘要比被遮蔽区间还大 → 抛错、不提交", async () => {
    const log = new InMemorySessionLog(() => 0);
    await seedConversation(log);
    const huge = "概".repeat(500);
    const deps = depsOf(log, [{ kind: "text", text: huge }]);
    await expect(compactConversation(deps, { force: true, retainTokens: 0 })).rejects.toThrow(/shrink/);
    expect(log.readAll().some((event) => event.type === "compaction/summary")).toBe(false);
  });

  it("稳定性检查：摘要期间 Surface 变更 → 放弃提交", async () => {
    const log = new InMemorySessionLog(() => 0);
    await seedConversation(log);
    const deps = depsOf(log, [
      {
        kind: "fn",
        fn: async () => {
          // 摘要请求进行中，一条新消息到达（inject 通道）
          await log.append({ type: "user/message", channel: "inject", message: user("新消息") });
          return { message: { role: "assistant", content: [{ type: "text", text: "# 摘要" }] } };
        },
      },
    ]);
    const result = await compactConversation(deps, { force: true, retainTokens: 0 });
    expect(result.changed).toBe(false);
    expect(log.readAll().some((event) => event.type === "compaction/summary")).toBe(false);
  });
});

describe("agent 集成：压力与溢出", () => {
  it("压力过阈触发压缩；区间不足时失败仅告警不阻塞 Turn", async () => {
    const log = new InMemorySessionLog(() => 0);
    const mock = createMockLlmAdapter([
      { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "hi" } }] }, // step1（带工具，Turn 继续）
      { kind: "text", text: "# 摘要" }, // 压缩摘要请求
      { kind: "text", text: "done" }, // step2
    ]);
    const agent = createAgent({
      env: fakeEnv(),
      sessionLog: log,
      adapter: mock.adapter,
      model: { provider: "p", model: "m", contextWindow: 64 },
      systemPrompt: () => "S",
      tools: [echoTool],
    });
    agent.followup("x".repeat(200)); // 启发式 ≈58 tokens ≥ 0.8×64
    await agent.whenIdle();

    // 第一步前：单条历史无法压缩 → 告警但不阻塞
    // 第二步前：历史足够 → 压缩成功，重建请求
    const summaryEvent = log.readAll().find((event) => event.type === "compaction/summary");
    expect(summaryEvent).toBeDefined();
    expect(mock.requests).toHaveLength(3);
    const secondRequest = mock.requests[2]!.messages;
    expect((secondRequest[0]!.content[0] as { text: string }).text).toBe("# 摘要");
    const reasons = log.readAll().filter((event) => event.type === "turn/end");
    expect(reasons.every((event) => (event as { reason: string }).reason === "completed")).toBe(true);
  });

  it("溢出路由：CONTEXT_WINDOW_EXCEEDED → 强制压缩（retain=0）→ 代数前进 → 重试一次成功", async () => {
    const log = new InMemorySessionLog(() => 0);
    const mock = createMockLlmAdapter([
      { kind: "text", text: "一" }, // turn1 正常
      { kind: "failure", failure: llmFailure("CONTEXT_WINDOW_EXCEEDED", "maximum context length exceeded", { status: 400 }) },
      { kind: "text", text: "概要" }, // 压缩摘要请求
      { kind: "text", text: "好了" }, // 溢出重试
    ]);
    const agent = createAgent({
      env: fakeEnv(),
      sessionLog: log,
      adapter: mock.adapter,
      model: { provider: "p", model: "m" },
      systemPrompt: () => "S",
    });
    agent.followup("一");
    await agent.whenIdle();
    agent.followup("二");
    await agent.whenIdle();

    const reasons = log
      .readAll()
      .filter((event) => event.type === "turn/end")
      .map((event) => (event as { reason: string }).reason);
    expect(reasons).toEqual(["completed", "completed"]);
    expect(currentGeneration(log.readAll())).toBe(1);
    expect(mock.requests).toHaveLength(4);
    // 重试请求以 checkpoint 开头
    const retryRequest = mock.requests[3]!.messages;
    expect((retryRequest[0]!.content[0] as { text: string }).text).toBe("概要");
    // 摘要请求复用会话前缀（同 system + 被压区间消息）
    expect(mock.requests[2]!.system).toBe("S");
  });

  it("代数闸门：压缩失败（摘要请求失败）→ 放行原始错误，Turn 以 error 收尾", async () => {
    const log = new InMemorySessionLog(() => 0);
    const mock = createMockLlmAdapter([
      { kind: "text", text: "一" },
      { kind: "failure", failure: llmFailure("CONTEXT_WINDOW_EXCEEDED", "context window exceeded", { status: 400 }) },
      { kind: "failure", failure: llmFailure("SERVER", "down") }, // 摘要也失败
    ]);
    const agent = createAgent({
      env: fakeEnv(),
      sessionLog: log,
      adapter: mock.adapter,
      model: { provider: "p", model: "m" },
      systemPrompt: () => "S",
    });
    agent.followup("一");
    await agent.whenIdle();
    agent.followup("二");
    await agent.whenIdle();
    const reasons = log
      .readAll()
      .filter((event) => event.type === "turn/end")
      .map((event) => (event as { reason: string }).reason);
    expect(reasons).toEqual(["completed", "error"]);
    expect(currentGeneration(log.readAll())).toBe(0);
  });

  it("手动 compact 要求 idle", async () => {
    const log = new InMemorySessionLog(() => 0);
    const mock = createMockLlmAdapter([{ kind: "text", text: "一" }, { kind: "text", text: "# 摘要" }]);
    const agent = createAgent({
      env: fakeEnv(),
      sessionLog: log,
      adapter: mock.adapter,
      model: { provider: "p", model: "m" },
      systemPrompt: () => "S",
      compaction: { contextWindow: 64 },
    });
    agent.followup("一");
    // 尚未 idle（driver 在跑）——立即 compact 应拒绝
    await expect(agent.compact()).rejects.toThrow(/idle/);
    await agent.whenIdle();
    await seedConversation(log);
    await agent.compact();
    expect(currentGeneration(log.readAll())).toBe(1);
  });
});
