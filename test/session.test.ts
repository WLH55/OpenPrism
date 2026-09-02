// H1·session 层：九事件词表 / 内存与 JSONL 载体 / 投影（遮蔽、裁剪）/ 日志查询。

import { describe, expect, it } from "vitest";
import type { FileIO } from "../src/harness/env";
import type { SessionEvent } from "../src/harness/session/events";
import { InMemorySessionLog, JsonlSessionLog } from "../src/harness/session/log";
import {
  DEFAULT_PRUNE,
  PRUNE_PLACEHOLDER,
  deriveMessages,
  projectSurface,
} from "../src/harness/session/project";
import { countTurns, currentGeneration, retryBudgetUsed } from "../src/harness/session/queries";
import type { AssistantMessage, UserMessage } from "../src/harness/types";

const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }] });

describe("InMemorySessionLog", () => {
  it("append 分配单调 seq、带 ts 并广播订阅者", async () => {
    const log = new InMemorySessionLog(() => 7);
    const seen: number[] = [];
    const unsubscribe = log.subscribe((event) => seen.push(event.seq));
    const first = await log.append({ type: "turn/start", turn: 1 });
    const second = await log.append({ type: "turn/end", turn: 1, reason: "completed" });
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(first.ts).toBe(7);
    expect(seen).toEqual([0, 1]);
    expect(log.readAll().map((event) => event.type)).toEqual(["turn/start", "turn/end"]);
    unsubscribe();
    await log.append({ type: "turn/start", turn: 2 });
    expect(seen).toEqual([0, 1]);
  });
});

describe("JsonlSessionLog", () => {
  it("写穿注入的文件 IO；重开后从磁盘恢复并续排 seq", async () => {
    const files = new Map<string, string[]>();
    const fileIO: FileIO = {
      appendLine: async (path, line) => {
        const lines = files.get(path) ?? [];
        lines.push(line);
        files.set(path, lines);
      },
      readAll: async (path) => [...(files.get(path) ?? [])],
    };
    const first = await JsonlSessionLog.open(fileIO, "session.jsonl", () => 1);
    await first.append({ type: "turn/start", turn: 1 });
    await first.append({ type: "user/message", channel: "followup", message: user("你好") });

    const reopened = await JsonlSessionLog.open(fileIO, "session.jsonl", () => 2);
    expect(reopened.readAll()).toHaveLength(2);
    expect(countTurns(reopened.readAll())).toBe(1);
    const third = await reopened.append({ type: "turn/start", turn: 2 });
    expect(third.seq).toBe(2); // 崩溃重启 seq 不回退
    // 持久化的是完整 JSON 行
    const lines = files.get("session.jsonl")!;
    expect(JSON.parse(lines[0]!).type).toBe("turn/start");
  });
});

