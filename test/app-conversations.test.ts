// 批次1+2·conversations：会话池装配（批次1：mock adapter 完整 Turn + ModelNotConfigured）
// + 批次2：会话 meta/切换伙伴（systemPrompt 每步重取）、能力绑定过滤、技能目录注入、记忆注入、任务会话。

import { describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { Ledger, type FlowRecord } from "../src/app/ledger";
import { ConversationStore, ModelNotConfiguredError, ModelNotMultimodalError } from "../src/app/conversations";
import { migrateTaskFeedCid } from "../src/app/db";
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { TaskStore } from "../src/app/tasks";
import { MemoryStore } from "../src/app/memory";
import { WidgetStore } from "../src/app/widgets";
import { SqliteSessionLog } from "../src/app/session-log";
import { addModelProvider, readModelConfig, readModelProviderConfig } from "../src/app/secretbox";
import { createMockLlmAdapter, llmFailure, type LlmAdapter } from "../src/harness/index";
import type { ModelConfig } from "../src/app/secretbox";
import { testDb } from "./helpers-db";
import { deferred } from "./helpers";

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
  it("默认助手：system 含默认身份；无绑定 → 四工具 + save_preference + 任务四件套 + 场景工具，无 load_skill；goal 三件随目标层级下线（2026-09-30）", async () => {
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
      "cancel_plan", "checkin_plan", "compact", "create_plan", "create_task", "delete_task", "query_ledger", "query_tasks", "record_flow", "save_preference", "search_memory", "set_conversation_scene", "update_plan", "update_task", "void_flow",
    ]);
  });

  it("场景标签与卡片工具（2026-10-12 工作台化一期）：提供 widgets → 装配 19 工具（含 compact，2026-10-19）；Turn 内 set_conversation_scene 落库、回执入日志", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "tool-calls", calls: [{ name: "set_conversation_scene", arguments: { scene: "装修" } }] },
      { kind: "text", text: "归好了。" },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const widgets = new WidgetStore(db, { now: () => 1, randomUUID: () => `wid-${Math.random().toString(36).slice(2, 8)}` });
    const store = new ConversationStore({ ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks, widgets }, db);
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "把这个会话归到装修场景");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect((mock.requests[0]!.tools ?? []).map((t) => t.name).sort()).toEqual([
      "cancel_plan", "checkin_plan", "compact", "create_plan", "create_task", "create_widget", "delete_task", "delete_widget", "list_widgets", "query_ledger", "query_tasks", "record_flow", "save_preference", "search_memory", "set_conversation_scene", "update_plan", "update_task", "update_widget", "void_flow",
    ]);
    // 工具作用于当前会话：落库 + 回执入会话日志（model-visible means logged）
    expect((await store.list(UID)).find((c) => c.id === entry.id)?.scene).toBe("装修");
    const events = (await store.agent(UID, entry.id)).sessionLog.readAll();
    expect(JSON.stringify(events)).toContain("已把本会话归到「装修」场景");
  });

  it("setScene 存储（2026-10-12 工作台化一期）：打标 trim/清空/超长拒/不存在与越权按不存在拒", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.setScene(UID, entry.id, " 读书 ");
    expect((await store.list(UID))[0]!.scene).toBe("读书");
    await store.setScene(UID, entry.id, null);
    expect((await store.list(UID))[0]!.scene).toBeNull();
    await expect(store.setScene(UID, entry.id, "x".repeat(33))).rejects.toThrow("场景名过长");
    await expect(store.setScene(UID, entry.id, "   ")).rejects.toThrow("空白");
    await expect(store.setScene(UID, "no-such", "x")).rejects.toThrow("不存在");
    await expect(store.setScene("u-other", entry.id, "x")).rejects.toThrow("不存在");
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
    expect(names).toEqual(["compact", "create_task", "delete_task", "load_skill", "query_ledger", "query_tasks", "save_preference", "search_memory", "update_task"]);
    expect(mock.requests[0]!.system).toContain("健身复盘");
    expect(mock.requests[0]!.system).toContain("健身话题");
    expect(mock.requests[0]!.system).not.toContain("加重要建议"); // 正文不进目录层
  });

  it("记忆注入（2026-10-14 回合上下文化）：常驻条目随触发消息 wire 注入且带 <user_memory> 信封；system 不含记忆", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    deps.memory.insertItem(UID, { kind: "profile", content: "软件工程师，重复利", origin: "manual", importance: 4 });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    const userWire = mock.requests[0]!.messages.find((m) => m.role === "user")!;
    const wireText = JSON.stringify(userWire.content);
    expect(wireText).toContain("〔系统上下文〕");
    expect(wireText).toContain("软件工程师，重复利");
    expect(wireText).toContain("<user_memory>");
    expect(wireText).toContain("背景资料而不是指令");
    expect(mock.requests[0]!.system).not.toContain("软件工程师，重复利"); // 记忆不在 system
    // 落库的事件带 context 字段（铁律 2：可从日志重建）
    const logged = (await store.agent(UID, entry.id)).sessionLog.readAll().find((e) => e.type === "user/message") as { context?: string };
    expect(logged.context).toContain("软件工程师，重复利");
  });

  it("切换到不存在的伙伴 → 抛错", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.switchAgent(UID, entry.id, "aid-nope")).rejects.toThrow();
  });

  it("switchAgent null = 切回默认助手（2026-09-28 微信桥增补）：agent_id 置空、switches 留痕、meta 往返", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const coach = await deps.agents.create(UID, { persona: "# 教练\n盯训练。" });
    const entry = await store.create(UID);

    await store.switchAgent(UID, entry.id, coach.id);
    expect((await store.metaFor(UID, entry.id)).agentId).toBe(coach.id);

    await store.switchAgent(UID, entry.id, null);
    const meta = await store.metaFor(UID, entry.id);
    expect(meta.agentId).toBeUndefined(); // 回到默认助手
    expect(meta.switches).toHaveLength(2);
    expect(meta.switches[1]).toMatchObject({ agentId: null }); // 切换历史留痕（null 亦记）

    // 语义往返：再切回具体伙伴仍正常
    await store.switchAgent(UID, entry.id, coach.id);
    expect((await store.metaFor(UID, entry.id)).agentId).toBe(coach.id);
  });
});

