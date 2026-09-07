// 记忆三层（对齐 DeepTutor）：L1 live 适配器/指纹 diff/refresh 变更日志；L2 抽取（section+refs 校验、seen 门控、
// fail-safe）；L3 综合（只吃 L2 新事实、preferences 排除、脚注剥离注入）；runAll 全链。

import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Ledger, insertLedgerRecord } from "../src/app/ledger";
import { MemoryStore } from "../src/app/memory";
import { L3_AUTO_SLOTS, MemoryLayers, parseFactsJson } from "../src/app/memory-layers";
import { TaskStore } from "../src/app/tasks";
import { createMockLlmAdapter } from "../src/harness/index";
import { testDb } from "./helpers-db";

const NOW = 1_700_000_000_000;

function makeWorld() {
  const db: DatabaseSync = testDb();
  const memory = new MemoryStore({ db, now: () => NOW });
  let tid = 0;
  let mid = 0;
  const tasks = new TaskStore({ db, now: () => NOW, randomUUID: () => `tid-${(tid += 1)}` });
  const layers = new MemoryLayers(
    { db, now: () => NOW, randomUUID: () => `mid-${(mid += 1)}`, ledgerFor: (uid) => Ledger.open(db, uid), tasks },
    memory,
  );
  const addConversation = (uid: string, cid: string, title: string, msgs: [role: "user" | "assistant", text: string][]) => {
    db.prepare("INSERT INTO conversations (cid, uid, title, created_ts) VALUES (?, ?, ?, ?)").run(cid, uid, title, NOW);
    msgs.forEach(([role, text], i) => {
      db.prepare("INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, ?, ?, ?, ?)").run(
        cid,
        i,
        role === "user" ? "user/message" : "assistant/message",
        NOW + i,
        role,
        JSON.stringify({ message: { role, content: [{ type: "text", text }] } }),
      );
    });
  };
  const appendMessage = (cid: string, seq: number, role: "user" | "assistant", text: string) => {
    db.prepare("INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      cid,
      seq,
      role === "user" ? "user/message" : "assistant/message",
      NOW + seq,
      role,
      JSON.stringify({ message: { role, content: [{ type: "text", text }] } }),
    );
  };
  return { db, memory, tasks, layers, addConversation, appendMessage };
}

describe("L1 工作区镜像", () => {
  it("chat：会话=实体、指纹稳定；refresh 落 changes；增/改/删三态", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "睡前聊天", [["user", "最近睡得早"], ["assistant", "很好"]]);
    const live = await w.layers.l1Live("u1", "chat");
    expect(live).toHaveLength(1);
    expect(live[0]!.ref).toBe("chat:c1");
    expect(live[0]!.content).toContain("睡得早");

    expect(await w.layers.l1Pending("u1", "chat")).toEqual({ added: 1, modified: 0, removed: 0 });
    expect(await w.layers.l1Refresh("u1", "chat")).toEqual({ added: 1, modified: 0, removed: 0 });
    expect(w.layers.l1Changes("u1", "chat")).toHaveLength(1);
    // 幂等：无变化不记 changes
    expect(await w.layers.l1Refresh("u1", "chat")).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(w.layers.l1Changes("u1", "chat")).toHaveLength(1);

    w.appendMessage("c1", 2, "user", "又早睡了一天");
    expect(await w.layers.l1Pending("u1", "chat")).toEqual({ added: 0, modified: 1, removed: 0 });
    await w.layers.l1Refresh("u1", "chat");
    expect(w.layers.l1Changes("u1", "chat")[0]).toMatchObject({ kind: "modified", ref: "chat:c1" });

    w.db.prepare("DELETE FROM conversations WHERE cid = 'c1'").run();
    w.db.prepare("DELETE FROM conversation_events WHERE cid = 'c1'").run();
    expect(await w.layers.l1Pending("u1", "chat")).toEqual({ added: 0, modified: 0, removed: 1 });
    await w.layers.l1Refresh("u1", "chat");
    expect(w.layers.l1Changes("u1", "chat")[0]).toMatchObject({ kind: "removed" });
    expect(await w.layers.l1Live("u1", "chat")).toHaveLength(0);
  });

  it("ledger：流水/计划为实体，void 作废记录不进镜像", async () => {
    const w = makeWorld();
    const base = { uid: "u2", ts: NOW, source: "ui" as const };
    insertLedgerRecord(w.db, "u2", { ...base, seq: 0, kind: "event", time: NOW, category: "饮食", note: "午饭", value: 30, unit: "元" });
    insertLedgerRecord(w.db, "u2", { ...base, seq: 1, kind: "plan", planId: "p1", title: "早睡", scope: "day" });
    insertLedgerRecord(w.db, "u2", { ...base, seq: 2, kind: "void", targetSeq: 0, reason: "记错金额" });
    const live = await w.layers.l1Live("u2", "ledger");
    expect(live.map((e) => e.ref)).toEqual(["ledger:0", "ledger:1"]);
    expect(live[0]!.content).toContain("午饭");
  });

  it("tasks：任务实体带触发描述与启停", async () => {
    const w = makeWorld();
    await w.tasks.create("u3", { title: "睡觉提醒", instruction: "提醒用户睡觉", trigger: { kind: "daily", time: "23:00" } });
    const live = await w.layers.l1Live("u3", "tasks");
    expect(live).toHaveLength(1);
    expect(live[0]!.ref).toMatch(/^task:/);
    expect(live[0]!.content).toContain("每天 23:00");
    expect(live[0]!.content).toContain("启用");
  });
});

