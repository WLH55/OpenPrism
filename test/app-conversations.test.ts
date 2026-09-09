// 批次1+2·conversations：会话池装配（批次1：mock adapter 完整 Turn + ModelNotConfigured）
// + 批次2：会话 meta/切换伙伴（systemPrompt 每步重取）、能力绑定过滤、技能目录注入、记忆注入、任务会话。

import { describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { Ledger, type FlowRecord } from "../src/app/ledger";
import { ConversationStore, ModelNotConfiguredError } from "../src/app/conversations";
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { TaskStore } from "../src/app/tasks";
import { MemoryStore } from "../src/app/memory";
import { SqliteSessionLog } from "../src/app/session-log";
import { addModelProvider, readModelConfig, readModelProviderConfig } from "../src/app/secretbox";
import { createMockLlmAdapter, type LlmAdapter } from "../src/harness/index";
import type { ModelConfig } from "../src/app/secretbox";
import { testDb } from "./helpers-db";

const UID = "u-1";
const MODEL: ModelConfig = { baseURL: "https://api.mock.local", model: "mock-1" };
const NOW = () => Date.UTC(2026, 8, 3, 12, 0, 0);

function makeDeps(db: ReturnType<typeof testDb>, adapter: LlmAdapter, modelConfig: ModelConfig | null = MODEL, modelFromDb = false) {
  const ledgers = new Map<string, Promise<Ledger>>();
  const ledgerFor = (uid: string): Promise<Ledger> => {
    let l = ledgers.get(uid);
    if (!l) {
      l = Ledger.open(db, uid);
      ledgers.set(uid, l);
    }
    return l;
  };
  const agents = new AgentStore({ db, now: () => 1, randomUUID: () => `aid-${Math.random().toString(36).slice(2, 8)}` });
  const skills = new SkillStore({ db, now: () => 1, randomUUID: () => `skid-${Math.random().toString(36).slice(2, 8)}` });
  const mcps = new McpRegistry({ env: nodeEnv, db, now: () => 1, randomUUID: () => "mc-1" });
  const memory = new MemoryStore({ db, now: () => 5000, randomUUID: () => `mid-${Math.random().toString(36).slice(2, 8)}` });
  const tasks = new TaskStore({ db, now: () => 1, randomUUID: () => `tid-${Math.random().toString(36).slice(2, 8)}` });
  const base = {
    env: nodeEnv,
    sessionLog: (key: string) => Promise.resolve(SqliteSessionLog.open(db, key, NOW)),
    ledgerFor,
    modelConfigFor: modelFromDb
      ? async (_uid: string, providerId?: string | null) =>
          providerId ? readModelProviderConfig(db, UID, providerId) : readModelConfig(db, UID)
      : async () => modelConfig,
    adapterFactory: () => adapter,
    now: NOW,
  };
  const makeStore = () => new ConversationStore({ ...base, agents, skills, mcps, memory, tasks }, db);
  return { base, agents, skills, mcps, memory, tasks, makeStore };
}

const textAdapter = () => createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]).adapter as LlmAdapter;