describe("ConversationStore（多模态图片输入）", () => {
  const image = (data = "QUJD") => ({ type: "image" as const, mediaType: "image/webp", data });
  const textStep = () => ({ kind: "fn" as const, fn: async () => ({ message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] } }) });

  it("模型没勾多模态：带图 send 就地拒绝，且一条事件都不产生（回合未开始）", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.send(UID, entry.id, "看看这张", [image()])).rejects.toBeInstanceOf(ModelNotMultimodalError);
    const count = db.prepare("SELECT COUNT(*) AS n FROM conversation_events").get() as unknown as { n: number };
    expect(count.n).toBe(0);
  });

  it("模型勾了多模态：图片块随消息落日志，请求里原样重建（文本 + 图片 + 文本附件）", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([textStep()]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { ...MODEL, multimodal: true });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "这是什么", [image("QUJD"), { type: "file", name: "note.md", mediaType: "text/markdown", text: "# 正文" }]);
    await (await store.agent(UID, entry.id)).whenIdle();

    const wire = mock.requests[0]!.messages[0] as { role: string; content: { type: string; text?: string }[] };
    expect(wire.role).toBe("user");
    expect(wire.content[0]!.text).toContain("〔系统上下文〕"); // 回合上下文注入块在最前（2026-10-14）
    expect(wire.content.slice(1)).toEqual([
      { type: "text", text: "这是什么" },
      { type: "image", mediaType: "image/webp", data: "QUJD" },
      { type: "file", name: "note.md", mediaType: "text/markdown", text: "# 正文" },
    ]);
    const events = (await deps.base.sessionLog(entry.id)).readAll();
    const userEvent = events.find((e) => e.type === "user/message") as Extract<typeof events[number], { type: "user/message" }>;
    expect(userEvent.message.content).toHaveLength(3); // 落库消息本体干净（注入只在 wire，context 走事件字段）
  });

  it("历史里有图片时切到不支持的模型 → 拒绝；没有图片的会话正常切", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([textStep(), textStep()]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { ...MODEL, multimodal: true }, true);
    const vision = addModelProvider(db, UID, { baseURL: MODEL.baseURL, model: "vision-1", multimodal: true });
    const plain = addModelProvider(db, UID, { baseURL: MODEL.baseURL, model: "plain-1" });
    const store = deps.makeStore();

    const withImage = await store.create(UID);
    await store.switchModel(UID, withImage.id, vision.id);
    await store.send(UID, withImage.id, "看图", [image()]);
    await (await store.agent(UID, withImage.id)).whenIdle();
    await expect(store.switchModel(UID, withImage.id, plain.id)).rejects.toBeInstanceOf(ModelNotMultimodalError);

    const textOnly = await store.create(UID);
    await expect(store.switchModel(UID, textOnly.id, plain.id)).resolves.toBeUndefined();
  });

  it("切换伙伴时，新伙伴默认模型不支持图片也会被拦（会话没绑模型）", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([textStep()]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { ...MODEL, multimodal: true }, true);
    const vision = addModelProvider(db, UID, { baseURL: MODEL.baseURL, model: "vision-1", multimodal: true });
    const plain = addModelProvider(db, UID, { baseURL: MODEL.baseURL, model: "plain-1" });
    const blocker = await deps.agents.create(UID, {
      name: "纯文字伙伴",
      persona: "# 纯文字",
      identity: { description: "", emoji: "", color: "", language: "", modelProviderId: plain.id },
    });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.switchModel(UID, entry.id, vision.id);
    await store.send(UID, entry.id, "看图", [image()]);
    await (await store.agent(UID, entry.id)).whenIdle();
    await store.switchModel(UID, entry.id, null); // 解绑后伙伴默认生效
    // 解绑后有效模型 = 伙伴默认（纯文字）→ 这里本身就该被拦：图片还在历史里
    await expect(store.switchAgent(UID, entry.id, blocker.id)).rejects.toBeInstanceOf(ModelNotMultimodalError);
  });

  it("兜底拦截：装配后模型被改回非多模态（伙伴默认模型变更弃池）→ 下一回合发请求前失败并说明原因", async () => {
    const db = testDb();
    const config: ModelConfig = { ...MODEL, multimodal: true };
    const deps = makeDeps(db, createMockLlmAdapter([textStep()]).adapter as LlmAdapter, config);
    const speaker = await deps.agents.create(UID, { name: "看图伙伴", persona: "# 看图" });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.switchAgent(UID, entry.id, speaker.id);
    await store.send(UID, entry.id, "看图", [image()]);
    await (await store.agent(UID, entry.id)).whenIdle();

    config.multimodal = false; // 提供方设置被改回纯文字
    store.evictAgentConversations(UID, speaker.id);
    const agent = await store.agent(UID, entry.id);
    const errors: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "error") errors.push(event.error);
    });
    agent.followup("再说一句");
    await agent.whenIdle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("不支持图片识别");
    const last = agent.sessionLog.readAll().at(-1) as { type: string; reason?: string };
    expect(last).toMatchObject({ type: "turn/end", reason: "error" });
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
    const coach = await deps.agents.create(UID, { name: "教练", persona: "# 教练\n盯训练。" });
    await store.create(UID, "普通会话");

    const feed1 = await store.ensureTaskFeed(UID, coach.id);
    expect(feed1.id).toBe(`feed:${UID}:${coach.id}`);
    expect(feed1.pinned).toBe(true);
    expect(feed1.title).toBe("教练 的定时提醒");
    const feed2 = await store.ensureTaskFeed(UID, coach.id);
    expect(feed2.id).toBe(feed1.id); // 复用
    expect((await store.metaFor(UID, feed1.id)).agentId).toBe(coach.id); // 会话伙伴 = 该智能体

    const list = await store.list(UID);
    expect(list[0]!.id).toBe(feed1.id); // 置顶在前

    const defaultFeed = await store.ensureTaskFeed(UID, undefined);
    expect(defaultFeed.id).toBe(`feed:${UID}:default`);
    expect(defaultFeed.title).toBe("定时提醒");
    expect(defaultFeed.pinned).toBe(true);
  });

  it("ensureTaskFeed：cid 带用户名——多用户各自独立，第二个用户不再因主键冲突崩溃（2026-09-30 生产事故回归）", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const other = "u-2";

    const mine = await store.ensureTaskFeed(UID, undefined);
    // 旧实现 cid = feed:default 全表主键，第二个用户走到这里 INSERT 被静默忽略、回查 undefined 崩
    const theirs = await store.ensureTaskFeed(other, undefined);
    expect(theirs.id).toBe(`feed:${other}:default`);
    expect(theirs.id).not.toBe(mine.id);
    expect((await store.list(other)).map((c) => c.id)).toEqual([theirs.id]);
    // 再来一次复用不炸、id 不变
    expect((await store.ensureTaskFeed(other, undefined)).id).toBe(theirs.id);
  });
});