describe("L2 模块事实", () => {
  const FACTS = JSON.stringify({
    facts: [
      { text: "用户在调整作息，连续早睡", section: "话题", refs: ["chat:c1"] },
      { text: "非法 section 的事实", section: "不存在的", refs: ["chat:c1"] },
      { text: "引用未知实体的事实", section: "习惯", refs: ["chat:ghost"] },
      { text: "没有任何引用的事实", section: "习惯", refs: [] },
    ],
  });

  it("抽取：未知 section 就近落默认档、无引用/未知 ref 丢弃；门控推进；无新实体不再调模型", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "睡前聊天", [["user", "最近在调整作息"]]);
    await w.layers.l1Refresh("u1", "chat");
    const { adapter, requests } = createMockLlmAdapter([{ kind: "text", text: FACTS }]);
    const result = await w.layers.l2Update("u1", "chat", adapter, "mock-1");
    expect(result).toEqual({ added: 2 }); // 合法一条 + 未知 section 就近落「话题」；未知 ref 与空引用丢弃
    const entries = w.layers.l2Entries("u1", "chat");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.text).sort()).toEqual(["非法 section 的事实", "用户在调整作息，连续早睡"].sort());
    expect(entries.every((e) => e.section === "话题" && e.refs[0] === "chat:c1")).toBe(true);
    expect(requests[0]!.system).toContain("@chat:c1");
    expect(requests[0]!.system).toContain("话题");

    // 门控：同一实体不再重投喂（脚本耗尽 = 若调模型会抛错）
    const idle = createMockLlmAdapter([]);
    await expect(w.layers.l2Update("u1", "chat", idle.adapter, "mock-1")).resolves.toEqual({
      added: 0,
      skipped: "no_new_input",
    });
    // 新会话 → 增量抽取
    w.addConversation("u1", "c2", "健身", [["user", "开始跑步了"]]);
    const second = createMockLlmAdapter([
      { kind: "text", text: JSON.stringify({ facts: [{ text: "用户开始跑步", section: "习惯", refs: ["chat:c2"] }] }) },
    ]);
    await expect(w.layers.l2Update("u1", "chat", second.adapter, "mock-1")).resolves.toEqual({ added: 1 });
    expect(w.layers.l2Entries("u1", "chat")).toHaveLength(3);
  });

  it("全部事实无效（引用落空）→ 不推进门控，重试可重新投喂；reset 清门控", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "闲聊", [["user", "你好"]]);
    await w.layers.l1Refresh("u1", "chat");
    const allBad = createMockLlmAdapter([
      { kind: "text", text: JSON.stringify({ facts: [{ text: "引用全错", section: "话题", refs: ["chat:ghost"] }] }) },
    ]);
    await expect(w.layers.l2Update("u1", "chat", allBad.adapter, "mock-1")).resolves.toEqual({ added: 0, skipped: "no_valid_facts" });
    // 门控未推进 → 重试重新投喂（这次有效）
    const retry = createMockLlmAdapter([{ kind: "text", text: FACTS }]);
    await expect(w.layers.l2Update("u1", "chat", retry.adapter, "mock-1")).resolves.toEqual({ added: 2 });
    // reset 清门控 → 再次全量重喂
    w.layers.l2ResetGate("u1", "chat");
    const third = createMockLlmAdapter([{ kind: "text", text: JSON.stringify({ facts: [] }) }]);
    await expect(w.layers.l2Update("u1", "chat", third.adapter, "mock-1")).resolves.toEqual({ added: 0 });
  });

  it("坏输出 fail-safe：不落条目、不推进门控", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "闲聊", [["user", "你好"]]);
    await w.layers.l1Refresh("u1", "chat");
    const { adapter } = createMockLlmAdapter([{ kind: "text", text: "我偏不输出 JSON" }]);
    await expect(w.layers.l2Update("u1", "chat", adapter, "mock-1")).resolves.toEqual({ added: 0, skipped: "bad_output" });
    expect(w.layers.l2Entries("u1", "chat")).toHaveLength(0);
    // 门控未推进 → 修正后可重跑
    const retry = createMockLlmAdapter([{ kind: "text", text: FACTS }]);
    await expect(w.layers.l2Update("u1", "chat", retry.adapter, "mock-1")).resolves.toEqual({ added: 2 });
  });

  it("编辑/删除条目；非法 section 拒绝", async () => {
    const w = makeWorld();
    w.db
      .prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES ('u1','chat','m_1','话题','旧文本','[]',1)")
      .run();
    await w.layers.l2EditEntry("u1", "chat", "m_1", { text: "新文本", section: "习惯" });
    expect(w.layers.l2Entries("u1", "chat")[0]).toMatchObject({ text: "新文本", section: "习惯" });
    await expect(w.layers.l2EditEntry("u1", "chat", "m_1", { section: "胡写" })).rejects.toThrow();
    w.layers.l2RemoveEntry("u1", "chat", "m_1");
    expect(w.layers.l2Entries("u1", "chat")).toHaveLength(0);
    await expect(w.layers.l2EditEntry("u1", "chat", "m_x", { text: "x" })).rejects.toThrow();
  });
});