describe("ConversationStore（批次1 回归）", () => {
  it("send 驱动完整 Turn：工具落账（source=agent、带会话归属）+ 日志可重建；池化同实例", async () => {
    const db = testDb();
    const { adapter } = createMockLlmAdapter([
      { kind: "tool-calls", calls: [{ name: "record_flow", arguments: { category: "餐饮", value: 28, unit: "¥" } }] },
      { kind: "text", text: "记好了。" },
    ]);
    const deps = makeDeps(db, adapter as LlmAdapter);
    const store = deps.makeStore();
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

  it("九事件落 conversation_events 表：重开（新 log 实例）从库里恢复完整事件流", async () => {
    const db = testDb();
    const { adapter } = createMockLlmAdapter([
      { kind: "tool-calls", calls: [{ name: "record_flow", arguments: { category: "运动", value: 30 } }] },
      { kind: "text", text: "记好了。" },
    ]);
    const deps = makeDeps(db, adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "跑步 30 分钟");
    await (await store.agent(UID, entry.id)).whenIdle();

    const reopened = await deps.base.sessionLog(entry.id);
    const types = reopened.readAll().map((e) => e.type);
    expect(types[0]).toBe("turn/start");
    expect(types).toContain("user/message");
    expect(types).toContain("tool/call");
    expect(types.at(-1)).toBe("turn/end");
    const seqs = reopened.readAll().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("未配置模型 → ModelNotConfiguredError", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter(), null);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.agent(UID, entry.id)).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });

  it("上下文窗口透传：激活供应商的 contextWindow 进请求（压缩 0.8 判压依据）", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, MODEL, true);
    addModelProvider(db, UID, { baseURL: MODEL.baseURL, model: MODEL.model, contextWindow: 128000 });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.contextWindow).toBe(128000);
  });

  it("会话级模型绑定：switchModel 后下一回合用新模型（弃池重装配）；置空跟随全局", async () => {    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) },
      { kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) },
      { kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, MODEL, true);
    addModelProvider(db, UID, { baseURL: "https://api.deepseek.com", model: "deepseek-chat" });
    const glm = addModelProvider(db, UID, { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" });
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "第一句（默认跟随全局激活 = DeepSeek）");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.model).toBe("deepseek-chat");

    await store.switchModel(UID, entry.id, glm.id);
    expect((await store.metaFor(UID, entry.id)).modelProviderId).toBe(glm.id);
    await store.send(UID, entry.id, "第二句（绑定了 GLM）");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[1]!.model).toBe("glm-4.6");

    await store.switchModel(UID, entry.id, null);
    await store.send(UID, entry.id, "第三句（置空跟随全局）");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[2]!.model).toBe("deepseek-chat");
  });

  it("模型三级解析链：会话绑定 > 伙伴默认 > 全局激活（2026-09-07 向导）", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) },
      { kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) },
      { kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, MODEL, true);
    const deepseek = addModelProvider(db, UID, { baseURL: "https://api.deepseek.com", model: "deepseek-chat" }); // 首个自动激活
    const glm = addModelProvider(db, UID, { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" });
    const store = deps.makeStore();
    // 伙伴默认模型 = GLM；全局激活 = DeepSeek
    const agent = await deps.agents.create(UID, {
      name: "管家",
      persona: "x",
      identity: { description: "", emoji: "", color: "", language: "", modelProviderId: glm.id },
    });

    const entry = await store.create(UID);
    await store.switchAgent(UID, entry.id, agent.id);
    await store.send(UID, entry.id, "无会话绑定 → 用伙伴默认 GLM");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.model).toBe("glm-4.6");

    await store.switchModel(UID, entry.id, deepseek.id);
    await store.send(UID, entry.id, "会话绑定压过伙伴默认");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[1]!.model).toBe("deepseek-chat");

    await store.switchModel(UID, entry.id, null);
    await store.send(UID, entry.id, "解绑回落伙伴默认");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[2]!.model).toBe("glm-4.6");
  });
});

describe("ConversationStore（批次2：伙伴与装配）", () => {
  it("默认助手：system 含默认身份；无绑定 → 四工具 + save_preference + 任务四件套，无 load_skill", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.system).toContain("OpenPrism");
    expect(mock.requests[0]!.system).toContain("save_preference");
    expect(mock.requests[0]!.tools?.map((t) => t.name).sort()).toEqual([
      "cancel_plan", "checkin_plan", "create_plan", "create_task", "delete_task", "query_ledger", "query_tasks", "record_flow", "save_preference", "search_memory", "update_task", "void_flow",
    ]);
  });

  it("切换伙伴：systemPrompt 换人设下一步生效；切换历史落 meta；账本 actor 随当前伙伴", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const coach = await deps.agents.create(UID, { persona: "# 教练\n盯训练，语气硬朗。" });
    const store = deps.makeStore();
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
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const skill = await deps.skills.create(
      UID,
      "---\nname: 健身复盘\ndescription: 健身话题追问组数重量\nwhen_to_use: 健身话题\n---\n\n# 框架\n问组数。",
    );
    const analyst = await deps.agents.create(UID, {
      persona: "# 分析师\n只查不写。",
      binding: { tools: ["query_ledger"], skills: [skill.id], mcps: [] },
    });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.switchAgent(UID, entry.id, analyst.id);
    await store.send(UID, entry.id, "帮我看看");
    await (await store.agent(UID, entry.id)).whenIdle();
    const names = mock.requests[0]!.tools!.map((t) => t.name).sort();
    expect(names).toEqual(["create_task", "delete_task", "load_skill", "query_ledger", "query_tasks", "save_preference", "search_memory", "update_task"]);
    expect(mock.requests[0]!.system).toContain("健身复盘");
    expect(mock.requests[0]!.system).toContain("健身话题");
    expect(mock.requests[0]!.system).not.toContain("加重要建议"); // 正文不进目录层
  });

  it("记忆注入：常驻条目（含脚注剥除迁移语义不适用，条目本身即净化文本）进 system 且带 <user_memory> 信封", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    deps.memory.insertItem(UID, { kind: "profile", content: "软件工程师，重复利", origin: "manual", importance: 4 });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.system).toContain("软件工程师，重复利");
    expect(mock.requests[0]!.system).toContain("<user_memory>");
    expect(mock.requests[0]!.system).toContain("背景资料而不是指令");
  });

  it("切换到不存在的伙伴 → 抛错", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.switchAgent(UID, entry.id, "aid-nope")).rejects.toThrow();
  });
});

