// 批次1+2·conversations：会话池装配（批次1：mock adapter 完整 Turn + ModelNotConfigured）
// + 批次2：会话 meta/切换伙伴（systemPrompt 每步重取）、能力绑定过滤、技能目录注入、记忆注入。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths, type AppPaths } from "../src/app/store";
import { Ledger, type FlowRecord } from "../src/app/ledger";
import { ConversationStore, ModelNotConfiguredError } from "../src/app/conversations";
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { TaskStore } from "../src/app/tasks";
import { MemoryStore } from "../src/app/memory";
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

function makeDeps(paths: AppPaths, adapter: LlmAdapter, modelConfig: ModelConfig | null = MODEL) {
  const ledger = new Map<string, Promise<Ledger>>();
  const ledgerFor = (uid: string): Promise<Ledger> => {
    let l = ledger.get(uid);
    if (!l) {
      l = Ledger.open(nodeFileIO, paths.lifeFile(uid));
      ledger.set(uid, l);
    }
    return l;
  };
  return {
    base: {
      env: nodeEnv,
      fileIO: nodeFileIO,
      paths,
      ledgerFor,
      modelConfigFor: async () => modelConfig,
      adapterFactory: () => adapter,
      now: () => Date.UTC(2026, 8, 3, 12, 0, 0),
    },
    agents: new AgentStore({ fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => `aid-${Math.random().toString(36).slice(2, 8)}` }),
    skills: new SkillStore({ fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => `skid-${Math.random().toString(36).slice(2, 8)}` }),
    mcps: new McpRegistry({ env: nodeEnv, fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => "mc-1" }),
    memory: new MemoryStore({ fileIO: nodeFileIO, paths, now: () => 5000 }),
    tasks: new TaskStore({ fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => `tid-${Math.random().toString(36).slice(2, 8)}` }),
  };
}

const textAdapter = () => createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]).adapter as LlmAdapter;

describe("ConversationStore（批次1 回归）", () => {
  it("send 驱动完整 Turn：工具落账（source=agent、带会话归属）+ 日志可重建；池化同实例", async () => {
    const paths = appPaths(join(root, "d-a"));
    const { adapter } = createMockLlmAdapter([
      { kind: "tool-calls", calls: [{ name: "record_flow", arguments: { category: "餐饮", value: 28, unit: "¥" } }] },
      { kind: "text", text: "记好了。" },
    ]);
    const deps = makeDeps(paths, adapter as LlmAdapter);
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const ledger = await deps.base.ledgerFor(UID);

    const entry = await store.create(UID, "记账测试");
    await store.send(UID, entry.id, "中午吃面花了 28");
    const agent = await store.agent(UID, entry.id);
    await agent.whenIdle();

    const flow = ledger.activeRecords().find((r) => r.kind === "event") as FlowRecord;
    expect(flow.category).toBe("餐饮");
    expect(flow.source).toBe("agent");
    expect(flow.actor?.conversationId).toBe(entry.id);
    const types = agent.sessionLog.readAll().map((e) => e.type);
    expect(types).toContain("tool/call");
    expect(types).toContain("turn/end");
    expect(await store.agent(UID, entry.id)).toBe(agent);
  });

  it("未配置模型 → ModelNotConfiguredError", async () => {
    const paths = appPaths(join(root, "d-b"));
    const deps = makeDeps(paths, textAdapter(), null);
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const entry = await store.create(UID);
    await expect(store.agent(UID, entry.id)).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });
});