describe("L3 跨模块知识", () => {
  const seedL2 = (w: ReturnType<typeof makeWorld>) => {
    w.db
      .prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES ('u1','chat','m_a','话题','用户在调整作息','[\"chat:c1\"]',1)")
      .run();
    w.db
      .prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES ('u1','ledger','m_b','消费','外卖频率下降','[\"ledger:0\"]',2)")
      .run();
  };
  const MD = "用户作息在改善[^1]，外卖减少[^2]。\n\n[^1]: chat\n[^2]: ledger";

  it("综合：只吃 L2 新事实 → 写槽 + 脚注剥离注入；preferences 永不自动综合", async () => {
    const w = makeWorld();
    seedL2(w);
    const { adapter, requests } = createMockLlmAdapter([{ kind: "text", text: MD }]);
    await expect(w.layers.l3Update("u1", "recent", adapter, "mock-1")).resolves.toEqual({ changed: true });
    const slots = await w.memory.read("u1");
    expect(slots.recent).toContain("作息在改善");
    expect(requests[0]!.system).toContain("外卖频率下降");
    expect(requests[0]!.system).toContain("近期动态");
    // 注入剥脚注
    expect(w.memory.injectionBlockSync("u1")).toContain("作息在改善，外卖减少");
    expect(w.memory.injectionBlockSync("u1")).not.toContain("[^1]");
    // 门控：再次综合无新输入
    const idle = createMockLlmAdapter([]);
    await expect(w.layers.l3Update("u1", "recent", idle.adapter, "mock-1")).resolves.toEqual({
      changed: false,
      skipped: "no_new_input",
    });
    // preferences 不在自动综合槽里
    expect(L3_AUTO_SLOTS).not.toContain("preferences");
  });

  it("L2 有新事实但槽已消费过的不再重复进入综合输入", async () => {
    const w = makeWorld();
    seedL2(w);
    const first = createMockLlmAdapter([{ kind: "text", text: MD }]);
    await w.layers.l3Update("u1", "profile", first.adapter, "mock-1");
    // 新增一条 ledger 事实 → 只喂这一条
    w.db
      .prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES ('u1','ledger','m_c','饮食','开始自己做饭','[\"ledger:1\"]',3)")
      .run();
    const second = createMockLlmAdapter([
      { kind: "text", text: "开始自己做饭[^1]。\n\n[^1]: ledger" },
    ]);
    await w.layers.l3Update("u1", "profile", second.adapter, "mock-1");
    expect(second.requests[0]!.system).toContain("开始自己做饭");
    expect(second.requests[0]!.system).not.toContain("调整作息");
  });

  it("坏输出 fail-safe：不写槽", async () => {
    const w = makeWorld();
    seedL2(w);
    const { adapter } = createMockLlmAdapter([{ kind: "text", text: "  " }]);
    await expect(w.layers.l3Update("u1", "scope", adapter, "mock-1")).resolves.toEqual({ changed: false, skipped: "bad_output" });
    expect((await w.memory.read("u1")).scope).toBe("");
  });
});

