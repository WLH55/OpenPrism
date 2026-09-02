// H1·core 循环层：turn/step 状态机、三通道、abort 部分保留、Turn Budget、max-tokens 粘性、
// 错误恢复、onTurnStopping、request/header 变更、工具往返。

import { describe, expect, it } from "vitest";
import { createAgent, type AgentConfig } from "../src/harness/core/agent";
import type { AgentLiveEvent } from "../src/harness/core/events";
import { llmFailure } from "../src/harness/llm/errors";
import type { LlmCallOptions, LlmResponse } from "../src/harness/llm/adapter";
import { createMockLlmAdapter, type MockScriptStep } from "../src/harness/llm/mock";
import type { SessionEvent } from "../src/harness/session/events";
import { InMemorySessionLog } from "../src/harness/session/log";
import { deriveMessages } from "../src/harness/session/project";
import { fnv1a } from "../src/harness/util";
import { deferred, echoTool, fakeEnv, sleep } from "./helpers";

function makeAgent(script: MockScriptStep[], options?: Partial<AgentConfig>) {
  const mock = createMockLlmAdapter(script);
  const log = new InMemorySessionLog(() => 0);
  const agent = createAgent({
    env: fakeEnv(),
    sessionLog: log,
    adapter: mock.adapter,
    model: { provider: "p", model: "m" },
    systemPrompt: () => "S",
    tools: [echoTool],
    ...options,
  });
  return { agent, mock, log };
}

const eventsOf = (log: InMemorySessionLog) => log.readAll();
const reasons = (log: InMemorySessionLog) =>
  eventsOf(log)
    .filter((event): event is Extract<SessionEvent, { type: "turn/end" }> => event.type === "turn/end")
    .map((event) => event.reason);

describe("循环层：基础回合", () => {
  it("followup → 文本回答 → completed；日志按词表顺序", async () => {
    const { agent, mock, log } = makeAgent([{ kind: "text", text: "你好" }]);
    agent.followup("问题");
    await agent.whenIdle();
    expect(agent.status).toBe("idle");
    expect(reasons(log)).toEqual(["completed"]);
    expect(eventsOf(log).map((event) => event.type)).toEqual([
      "turn/start",
      "user/message",
      "request/header",
      "assistant/message",
      "turn/end",
    ]);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.system).toBe("S");
  });

  it("工具往返：tool/call 先落日志、结果冻结落日志、下一步带上 tool_result", async () => {
    const { agent, mock, log } = makeAgent([
      { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "嗨" } }] },
      { kind: "text", text: "完成" },
    ]);
    agent.followup("用工具");
    await agent.whenIdle();

    const types = eventsOf(log).map((event) => event.type);
    expect(types).toContain("tool/call");
    expect(types).toContain("tool/result");
    const call = eventsOf(log).find((event) => event.type === "tool/call") as Extract<SessionEvent, { type: "tool/call" }>;
    expect(call.name).toBe("echo");
    expect(call.args).toEqual({ text: "嗨" });
    const result = eventsOf(log).find((event) => event.type === "tool/result") as Extract<SessionEvent, { type: "tool/result" }>;
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "嗨" }]);

    expect(mock.requests).toHaveLength(2);
    const second = mock.requests[1]!.messages;
    expect(second[2]).toEqual({
      role: "tool_result",
      callId: call.id,
      isError: false,
      content: [{ type: "text", text: "嗨" }],
    });
    expect(reasons(log)).toEqual(["completed"]);
  });
});

describe("循环层：Inbox 三通道", () => {
  it("steer 插入当前 Turn 下一步之前（跟随在开场输入后）", async () => {
    const { agent, mock, log } = makeAgent([{ kind: "text", text: "好" }]);
    agent.followup("开场");
    agent.steer("改个方向");
    await agent.whenIdle();
    expect(mock.requests[0]!.messages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "开场",
      "改个方向",
    ]);
    const userEvents = eventsOf(log).filter((event) => event.type === "user/message");
    expect(userEvents.map((event) => (event as { channel: string }).channel)).toEqual(["followup", "steer"]);
  });

  it("inject 不唤醒；等下次请求捎带", async () => {
    const { agent, mock } = makeAgent([{ kind: "text", text: "好" }]);
    agent.inject("静默上下文");
    await sleep(15);
    expect(agent.status).toBe("idle"); // 没被唤醒
    agent.followup("开始");
    await agent.whenIdle();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.messages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "开始",
      "静默上下文",
    ]);
  });

  it("空闲时 steer 作为下一 Turn 开场输入（唤醒）", async () => {
    const { agent, mock, log } = makeAgent([{ kind: "text", text: "好" }]);
    agent.steer("直接开始");
    await agent.whenIdle();
    expect(mock.requests).toHaveLength(1);
    const opener = eventsOf(log).find((event) => event.type === "user/message") as Extract<SessionEvent, { type: "user/message" }>;
    expect(opener.channel).toBe("steer");
  });
});