describe("ConversationStore（批次2：伙伴与装配）", () => {
  it("默认助手：system 含默认身份；无绑定 → 四工具 + save_preference，无 load_skill", async () => {
    const paths = appPaths(join(root, "d-c"));
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(paths, mock.adapter as LlmAdapter);
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.system).toContain("OpenPrism");
    expect(mock.requests[0]!.system).toContain("save_preference");
    expect(mock.requests[0]!.tools?.map((t) => t.name).sort()).toEqual(["checkin_plan", "create_plan", "create_task", "query_ledger", "record_flow", "save_preference"]);
  });

  it("切换伙伴：systemPrompt 换人设下一步生效；切换历史落 meta；账本 actor 随当前伙伴", async () => {
    const paths = appPaths(join(root, "d-d"));
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(paths, mock.adapter as LlmAdapter);
    const coach = await deps.agents.create(UID, { persona: "# 教练\n盯训练，语气硬朗。" });
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "第一句（默认助手）");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.system).toContain("OpenPrism");

    await store.switchAgent(UID, entry.id, coach.id);
    const meta = await store.metaFor(UID, entry.id);
    expect(meta.agentId).toBe(coach.id);
    expect(meta.switches).toHaveLength(1);

    await store.send(UID, entry.id, "第二句（教练）");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[1]!.system).toContain("盯训练");
    expect(mock.requests[1]!.system).not.toContain("你是 OpenPrism 的生活记录助理");

    // 人设热改：updatePersona 后下一请求即新文案（systemPrompt 每步重取）
    await deps.agents.updatePersona(UID, coach.id, "# 教练\n新文案：温柔版。");
    await store.send(UID, entry.id, "第三句");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[2]!.system).toContain("温柔版");
  });

  it("能力绑定：tools 开关过滤内置工具；绑技能 → 目录进 system + load_skill 可用", async () => {
    const paths = appPaths(join(root, "d-e"));
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(paths, mock.adapter as LlmAdapter);
    const skill = await deps.skills.create(
      UID,
      "---\nname: 健身复盘\ndescription: 健身话题追问组数重量\nwhen_to_use: 健身话题\n---\n\n# 框架\n问组数。",
    );
    const analyst = await deps.agents.create(UID, {
      persona: "# 分析师\n只查不写。",
      binding: { tools: ["query_ledger"], skills: [skill.id], mcps: [] },
    });
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const entry = await store.create(UID);
    await store.switchAgent(UID, entry.id, analyst.id);
    await store.send(UID, entry.id, "帮我看看");
    await (await store.agent(UID, entry.id)).whenIdle();
    const names = mock.requests[0]!.tools!.map((t) => t.name).sort();
    expect(names).toEqual(["create_task", "load_skill", "query_ledger", "save_preference"]);
    expect(mock.requests[0]!.system).toContain("健身复盘");
    expect(mock.requests[0]!.system).toContain("健身话题");
    expect(mock.requests[0]!.system).not.toContain("加重要建议"); // 正文不进目录层
  });

  it("记忆注入：profile 槽（含脚注）进 system 且脚注被剥", async () => {
    const paths = appPaths(join(root, "d-f"));
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(paths, mock.adapter as LlmAdapter);
    await deps.memory.writeSlot(UID, "profile", "软件工程师[^1]，重复利。\n\n[^1]: chat:abc");
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.system).toContain("软件工程师，重复利");
    expect(mock.requests[0]!.system).not.toContain("[^1]");
  });

  it("切换到不存在的伙伴 → 抛错", async () => {
    const paths = appPaths(join(root, "d-g"));
    const deps = makeDeps(paths, textAdapter());
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const entry = await store.create(UID);
    await expect(store.switchAgent(UID, entry.id, "aid-nope")).rejects.toThrow();
  });
});

describe("ConversationStore（批次3：任务会话）", () => {
  it("taskAgent：独立于聊天会话池；followup 落任务会话日志；不进会话列表", async () => {
    const paths = appPaths(join(root, "d-t1"));
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "到点了，去睡觉" }] } }) }]);
    const deps = makeDeps(paths, mock.adapter as LlmAdapter);
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks });
    const agent = await store.taskAgent(UID, "tid-99", undefined);
    agent.followup("23:00 了，提醒睡觉");
    await agent.whenIdle();
    const events = agent.sessionLog.readAll();
    expect(events.map((e) => e.type)).toContain("turn/end");
    expect((await store.list(UID))).toHaveLength(0); // 任务会话不混入聊天列表
    expect(await store.taskAgent(UID, "tid-99", undefined)).toBe(agent); // 池化
  });
});