describe("runAll 全链", () => {
  it("L1 refresh → L2 抽取 → L3 综合 串联；只有有新实体的 surface 调模型", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "睡前聊天", [["user", "最近在调整作息"]]);
    const facts = JSON.stringify({ facts: [{ text: "用户在调整作息", section: "话题", refs: ["chat:c1"] }] });
    const { adapter } = createMockLlmAdapter([
      { kind: "text", text: facts }, // L2 chat（ledger/tasks 无新实体不调）
      { kind: "text", text: "调整作息中[^1]。\n\n[^1]: chat" }, // L3 recent
      { kind: "text", text: "关注健康[^1]。\n\n[^1]: chat" }, // L3 profile
      { kind: "text", text: "主线：改善作息[^1]。\n\n[^1]: chat" }, // L3 scope
    ]);
    const result = await w.layers.runAll("u1", adapter, "mock-1");
    expect(result.l1.chat).toEqual({ added: 1, modified: 0, removed: 0 });
    expect(result.l1.ledger).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(result.l2.chat).toEqual({ added: 1 });
    expect(result.l2.ledger).toEqual({ added: 0, skipped: "no_new_input" });
    expect(result.l3.recent).toEqual({ changed: true });
    expect(result.l3.scope).toEqual({ changed: true });
    expect((await w.memory.read("u1")).recent).toContain("调整作息中");
    // 幂等二跑：全链无动作且不消耗脚本（脚本已空）
    const idle = createMockLlmAdapter([]);
    const again = await w.layers.runAll("u1", idle.adapter, "mock-1");
    expect(again.l2.chat.skipped).toBe("no_new_input");
    expect(again.l3.recent.skipped).toBe("no_new_input");
  });
});

describe("门控键 = ref#fingerprint（修正语义）", () => {
  it("同一会话追加消息 → 指纹变化 → 视为新输入重喂", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "长会话", [["user", "开始跑步"]]);
    await w.layers.l1Refresh("u1", "chat");
    const first = createMockLlmAdapter([{ kind: "text", text: JSON.stringify({ facts: [{ text: "用户开始跑步", section: "习惯", refs: ["chat:c1"] }] }) }]);
    await expect(w.layers.l2Update("u1", "chat", first.adapter, "mock-1")).resolves.toEqual({ added: 1 });
    // 无变化 → 不重喂
    const idle = createMockLlmAdapter([]);
    await expect(w.layers.l2Update("u1", "chat", idle.adapter, "mock-1")).resolves.toMatchObject({ skipped: "no_new_input" });
    // 追加消息 → 指纹变化 → 重喂
    w.appendMessage("c1", 1, "assistant", "跑了三公里");
    const second = createMockLlmAdapter([{ kind: "text", text: JSON.stringify({ facts: [{ text: "用户跑量三公里", section: "习惯", refs: ["chat:c1"] }] }) }]);
    await expect(w.layers.l2Update("u1", "chat", second.adapter, "mock-1")).resolves.toEqual({ added: 1 });
    expect(w.layers.l2Entries("u1", "chat")).toHaveLength(2);
  });
});

describe("runAll 失败隔离（P1#4）", () => {
  it("chat L2 抛错 → 记 error 不阻塞 ledger/L3；L3 抛错同理", async () => {
    const w = makeWorld();
    w.addConversation("u1", "c1", "睡前聊天", [["user", "在调整作息"]]);
    const facts = JSON.stringify({ facts: [{ text: "在调整作息", section: "话题", refs: ["chat:c1"] }] });
    const failing = createMockLlmAdapter([
      { kind: "failure", failure: { code: "PROVIDER_ERROR", message: "boom" } as never }, // L2 chat 抛错
    ]);
    await expect(w.layers.runAll("u1", failing.adapter, "mock-1")).resolves.toMatchObject({
      l2: { chat: { added: 0, skipped: "error" }, ledger: { skipped: "no_new_input" } },
    });
    // L2 失败不推进门控 → 重跑仍可抽取
    const recover = createMockLlmAdapter([
      { kind: "text", text: facts }, // L2 chat
      { kind: "failure", failure: { code: "PROVIDER_ERROR", message: "boom" } as never }, // L3 recent 抛错
      { kind: "text", text: "画像[^1]。\n\n[^1]: chat" }, // L3 profile
      { kind: "text", text: "主线[^1]。\n\n[^1]: chat" }, // L3 scope
    ]);
    const result = await w.layers.runAll("u1", recover.adapter, "mock-1");
    expect(result.l2.chat).toEqual({ added: 1 });
    expect(result.l3.recent).toEqual({ changed: false, skipped: "error" });
    expect(result.l3.profile).toEqual({ changed: true });
    expect(result.l3.scope).toEqual({ changed: true });
  });
});

describe("parseFactsJson", () => {
  it("容忍代码围栏；垃圾输出返回 null", () => {
    const fenced = "```json\n{\"facts\":[{\"text\":\"a\",\"section\":\"话题\",\"refs\":[\"chat:c1\"]}]}\n```";
    expect(parseFactsJson(fenced)).toEqual([{ text: "a", section: "话题", refs: ["chat:c1"] }]);
    expect(parseFactsJson("没有 JSON")).toBeNull();
    expect(parseFactsJson("{\"facts\":\"不是数组\"}")).toBeNull();
  });
});