describe("循环层：cancel", () => {
  function hangStep(started: ReturnType<typeof deferred<void>>) {
    return {
      kind: "fn" as const,
      fn: (_request: unknown, options?: LlmCallOptions): Promise<LlmResponse> =>
        new Promise((_resolve, reject) => {
          started.resolve();
          options?.onTextDelta?.("部分回答");
          options?.signal?.addEventListener("abort", () => {
            reject(llmFailure("ABORTED", "aborted"));
          });
        }),
    };
  }

  it("中止保留部分输出：interrupted assistant 落日志，Turn 以 aborted 收尾", async () => {
    const started = deferred<void>();
    const { agent, log } = makeAgent([hangStep(started)]);
    agent.followup("长问题");
    await started.promise;
    agent.cancel();
    await agent.whenIdle();

    const partial = eventsOf(log).find(
      (event) => event.type === "assistant/message",
    ) as Extract<SessionEvent, { type: "assistant/message" }>;
    expect(partial.message.interrupted).toBe(true);
    expect(partial.message.content).toEqual([{ type: "text", text: "部分回答" }]);
    expect(reasons(log)).toEqual(["aborted"]);
    expect(agent.status).toBe("idle");
  });

  it("默认清 Inbox：取消后排队输入不再执行", async () => {
    const started = deferred<void>();
    const { agent, mock, log } = makeAgent([hangStep(started), { kind: "text", text: "三" }]);
    agent.followup("一");
    agent.followup("二");
    await started.promise;
    agent.cancel();
    await agent.whenIdle();
    expect(reasons(log)).toEqual(["aborted"]);
    agent.followup("三");
    await agent.whenIdle();
    expect(mock.requests).toHaveLength(2);
    expect(reasons(log)).toEqual(["aborted", "completed"]);
  });

  it("clearInbox=false：滞留 steer 归入 next-turn（重分类为 followup）", async () => {
    const started = deferred<void>();
    const { agent, log } = makeAgent([hangStep(started), { kind: "text", text: "二" }]);
    agent.followup("一");
    await started.promise; // 请求已在飞行中
    agent.steer("转向"); // 中途到达：不加入已进行的活动，滞留 Inbox
    agent.cancel({ clearInbox: false });
    await agent.whenIdle();
    expect(reasons(log)).toEqual(["aborted", "completed"]); // 转向开启了下一 Turn
    const channels = eventsOf(log)
      .filter((event) => event.type === "user/message")
      .map((event) => (event as { channel: string }).channel);
    expect(channels).toEqual(["followup", "followup"]); // 归入 next-turn，不加入已中止的活动
  });
});

describe("循环层：Turn Budget 与 max-tokens 粘性", () => {
  it("预算用尽：未回话的工具调用补合成 isError（TURN_BUDGET），历史协议合法", async () => {
    const live: AgentLiveEvent[] = [];
    const { agent, mock, log } = makeAgent(
      [
        { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "x" } }] },
        { kind: "text", text: "不会到达" },
      ],
      { maxStepsPerTurn: 1 },
    );
    agent.subscribe((event) => live.push(event));
    agent.followup("跑");
    await agent.whenIdle();

    expect(mock.requests).toHaveLength(1); // 第二步没发
    expect(reasons(log)).toEqual(["budget-exhausted"]);
    const budgetResult = eventsOf(log).find(
      (event) => event.type === "tool/result",
    ) as Extract<SessionEvent, { type: "tool/result" }>;
    expect(budgetResult.isError).toBe(true);
    expect(budgetResult.code).toBe("TURN_BUDGET");
    expect((budgetResult.content[0] as { text: string }).text).toBe("Error: turn budget exhausted");
    expect(live.some((event) => event.type === "budget-exhausted")).toBe(true);

    // 不变量：投影里每个 tool_call 都有配对 tool_result（无悬空）
    const visible = deriveMessages(eventsOf(log));
    const callIds = new Set(
      visible.flatMap((message) =>
        message.role === "assistant" ? message.content.filter((b) => b.type === "tool_call").map((b) => (b as { id: string }).id) : [],
      ),
    );
    const resultIds = visible
      .filter((message) => message.role === "tool_result")
      .map((message) => (message as { callId: string }).callId);
    expect(resultIds).toEqual([...callIds]);
  });

  it("max-tokens 粘性：一步撞顶后，后续正常步骤不得降级 Turn 结论", async () => {
    const { agent, log } = makeAgent([
      { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "a" } }], finishReason: "length" },
      { kind: "text", text: "完成", finishReason: "stop" },
    ]);
    agent.followup("跑");
    await agent.whenIdle();
    expect(reasons(log)).toEqual(["max-tokens"]);
  });

  it("Infinity = dsh 行为：无预算上限", async () => {
    const script: MockScriptStep[] = [
      { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "一" } }] },
      { kind: "tool-calls", calls: [{ name: "echo", arguments: { text: "二" } }] },
      { kind: "text", text: "完成" },
    ];
    const { agent, log } = makeAgent(script, { maxStepsPerTurn: Infinity });
    agent.followup("跑");
    await agent.whenIdle();
    expect(reasons(log)).toEqual(["completed"]);
  });
});