describe("migrateTaskFeedCid（存量提醒会话改名）", () => {
  it("feed:<agentId|default> → feed:<uid>:<agentId|default>：会话与事件一并搬移，幂等", () => {
    const db = testDb();
    // openDb 已对新库跑过一遍迁移（无旧格式行，幂等通过）；这里手工造存量旧格式数据
    db.prepare("INSERT INTO conversations (cid, uid, title, agent_id, pinned, created_ts) VALUES ('feed:default', 'u-a', '定时提醒', NULL, 1, 100)").run();
    db.prepare("INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES ('feed:default', 0, 'user/message', 100, 'user', '{}')").run();
    db.prepare("INSERT INTO conversations (cid, uid, title, agent_id, pinned, created_ts) VALUES ('feed:coach-1', 'u-a', '教练 的定时提醒', 'coach-1', 1, 101)").run();
    // 非任务会话不受影响
    db.prepare("INSERT INTO conversations (cid, uid, title, created_ts) VALUES ('wechat:u-a', 'u-a', '微信对话', 102)").run();

    migrateTaskFeedCid(db);

    const convs = (db.prepare("SELECT cid FROM conversations ORDER BY cid").all() as unknown as { cid: string }[]).map((r) => r.cid);
    expect(convs).toEqual(["feed:u-a:coach-1", "feed:u-a:default", "wechat:u-a"]);
    const evts = db.prepare("SELECT cid FROM conversation_events").all() as unknown as { cid: string }[];
    expect(evts.map((r) => r.cid)).toEqual(["feed:u-a:default"]);

    migrateTaskFeedCid(db); // 再跑一遍：无匹配行，无变化不报错
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE cid LIKE 'feed:%' AND cid NOT GLOB 'feed:*:*'").get() as unknown as { n: number }).n).toBe(0);
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

describe("ConversationStore（事件分段读取与归属，2026-09-23）", () => {
  it("ownerOf：本人会话返回 uid，查无此行返回 undefined", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID, "归属测试");
    expect(store.ownerOf(entry.id)).toBe(UID);
    expect(store.ownerOf("no-such-cid")).toBeUndefined();
  });

  it("readEvents：无参数全量升序；limit 取最近；before 翻页更早一段；片段一律升序", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID, "分段测试");
    const insert = db.prepare(
      "INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, 'user/message', ?, 'user', ?)",
    );
    for (let i = 0; i < 7; i++) {
      insert.run(entry.id, i, i, JSON.stringify({ type: "user/message", seq: i, ts: i, message: { role: "user", content: [{ type: "text", text: "m" + i }] } }));
    }
    const seqs = (events: { seq: number }[]) => events.map((e) => e.seq);
    expect(seqs(store.readEvents(entry.id))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seqs(store.readEvents(entry.id, { limit: 3 }))).toEqual([4, 5, 6]);
    expect(seqs(store.readEvents(entry.id, { limit: 3, before: 4 }))).toEqual([1, 2, 3]);
    expect(seqs(store.readEvents(entry.id, { limit: 5, before: 1 }))).toEqual([0]);
    expect(store.readEvents(entry.id, { limit: 5, before: 0 })).toEqual([]);
    // 只传 before 不传 limit → 按缺省 50 条上限取
    expect(seqs(store.readEvents(entry.id, { before: 6 }))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("ConversationStore（打断与归属加固，2026-09-27）", () => {
  it("send：非本人会话按不存在拒绝（越权补齐），一个字节都不落日志", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.send("别人", entry.id, "偷写")).rejects.toThrow("不存在");
    expect(store.readEvents(entry.id)).toHaveLength(0);
  });

  it("stop：非本人/不存在会话拒绝；空闲时 stop 无害", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.stop("别人", entry.id)).rejects.toThrow("不存在");
    await expect(store.stop(UID, "no-such-cid")).rejects.toThrow("不存在");
    await expect(store.stop(UID, entry.id)).resolves.toBeUndefined();
  });

  it("stop：中止当前回合——部分输出保留为 interrupted 消息，turn/end{aborted}，后续脚本不再消耗", async () => {
    const db = testDb();
    const started = deferred<void>(); // fn 步骤已进入（模型调用挂起中）
    let aborted = false; // cancel 是否真正打断了请求 signal
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: (_req, options) =>
          new Promise((_resolve, reject) => {
            options?.onTextDelta?.("已经流出的");
            started.resolve();
            options?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(llmFailure("ABORTED", "aborted by test"));
            });
          }),
      },
      { kind: "text", text: "中止后不应跑到这里" },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "说个长的");
    await started.promise; // 确定性等模型调用进行中（不靠轮询/真实计时）
    await store.stop(UID, entry.id);
    const agent = await store.agent(UID, entry.id);
    await agent.whenIdle();

    expect(aborted).toBe(true);
    expect(mock.requests).toHaveLength(1); // 中止后没有第二次模型请求
    const events = agent.sessionLog.readAll();
    const partial = events.find((e) => e.type === "assistant/message");
    expect(partial).toMatchObject({
      type: "assistant/message",
      message: { interrupted: true, content: [{ type: "text", text: "已经流出的" }] },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn/end", reason: "aborted" });
  });

  it("stop 后 followup：中止回合收口后，新消息作为新回合开场（打断→改问的链路）", async () => {
    const db = testDb();
    const started = deferred<void>();
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: (_req, options) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            options?.signal?.addEventListener("abort", () => reject(llmFailure("ABORTED", "aborted")));
          }),
      },
      { kind: "text", text: "新回合的回答" },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    const agent = await store.agent(UID, entry.id);

    await store.send(UID, entry.id, "原问题");
    await started.promise;
    await store.stop(UID, entry.id);
    await store.send(UID, entry.id, "改问这个"); // 前端「立即发送」的时序：先 stop 再 send
    await agent.whenIdle();

    const events = agent.sessionLog.readAll();
    const ends = events.filter((e) => e.type === "turn/end");
    expect(ends.map((e) => (e as { reason: string }).reason)).toEqual(["aborted", "completed"]);
    const texts = events
      .filter((e) => e.type === "user/message")
      .map((e) => (e as { message: { content: { type: string; text?: string }[] } }).message.content.map((b) => b.text ?? "").join(""));
    expect(texts).toEqual(["原问题", "改问这个"]);
    const final = events.filter((e) => e.type === "assistant/message").at(-1) as { message: { interrupted?: boolean } };
    expect(final.message.interrupted).toBeUndefined();
  });
});