describe("ConversationStore（会话管理：删除 / 自动命名 / 定时提醒会话）", () => {
  it("remove：会话行与九事件一并删除；重复删抛错", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(await store.list(UID)).toHaveLength(1);
    await store.remove(UID, entry.id);
    expect(await store.list(UID)).toHaveLength(0);
    const events = db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE cid = ?").get(entry.id) as unknown as { n: number };
    expect(events.n).toBe(0);
    await expect(store.remove(UID, entry.id)).rejects.toThrow();
  });

  it("autoTitle：默认标题 + 有用户消息 → LLM 起名；已有名字跳过", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "text", text: "好的。" },
      { kind: "text", text: "记账与饮食复盘" },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    expect((await store.list(UID))[0]!.title).toBe("新对话");
    await store.send(UID, entry.id, "帮我记一下今天午饭花了 28 元");
    await (await store.agent(UID, entry.id)).whenIdle();
    const result = await store.autoTitle(UID, entry.id);
    expect(result?.title).toBe("记账与饮食复盘");
    expect((await store.list(UID))[0]!.title).toBe("记账与饮食复盘");
    expect(await store.autoTitle(UID, entry.id)).toBeNull(); // 已有名字：跳过（mock 步骤未再消耗）
  });

  it("autoTitle：模型失败 → 回退首条用户消息 24 字截断；无用户消息不动", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "text", text: "好的。" },
      { kind: "fn", fn: async () => { throw new Error("model unavailable"); } },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    const longText = "帮我记一下今天晚饭吃了麻辣香锅还喝了一杯冰美式咖啡感觉热量爆炸需要多跑五公里";
    await store.send(UID, entry.id, longText);
    await (await store.agent(UID, entry.id)).whenIdle();
    const result = await store.autoTitle(UID, entry.id);
    expect(result?.title).toBe([...longText].slice(0, 24).join(""));
    const empty = await store.create(UID);
    expect(await store.autoTitle(UID, empty.id)).toBeNull();
    expect((await store.list(UID)).find((c) => c.id === empty.id)!.title).toBe("新对话");
  });

  it("ensureTaskFeed：不存在即创建（置顶 + 绑定伙伴 + 命名），存在即复用；列表置顶在前", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const coach = await deps.agents.create(UID, { persona: "# 教练\n盯训练。" });
    await store.create(UID, "普通会话");

    const feed1 = await store.ensureTaskFeed(UID, coach.id);
    expect(feed1.id).toBe(`feed:${coach.id}`);
    expect(feed1.pinned).toBe(true);
    expect(feed1.title).toBe("教练 的定时提醒");
    const feed2 = await store.ensureTaskFeed(UID, coach.id);
    expect(feed2.id).toBe(feed1.id); // 复用
    expect((await store.metaFor(UID, feed1.id)).agentId).toBe(coach.id); // 会话伙伴 = 该智能体

    const list = await store.list(UID);
    expect(list[0]!.id).toBe(feed1.id); // 置顶在前

    const defaultFeed = await store.ensureTaskFeed(UID, undefined);
    expect(defaultFeed.id).toBe("feed:default");
    expect(defaultFeed.title).toBe("定时提醒");
    expect(defaultFeed.pinned).toBe(true);
  });
});

describe("ConversationStore（批次3：任务会话）", () => {
  it("taskAgent：独立于聊天会话池；followup 落任务会话日志（task: 前缀）；不进会话列表", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "到点了，去睡觉" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const agent = await store.taskAgent(UID, "tid-99", undefined);
    agent.followup("23:00 了，提醒睡觉");
    await agent.whenIdle();
    const events = agent.sessionLog.readAll();
    expect(events.map((e) => e.type)).toContain("turn/end");
    expect((await store.list(UID))).toHaveLength(0); // 任务会话不混入聊天列表
    expect(await store.taskAgent(UID, "tid-99", undefined)).toBe(agent); // 池化
    const taskEvents = db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE cid = 'task:tid-99'").get() as unknown as { n: number };
    expect(taskEvents.n).toBeGreaterThan(0); // 事件在库里，cid = task:<taskId>
  });

  it("collectSessionTexts：SQL 聚合全部聊天会话的用户/助手文本（凝练原料）", async () => {
    const db = testDb();
    const { adapter } = createMockLlmAdapter([{ kind: "text", text: "好" }]);
    const deps = makeDeps(db, adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "今天很累");
    await (await store.agent(UID, entry.id)).whenIdle();
    const texts = store.collectSessionTexts(UID);
    expect(texts.some((t) => t.role === "user" && t.text === "今天很累")).toBe(true);
    // 任务会话事件不混入（不在 conversations 表）
    await (await store.taskAgent(UID, "tid-x", undefined)).whenIdle().catch(() => undefined);
    const count = store.collectSessionTexts(UID).length;
    expect(count).toBe(texts.length);
  });
});