describe("循环层：错误与恢复", () => {
  it("不可重试失败 → Turn 以 error 收尾；Agent 仍可用", async () => {
    const { agent, mock, log } = makeAgent([
      { kind: "failure", failure: llmFailure("AUTH", "bad key") },
      { kind: "text", text: "好了" },
    ]);
    agent.followup("一");
    await agent.whenIdle();
    expect(reasons(log)).toEqual(["error"]);
    expect(eventsOf(log).filter((event) => event.type === "llm/retry")).toHaveLength(0);
    agent.followup("二");
    await agent.whenIdle();
    expect(reasons(log)).toEqual(["error", "completed"]);
    expect(mock.requests).toHaveLength(2);
  });

  it("可重试失败走重试器并落 llm/retry 事件", async () => {
    const { agent, log } = makeAgent([
      { kind: "failure", failure: llmFailure("RATE_LIMIT", "slow down", { retryAfterMs: 1 }) },
      { kind: "text", text: "好了" },
    ]);
    agent.followup("一");
    await agent.whenIdle();
    const retries = eventsOf(log).filter((event) => event.type === "llm/retry");
    expect(retries).toHaveLength(1);
    expect((retries[0] as { attempt: number; code: string }).attempt).toBe(1);
    expect(reasons(log)).toEqual(["completed"]);
  });
});

describe("循环层：turn-stopping 与请求组装", () => {
  it("onTurnStopping 在自然停止前、turn/end 落日志前调用；aborted 不调用", async () => {
    const order: string[] = [];
    const started = deferred<void>();
    const hang = {
      kind: "fn" as const,
      fn: (_request: unknown, options?: LlmCallOptions): Promise<LlmResponse> =>
        new Promise((_resolve, reject) => {
          started.resolve();
          options?.signal?.addEventListener("abort", () => reject(llmFailure("ABORTED", "x")));
        }),
    };
    const { agent, log } = makeAgent([{ kind: "text", text: "一" }, hang], {
      onTurnStopping: async () => {
        order.push("stopping");
      },
    });
    log.subscribe((event) => {
      if (event.type === "turn/end") order.push("turn/end");
    });
    agent.followup("一");
    await agent.whenIdle();
    expect(order).toEqual(["stopping", "turn/end"]);

    agent.followup("二");
    await started.promise;
    agent.cancel();
    await agent.whenIdle();
    expect(order).toEqual(["stopping", "turn/end", "turn/end"]); // aborted 没有再调 stopping
  });

  it("request/header 仅在指纹变更时记；system 变更触发新 header", async () => {
    let system = "S1";
    const mock = createMockLlmAdapter([{ kind: "text", text: "一" }, { kind: "text", text: "二" }]);
    const log = new InMemorySessionLog(() => 0);
    const agent = createAgent({
      env: fakeEnv(),
      sessionLog: log,
      adapter: mock.adapter,
      model: { provider: "p", model: "m" },
      systemPrompt: () => system,
    });
    agent.followup("一");
    await agent.whenIdle();
    system = "S2";
    agent.followup("二");
    await agent.whenIdle();
    const headers = eventsOf(log).filter((event) => event.type === "request/header");
    expect(headers).toHaveLength(2);
    expect((headers[1] as { systemFingerprint: string }).systemFingerprint).toBe(fnv1a("S2"));
  });

  it("onRequest 拦截点可改路由（换模型不动循环）", async () => {
    const { agent, mock, log } = makeAgent([{ kind: "text", text: "一" }], {
      onRequest: (request) => ({ ...request, provider: "cheap", model: "small" }),
    });
    agent.followup("一");
    await agent.whenIdle();
    expect(mock.requests[0]!.model).toBe("small");
    const header = eventsOf(log).find((event) => event.type === "request/header") as Extract<SessionEvent, { type: "request/header" }>;
    expect(header.model).toBe("small"); // header 反映实际请求
  });

  it("活体事件流：text-delta 只走 subscribe、不落日志", async () => {
    const live: AgentLiveEvent[] = [];
    const { agent, log } = makeAgent([{ kind: "text", text: "一二三四" }]);
    agent.subscribe((event) => live.push(event));
    agent.followup("一");
    await agent.whenIdle();
    const deltas = live.filter((event) => event.type === "text-delta");
    expect(deltas.map((event) => (event as { text: string }).text).join("")).toBe("一二三四");
    expect(eventsOf(log).some((event) => (event as { type: string }).type.includes("chunk"))).toBe(false);
  });
});
