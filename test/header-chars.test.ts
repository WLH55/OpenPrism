// request/header 尺寸度量（SDD 2026-11-13_09-54）：systemChars / toolsChars 随版本序列落档——
// 指纹不变不重复落档（同指纹必同长度），指纹变更新 header 携带新尺寸；旧日志事件无此字段，读取端可选处理。

import { describe, expect, it } from "vitest";
import { createAgent } from "../src/harness/core/agent";
import { createMockLlmAdapter } from "../src/harness/llm/mock";
import { InMemorySessionLog } from "../src/harness/session/log";
import type { SessionEvent } from "../src/harness/session/events";
import { echoTool, fakeEnv } from "./helpers";

function makeAgent(systemPrompt: () => string, turns: number) {
  const mock = createMockLlmAdapter(Array.from({ length: turns }, () => ({ kind: "text" as const, text: "好" })));
  const log = new InMemorySessionLog(() => 0);
  const agent = createAgent({
    env: fakeEnv(),
    sessionLog: log,
    adapter: mock.adapter,
    model: { provider: "p", model: "m" },
    systemPrompt,
    tools: [echoTool],
  });
  return { agent, log };
}

const headersOf = (log: InMemorySessionLog) =>
  log.readAll().filter((event): event is Extract<SessionEvent, { type: "request/header" }> => event.type === "request/header");

const expectedToolsChars = JSON.stringify([
  { name: echoTool.name, description: echoTool.description, parameters: echoTool.parameters },
]).length;

describe("request/header 尺寸度量", () => {
  it("落档 systemChars = system 字符数、toolsChars = 工具面 JSON 字符数", async () => {
    const { agent, log } = makeAgent(() => "SYS-尺寸", 1);
    agent.followup("问题");
    await agent.whenIdle();
    const headers = headersOf(log);
    expect(headers).toHaveLength(1);
    expect(headers[0]!.systemChars).toBe("SYS-尺寸".length);
    expect(headers[0]!.toolsChars).toBe(expectedToolsChars);
  });

  it("system 不变的第二回合不重复落档（尺寸随指纹生命期）", async () => {
    const { agent, log } = makeAgent(() => "STABLE", 2);
    agent.followup("第一问");
    await agent.whenIdle();
    agent.followup("第二问");
    await agent.whenIdle();
    const headers = headersOf(log);
    expect(headers).toHaveLength(1);
    expect(headers[0]!.systemChars).toBe("STABLE".length);
  });

  it("system 变更后新 header 落档且尺寸更新", async () => {
    let system = "SHORT";
    const { agent, log } = makeAgent(() => system, 2);
    agent.followup("第一问");
    await agent.whenIdle();
    system = "LONGER-SYSTEM";
    agent.followup("第二问");
    await agent.whenIdle();
    const headers = headersOf(log);
    expect(headers).toHaveLength(2);
    expect(headers[0]!.systemChars).toBe("SHORT".length);
    expect(headers[1]!.systemChars).toBe("LONGER-SYSTEM".length);
  });

  it("旧日志事件（无尺寸字段）读取不炸", async () => {
    const { agent, log } = makeAgent(() => "S", 1);
    agent.followup("问题");
    await agent.whenIdle();
    // 手动追加一条无尺寸字段的旧格式 header（TS 可选字段允许），读取端按 undefined 处理
    await log.append({
      type: "request/header",
      provider: "p",
      model: "m",
      systemFingerprint: "legacy",
      toolsFingerprint: "legacy",
    });
    const headers = headersOf(log);
    expect(headers.at(-1)!.systemChars).toBeUndefined();
    expect(headers.at(-1)!.toolsChars).toBeUndefined();
  });
});