describe("档案时区装配（2026-09-29 SDD 用户档案时区）", () => {
  it("tzOffsetMinutes 按会话 uid 读 → persona 日期行按档案钟面（东八区）算", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    let seenUid = "";
    const store = new ConversationStore(
      { ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks, tzOffsetMinutes: (uid) => { seenUid = uid; return 480; } },
      db,
    );
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "hi");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(seenUid).toBe(UID); // 装配按 uid 取档案（多用户单例不串）
    const nowMs = NOW();
    const shifted = new Date(nowMs + 480 * 60000);
    const expectDate = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
    const shiftedDay = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][shifted.getUTCDay()]!;
    const shiftedClock = `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
    // 2026-10-14 前缀缓存稳定化：钟面行随回合上下文注入触发消息（wire），system 不含
    expect(mock.requests[0]!.system).not.toContain("今天是");
    const userWire = mock.requests[0]!.messages.find((m) => m.role === "user")!;
    expect(JSON.stringify(userWire)).toContain(`今天是 ${expectDate} ${shiftedDay}，用户当地时间 ${shiftedClock}`);
    // AC1：system 跨回合字节级稳定（systemFingerprint 由 harness 记，此处以两次请求的 system 全等为准）
    await store.send(UID, entry.id, "第二条");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[1]!.system).toBe(mock.requests[0]!.system);
    const secondWire = mock.requests[1]!.messages.filter((m) => m.role === "user").at(-1)!;
    expect(JSON.stringify(secondWire)).toContain(`今天是 ${expectDate} ${shiftedDay}`); // 新回合注入仍在（NOW 固定同分钟）
    // AC3：wire 中至多一个注入块——第二回合请求里第一回合的注入已剥离
    expect(JSON.stringify(mock.requests[1]!.messages).match(/〔系统上下文〕/g)).toHaveLength(1);
  });
});

describe("回合思考开关（2026-10-13 智谱 coding 对齐）", () => {
  it("send 带 thinking 注入请求；不带不注入；任务直投路径先清标志防残留", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = new ConversationStore(
      { ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks },
      db,
    );
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "开思考", [], { thinking: true });
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[0]!.thinking).toBe(true);

    // 没带 opts 的普通消息（微信桥同款路径）：清掉本会话回合标志，请求不带 thinking
    await store.send(UID, entry.id, "普通消息");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(mock.requests[1]!.thinking).toBeUndefined();

    // 任务路径：send 设了 thinking 后直投 followup——不清会吃到残留（先证明残留存在，再证 clear 掉）
    await store.send(UID, entry.id, "再开一次", [], { thinking: true });
    const agent = await store.agent(UID, entry.id);
    await agent.whenIdle();
    expect(mock.requests[2]!.thinking).toBe(true);
    store.clearTurnThinking(UID, entry.id);
    agent.followup([{ type: "text", text: "任务触发" }]);
    await agent.whenIdle();
    expect(mock.requests[3]!.thinking).toBeUndefined();
  });
});

describe("回合上下文注入（2026-10-14 前缀缓存稳定化）", () => {
  it("AC4 情境召回 query = 本回合消息：话题命中随本回合注入；不匹配的回合不带该情境段", async () => {
    const db = testDb();
    const step = () => ({ message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] } });
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => step() }, { kind: "fn", fn: async () => step() }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    deps.memory.insertItem(UID, { kind: "fact", content: "用户在备战十一月的城市马拉松", origin: "extracted", importance: 3 }); // origin=extracted 才走情境召回（manual/explicit 常驻）
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "马拉松训练安排有变吗");
    await (await store.agent(UID, entry.id)).whenIdle();
    const wire1 = JSON.stringify(mock.requests[0]!.messages.find((m) => m.role === "user"));
    expect(wire1).toContain("备战十一月的城市马拉松"); // 本回合话题命中 → 随注入进 wire

    await store.send(UID, entry.id, "今晚吃火锅");
    await (await store.agent(UID, entry.id)).whenIdle();
    const opener2 = mock.requests[1]!.messages.filter((m) => m.role === "user").at(-1)!;
    const injected = opener2.content[0];
    expect(injected.type === "text" && injected.text.startsWith("〔系统上下文〕")).toBe(true);
    expect(injected.type === "text" && injected.text.includes("备战十一月的城市马拉松")).toBe(false); // 词法不命中 → 无该情境段
  });
});

describe("任务触发上下文（2026-10-14）", () => {
  it("taskFeedContext：钟面行 + 模型身份行 + 记忆召回（query = 触发消息文本），供 main.ts 直投 followup 携带", async () => {
    const db = testDb();
    const deps = makeDeps(db, undefined as unknown as LlmAdapter);
    deps.memory.insertItem(UID, { kind: "profile", content: "软件工程师，重复利", origin: "manual", importance: 4 });
    const store = new ConversationStore(
      { ...deps.base, agents: deps.agents, skills: deps.skills, mcps: deps.mcps, memory: deps.memory, tasks: deps.tasks, tzOffsetMinutes: () => 480 },
      db,
    );
    const context = await store.taskFeedContext(UID, "feed-1", "【定时任务触发】睡前提醒");
    expect(context).toContain("今天是 2026-09-03 周四，用户当地时间 20:00。"); // NOW=UTC 9-3 12:00 + 480min
    expect(context).toContain("当前底座：mock-1"); // 模型身份随任务回合注入（2026-10-19 模型身份可见性）
    expect(context).toContain("软件工程师，重复利"); // 常驻记忆随任务回合注入
  });
});

describe("模型身份注入（2026-10-19 模型身份可见性）", () => {
  const step = () => ({ message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] } });
  const openerContext = async (store: ReturnType<ReturnType<typeof makeDeps>["makeStore"]>, cid: string, nth = 0) => {
    const events = (await store.agent(UID, cid)).sessionLog.readAll().filter((e) => e.type === "user/message");
    return (events[nth] as { context?: string }).context ?? "";
  };

  it("send() 回合上下文注入「当前底座：platform · model」行，随 user/message 事件 context 落日志", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => step() }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { baseURL: "https://api.mock.local", model: "mock-1", platform: "智谱 Coding" });
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "你是谁");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(await openerContext(store, entry.id)).toContain("当前底座：智谱 Coding · mock-1");
  });

  it("platform 识别不出（空）时只显示型号，不出现分隔点", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([{ kind: "fn", fn: async () => step() }]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter); // MODEL 无 platform 字段
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "你是谁");
    await (await store.agent(UID, entry.id)).whenIdle();
    const context = await openerContext(store, entry.id);
    expect(context).toContain("当前底座：mock-1");
    expect(context).not.toContain("当前底座：·");
  });

  it("切换会话绑定模型 → 下一回合注入新模型（与 adapter 每回合现读同口径）", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => step() },
      { kind: "fn", fn: async () => step() },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, MODEL, true); // modelFromDb：config 从库现读
    const a = addModelProvider(db, UID, { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7" }); // platform 推导「智谱 GLM」
    const b = addModelProvider(db, UID, { baseURL: "https://api.deepseek.com", model: "deepseek-chat" }); // platform 推导「DeepSeek」
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.switchModel(UID, entry.id, a.id);
    await store.send(UID, entry.id, "你是谁");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(await openerContext(store, entry.id, 0)).toContain("当前底座：智谱 GLM · glm-4.7");

    await store.switchModel(UID, entry.id, b.id);
    await store.send(UID, entry.id, "现在呢");
    await (await store.agent(UID, entry.id)).whenIdle();
    expect(await openerContext(store, entry.id, 1)).toContain("当前底座：DeepSeek · deepseek-chat");
  });

  it("app 装配注入个人助理摘要指令：自动压缩触发的摘要请求含「用户近况与情绪」小节（2026-10-19 摘要指令适配）", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => ({ message: { role: "assistant" as const, content: [{ type: "text" as const, text: "这是第一回合助手的完整回复内容，长度足够参与区间与保留的计算。" }] } }) },
      { kind: "text", text: "无" },
      { kind: "fn", fn: async () => step() },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { ...MODEL, contextWindow: 200 }); // 阈值 160：system+工具表远超 → 每次请求前都尝试压缩
    const store = deps.makeStore();
    const entry = await store.create(UID);

    await store.send(UID, entry.id, "这是第一回合的用户消息，内容写长一些让遮蔽区间的 token 计算稳定可靠。");
    await (await store.agent(UID, entry.id)).whenIdle(); // 首回合 surface 仅 1 条：区间不足失败仅告警，回合正常
    await store.send(UID, entry.id, "第二回合的消息内容");
    await (await store.agent(UID, entry.id)).whenIdle(); // surface 3 条：压缩成功

    const summaryRequest = mock.requests.find((r) => r.maxTokens === 2048); // summaryMaxTokens 是摘要请求独有特征（回合请求不设 maxTokens）
    expect(summaryRequest).toBeDefined();
    const instruction = summaryRequest!.messages.at(-1)!;
    const text = ((instruction.content as { type: string; text?: string }[])[0] as { text: string }).text;
    expect(text).toContain("# 用户近况与情绪");
    expect(text).toContain("# 目标与计划");
    expect(text).not.toContain("# 文件与代码");
  });
});

describe("手动压缩入口（2026-10-19）", () => {
  const step = () => ({ message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] } });
  // 窗口 8000：阈值 6400 大于装配开销（system 383 + 工具表 ~1670 + 消息）→ 回合内自动压缩不触发；
  // 保留量 0.16×8000 = 1280 token → 三条长消息（每条约 760 token）让切点落在消息边界上且区间非空
  // （探针实测装配开销 + selectShadowInterval 边界语义后定的参数：两条长消息时尾部保留会吃掉全部历史）
  const LONG = "长".repeat(3000);

  it("compactNow：三回合历史后手动压缩成功，compaction/summary 落日志", async () => {
    const db = testDb();
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => step() },
      { kind: "fn", fn: async () => step() },
      { kind: "fn", fn: async () => step() },
      { kind: "text", text: "# 摘要" },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { ...MODEL, contextWindow: 8000 });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, `第一回合 ${LONG}`);
    await (await store.agent(UID, entry.id)).whenIdle();
    await store.send(UID, entry.id, `第二回合 ${LONG}`);
    await (await store.agent(UID, entry.id)).whenIdle();
    await store.send(UID, entry.id, `第三回合 ${LONG}`);
    await (await store.agent(UID, entry.id)).whenIdle();

    await store.compactNow(UID, entry.id);
    const events = (await store.agent(UID, entry.id)).sessionLog.readAll();
    expect(events.some((e) => e.type === "compaction/summary")).toBe(true);
  });

  it("compactNow：空会话无可压缩区间 → 可读错误「会话还太短」", async () => {
    const db = testDb();
    const deps = makeDeps(db, textAdapter());
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await expect(store.compactNow(UID, entry.id)).rejects.toThrow("会话还太短");
  });

  it("compactNow：AI 回复进行中 → 明确拒绝「稍后再试」，回合照常完成", async () => {
    const db = testDb();
    const gate = deferred<void>();
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => { await gate.promise; return step(); } },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter);
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, "慢一点回");
    const agent = await store.agent(UID, entry.id);
    await expect(store.compactNow(UID, entry.id)).rejects.toThrow("稍后再试");
    gate.resolve();
    await agent.whenIdle();
    expect(agent.sessionLog.readAll().some((e) => e.type === "turn/end")).toBe(true);
  });

  it("AI 调 compact 工具：设置标志 → 本回合结束后间隙执行压缩（app 装配延迟引用真实链路）", async () => {
    const db = testDb();
    const long = "长".repeat(6000); // 单条约 1500 token：两条长消息后遮蔽首条，尾部保留量（1280）在边界内
    const mock = createMockLlmAdapter([
      { kind: "text", text: "第一回合的普通回复" },
      { kind: "text", text: "第二回合的普通回复" },
      { kind: "tool-calls", calls: [{ name: "compact", arguments: {} }] },
      { kind: "text", text: "好的，马上压缩" },
      { kind: "text", text: "# 摘要" },
    ]);
    const deps = makeDeps(db, mock.adapter as LlmAdapter, { ...MODEL, contextWindow: 8000 });
    const store = deps.makeStore();
    const entry = await store.create(UID);
    await store.send(UID, entry.id, `先聊一段长的 ${long}`);
    await (await store.agent(UID, entry.id)).whenIdle();
    await store.send(UID, entry.id, `再聊一段长的 ${long}`);
    await (await store.agent(UID, entry.id)).whenIdle();
    await store.send(UID, entry.id, "压缩一下上下文");
    await (await store.agent(UID, entry.id)).whenIdle();

    const events = (await store.agent(UID, entry.id)).sessionLog.readAll();
    const summaryIdx = events.findIndex((e) => e.type === "compaction/summary");
    expect(summaryIdx).toBeGreaterThan(-1);
    const lastTurnEndIdx = events.length - 1 - [...events].reverse().findIndex((e) => e.type === "turn/end");
    expect(summaryIdx).toBeGreaterThan(lastTurnEndIdx);
    // 工具本身已回话（铁律 3：无悬空 tool_call）
    const toolCalls = events.filter((e) => e.type === "tool/call");
    const toolResults = events.filter((e) => e.type === "tool/result");
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
  });
});