describe("deriveMessages 投影", () => {
  it("只有消息事件进入模型可见历史；retry/header/turn 边界被跳过", async () => {
    const log = new InMemorySessionLog(() => 0);
    await log.append({ type: "turn/start", turn: 1 });
    await log.append({ type: "user/message", channel: "followup", message: user("问题") });
    await log.append({ type: "request/header", provider: "p", model: "m", systemFingerprint: "a", toolsFingerprint: "b" });
    await log.append({ type: "llm/retry", provider: "p", model: "m", attempt: 1, code: "SERVER", delayMs: 500 });
    await log.append({ type: "assistant/message", message: assistant("回答") });
    await log.append({ type: "turn/end", turn: 1, reason: "completed" });
    const messages = deriveMessages(log.readAll());
    expect(messages).toEqual([user("问题"), assistant("回答")]);
  });

  it("遮蔽区间被 compaction/summary 整体替换为 checkpoint 消息", async () => {
    const log = new InMemorySessionLog(() => 0);
    await log.append({ type: "user/message", channel: "followup", message: user("旧问题") }); // seq 0
    await log.append({ type: "assistant/message", message: assistant("旧回答") }); // seq 1
    await log.append({ type: "user/message", channel: "followup", message: user("新问题") }); // seq 2
    await log.append({
      type: "compaction/summary",
      shadowed: [0, 1],
      summary: "# 摘要\n旧对话讲过 X",
      generation: 1,
    });
    const messages = deriveMessages(log.readAll());
    expect(messages).toEqual([user("# 摘要\n旧对话讲过 X"), user("新问题")]);
    expect(currentGeneration(log.readAll())).toBe(1);
  });

  it("interrupted assistant 照常进入投影", async () => {
    const log = new InMemorySessionLog(() => 0);
    const partial: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "半截" }], interrupted: true };
    await log.append({ type: "assistant/message", message: partial });
    expect(deriveMessages(log.readAll())).toEqual([partial]);
  });

  it("裁剪规则：tool/result 文本 > 8192 code points 时留头 4096 + 占位符 + 尾 1024", async () => {
    const log = new InMemorySessionLog(() => 0);
    const big = "x".repeat(100) + "A".repeat(8192) + "y".repeat(100);
    await log.append({
      type: "tool/result",
      id: "c1",
      isError: false,
      content: [{ type: "text", text: big }],
    });
    const message = deriveMessages(log.readAll())[0]!;
    const text = (message.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(PRUNE_PLACEHOLDER);
    expect([...text].length).toBe(DEFAULT_PRUNE.headChars + DEFAULT_PRUNE.tailChars + PRUNE_PLACEHOLDER.length + 2);
    expect(text.startsWith("x".repeat(100) + "A".repeat(3996))).toBe(true);
    expect(text.endsWith("A".repeat(924) + "y".repeat(100))).toBe(true);
  });

  it("裁剪阈值按 code point 计量：8192 个代理对字符（UTF-16 长 16384）不裁剪", async () => {
    const log = new InMemorySessionLog(() => 0);
    const surrogatePairs = "𝐀".repeat(8192); // 每字符 2 个 UTF-16 码元，1 个 code point
    await log.append({
      type: "tool/result",
      id: "c1",
      isError: false,
      content: [{ type: "text", text: surrogatePairs }],
    });
    const message = deriveMessages(log.readAll())[0]!;
    expect((message.content[0] as { type: "text"; text: string }).text).toBe(surrogatePairs);
  });
});

describe("日志查询", () => {
  it("retryBudgetUsed：末次 assistant/message 之后连续计数；成功即清零；按 provider+model 区分", async () => {
    const log = new InMemorySessionLog(() => 0);
    await log.append({ type: "llm/retry", provider: "p", model: "m1", attempt: 1, code: "SERVER", delayMs: 1 });
    await log.append({ type: "llm/retry", provider: "p", model: "m1", attempt: 2, code: "SERVER", delayMs: 2 });
    await log.append({ type: "llm/retry", provider: "p", model: "m2", attempt: 1, code: "SERVER", delayMs: 3 });
    expect(retryBudgetUsed(log.readAll(), "p", "m1")).toBe(2);
    expect(retryBudgetUsed(log.readAll(), "p", "m2")).toBe(1);
    await log.append({ type: "assistant/message", message: assistant("成功") });
    expect(retryBudgetUsed(log.readAll(), "p", "m1")).toBe(0); // 成功清零
    await log.append({ type: "llm/retry", provider: "p", model: "m1", attempt: 1, code: "SERVER", delayMs: 1 });
    expect(retryBudgetUsed(log.readAll(), "p", "m1")).toBe(1);
  });

  it("projectSurface 保留 seq 供压缩区间选择", async () => {
    const log = new InMemorySessionLog(() => 0);
    await log.append({ type: "user/message", channel: "followup", message: user("a") });
    await log.append({ type: "assistant/message", message: assistant("b") });
    const surface = projectSurface(log.readAll());
    expect(surface.map((item) => item.seq)).toEqual([0, 1]);
  });
});
