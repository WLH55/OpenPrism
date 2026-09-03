// 批次1·conversations：会话池装配——mock adapter 驱动完整 Turn，
// 验证"模型只能经工具写账本"与"模型可见即日志可重建"两条铁律在 app 层成立。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths } from "../src/app/store";
import { Ledger, type FlowRecord } from "../src/app/ledger";
import { ConversationStore, ModelNotConfiguredError } from "../src/app/conversations";
import { createMockLlmAdapter, type LlmAdapter } from "../src/harness/index";
import type { ModelConfig } from "../src/app/secretbox";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-conv-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const UID = "u-1";
const MODEL: ModelConfig = { baseURL: "https://api.mock.local", model: "mock-1" };

describe("ConversationStore", () => {
  it("create/list 往返；send 驱动完整 Turn：工具落账（source=agent、带会话归属）+ 日志可重建", async () => {
    const script = [
      {
        kind: "tool-calls" as const,
        calls: [{ name: "record_flow", arguments: { category: "餐饮", value: 28, unit: "¥", note: "午餐" } }],
      },
      { kind: "text" as const, text: "记好了，午餐 28。" },
    ];
    const holder: { ledger?: Ledger } = {};
    const paths = appPaths(join(root, "d-a"));
    const ledger = await Ledger.open(nodeFileIO, paths.lifeFile(UID));
    holder.ledger = ledger;
    const { adapter } = createMockLlmAdapter(script);
    const store = new ConversationStore({
      env: nodeEnv,
      fileIO: nodeFileIO,
      paths,
      ledgerFor: async () => ledger,
      modelConfigFor: async () => MODEL,
      adapterFactory: () => adapter as LlmAdapter,
      now: () => Date.UTC(2026, 8, 3, 12, 0, 0),
    });

    const entry = await store.create(UID, "记账测试");
    expect(entry.title).toBe("记账测试");
    expect((await store.list(UID)).map((e) => e.id)).toContain(entry.id);

    await store.send(UID, entry.id, "中午吃面花了 28");
    const agent = await store.agent(UID, entry.id);
    await agent.whenIdle();

    // 铁律一：写入只经工具 → 账本出现 agent 来源流水，actor 带会话归属
    const flow = ledger.activeRecords().find((r) => r.kind === "event") as FlowRecord;
    expect(flow.category).toBe("餐饮");
    expect(flow.value).toBe(28);
    expect(flow.source).toBe("agent");
    expect(flow.actor?.conversationId).toBe(entry.id);

    // 铁律二：会话日志可重建整个回合（九事件词表）
    const events = agent.sessionLog.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain("turn/start");
    expect(types).toContain("user/message");
    expect(types).toContain("assistant/message");
    expect(types).toContain("tool/call");
    expect(types).toContain("tool/result");
    expect(events.filter((e) => e.type === "turn/end")[0]).toMatchObject({ reason: "completed" });

    // 池化：同 cid 两次 agent() 同一实例
    expect(await store.agent(UID, entry.id)).toBe(agent);
  });

  it("未配置模型 → agent()/send() 抛 ModelNotConfiguredError（服务器映射 409）", async () => {
    const paths = appPaths(join(root, "d-b"));
    const ledger = await Ledger.open(nodeFileIO, paths.lifeFile(UID));
    const store = new ConversationStore({
      env: nodeEnv,
      fileIO: nodeFileIO,
      paths,
      ledgerFor: async () => ledger,
      modelConfigFor: async () => null,
      adapterFactory: () => {
        throw new Error("should not be called");
      },
      now: () => 0,
    });
    const entry = await store.create(UID);
    await expect(store.agent(UID, entry.id)).rejects.toBeInstanceOf(ModelNotConfiguredError);
    await expect(store.send(UID, entry.id, "hi")).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });
});
