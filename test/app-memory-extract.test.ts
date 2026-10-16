// 记忆提取管线（2026-09-10 WeKnora 化重构 Spec §6.3）：三 surface 新输入检测（chat 切段/ledger 水位线含 void/tasks 指纹）、
// 决策制提取（add/update/delete 落库、坏输出推进不卡死、模型失败不推进）、调度状态机（去抖/在飞/最小间隔）、
// consolidate、一次性迁移。零网络：mock adapter 全脚本化，时钟注入固定值。

import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/app/memory";
import {
  MemoryExtractor,
  migrateLegacyMemory,
  nightlyDue,
  parseDecisionsJson,
  parseExpiry,
  type ExtractSummary,
} from "../src/app/memory-extract";
import { createMockLlmAdapter, llmFailure, type MockScriptStep } from "../src/harness/index";
import type { LlmRequest } from "../src/harness/index";
import { testDb } from "./helpers-db";

let clock = 100_000;
let uidSeq = 0;
function makeStore(db: DatabaseSync): MemoryStore {
  return new MemoryStore({ db, now: () => clock, randomUUID: () => `x${(uidSeq += 1)}` });
}

function seedChat(db: DatabaseSync, uid: string, cid: string, msgs: { role: string; text: string; ts?: number; eid?: number }[]): void {
  db.prepare("INSERT OR IGNORE INTO conversations (cid, uid, title, created_ts) VALUES (?, ?, '测试会话', 1)").run(cid, uid);
  let seq = 0;
  let eid = 0;
  for (const m of msgs) {
    seq += 1;
    eid = m.eid ?? eid + 1;
    db.prepare("INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      cid,
      seq,
      `${m.role}/message`,
      m.ts ?? 1000,
      m.role,
      JSON.stringify({ message: { role: m.role, content: [{ type: "text", text: m.text }] } }),
    );
  }
}

describe("解析与纯函数", () => {
  it("parseDecisionsJson：容忍围栏/杂文；坏 JSON 返回 null", () => {
    expect(parseDecisionsJson('```json\n{"memories":[{"action":"add"}]}\n```')?.memories.length).toBe(1);
    expect(parseDecisionsJson("前置说明 {\"memories\":[]} 后置")?.memories.length).toBe(0);
    expect(parseDecisionsJson("完全没有 JSON")).toBeNull();
  });

  it("parseExpiry：合法将来日期 → ts；过去/非法/null → undefined", () => {
    expect(parseExpiry("2099-01-01")).toBeGreaterThan(0);
    expect(parseExpiry("2000-01-01")).toBeUndefined();
    expect(parseExpiry(null)).toBeUndefined();
    expect(parseExpiry("下周")).toBeUndefined();
  });

  it("nightlyDue：2–5 点窗口 + 20h 门槛（tz 注入保确定性）", () => {
    const at = (h: number) => Date.UTC(2026, 8, 10, h, 0, 0); // UTC 时刻
    expect(nightlyDue(undefined, at(3), 0)).toBe(true); // 窗口内且从未跑过
    expect(nightlyDue(undefined, at(6), 0)).toBe(false); // 窗口外
    expect(nightlyDue(at(3) - 19 * 3600_000, at(3), 0)).toBe(false); // 距上次 <20h
    expect(nightlyDue(at(3) - 21 * 3600_000, at(3), 0)).toBe(true);
  });
});

describe("extractOnce：三 surface 检测 + 决策落库", () => {
  it("chat 段：决策 add 落库 + 水位线推进；第二次提取 no_new_input", async () => {
    const db = testDb();
    const memory = makeStore(db);
    seedChat(db, "u1", "c1", [
      { role: "user", text: "我在一家做医疗影像的公司写后端", ts: 1000 },
      { role: "assistant", text: "了解了", ts: 1001 },
    ]);
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: async () => ({
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: '{"memories":[{"action":"add","target":null,"kind":"profile","topic":"职业","content":"在医疗影像公司做后端","importance":4,"source":1,"expires_at":null}]}' }],
          },
          finishReason: "stop" as string,
        }),
      },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.added).toBe(1);
    expect(summary.skipped).toBeUndefined();
    const cursor = memory.metaRow("u1").extractCursor;
    expect(cursor).toBeGreaterThan(0);
    const items = memory.listItems("u1", { kind: "profile" });
    expect(items[0]?.content).toBe("在医疗影像公司做后端");
    expect(items[0]?.sourceRef).toContain("chat:c1#");

    // 第二次：无新输入
    const again = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(again.skipped).toBe("no_new_input");
  });

  it("提醒投递会话（feed:/task:）不进 chat 提取面：任务上下文不当成用户发言", async () => {
    const db = testDb();
    const memory = makeStore(db);
    seedChat(db, "u1", "feed:default", [
      { role: "user", text: "【定时任务触发】工作提醒\n任务内容：提醒我工作辛苦了", ts: 1000 },
      { role: "assistant", text: "辛苦了，记得歇一会儿", ts: 1001 },
    ]);
    seedChat(db, "u1", "task:tid-9", [{ role: "user", text: "任务专属会话的指令", ts: 1002 }]);
    const prompts: string[] = [];
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: async (req: LlmRequest) => {
          prompts.push(JSON.stringify(req.messages));
          return {
            message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[],"topics":[]}' }] },
            finishReason: "stop" as string,
          };
        },
      },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.skipped).toBe("no_new_input");
    expect(prompts).toHaveLength(0);
  });

  it("决策 update：target 索引有效 → 旧条 superseded、新条 active", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const created = memory.insertItem("u1", { kind: "fact", content: "生产库用的是 MySQL", topic: "数据库", origin: "extracted", importance: 4 });
    seedChat(db, "u1", "c1", [{ role: "user", text: "我们上周把生产库迁到 PostgreSQL 了", ts: 1000 }]);
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: async (req: LlmRequest) => ({
          message: {
            role: "assistant" as const,
            content: [
              {
                type: "text" as const,
                text: `{"memories":[{"action":"update","target":0,"kind":"fact","topic":"数据库","content":"生产库已从 MySQL 迁到 PostgreSQL","importance":4,"source":1,"expires_at":null}]}`,
              },
            ],
          },
          finishReason: "stop" as string,
        }),
      },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.updated).toBe(1);
    expect(memory.getItem("u1", created.item!.id)?.status).toBe("superseded");
    expect(memory.listItems("u1", { status: "active", kind: "fact" })[0]?.content).toContain("PostgreSQL");
  });

  it("update 决策内容与旧条相同 → 无操作（旧条不得被自己取代而失效）", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const created = memory.insertItem("u1", { kind: "fact", content: "生产库用的是 MySQL", topic: "数据库", origin: "extracted", importance: 4 });
    seedChat(db, "u1", "c1", [{ role: "user", text: "生产库还是 MySQL 没变", ts: 1000 }]);
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: async () => ({
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: '{"memories":[{"action":"update","target":0,"kind":"fact","topic":"数据库","content":"生产库用的是 MySQL","importance":4,"source":1,"expires_at":null}]}' }],
          },
          finishReason: "stop" as string,
        }),
      },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.updated).toBe(0);
    expect(summary.added).toBe(0);
    const item = memory.getItem("u1", created.item!.id);
    expect(item?.status).toBe("active"); // 不被自取代
    expect(memory.listItems("u1").length).toBe(1); // 也没有多余新条
  });

  it("模型调用失败 → 水位线不动（消息不丢，下次重读）", async () => {
    const db = testDb();
    const memory = makeStore(db);
    seedChat(db, "u1", "c1", [{ role: "user", text: "重要的事", ts: 1000 }]);
    const mock = createMockLlmAdapter([{ kind: "failure", failure: llmFailure("RATE_LIMIT", "mock 限流") }, { kind: "failure", failure: llmFailure("RATE_LIMIT", "mock 限流") }]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.skipped).toBe("model_error");
    expect(memory.metaRow("u1").extractCursor).toBeUndefined();
  });

  it("不可解析输出 → 视为无操作并推进（坏模型不能永久卡死）", async () => {
    const db = testDb();
    const memory = makeStore(db);
    seedChat(db, "u1", "c1", [{ role: "user", text: "随便聊聊", ts: 1000 }]);
    const mock = createMockLlmAdapter([
      { kind: "text", text: "这不是 JSON" },
      { kind: "text", text: "重试也不是 {坏了" },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.added).toBe(0);
    expect(memory.metaRow("u1").extractCursor).toBeGreaterThan(0); // 推进了
    expect(memory.listItems("u1").length).toBe(0); // 但什么也没写
  });

  it("ledger 段：seq 水位线（含 void 行渲染）；tasks 段：指纹变化触发", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const ins = db.prepare(
      "INSERT INTO ledger_entries (uid, seq, kind, ts, source, category, note, value, unit, time) VALUES (?, ?, ?, ?, 'ui', ?, ?, ?, ?, ?)",
    );
    ins.run("u1", 0, "event", 999, "餐饮", "早餐", 12, "¥", 999); // 首笔 seq=0：水位线起点必须包含（cursor??0 会永久漏掉它）
    ins.run("u1", 1, "event", 1000, "餐饮", "午餐", 28, "¥", 1000);
    ins.run("u1", 2, "event", 1001, "餐饮", "晚餐", 35, "¥", 1001);
    db.prepare("INSERT INTO tasks (id, uid, title, instruction, trigger_json, enabled, tz_offset_minutes, created_ts) VALUES ('t1', 'u1', '喝水提醒', '提醒我喝水', '{}', 1, 0, 1)").run();

    const requests: LlmRequest[] = [];
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async (req) => { requests.push(req); return { message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[]}' }] }, finishReason: "stop" as string }; } },
      { kind: "fn", fn: async (req) => { requests.push(req); return { message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[]}' }] }, finishReason: "stop" as string }; } },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.segments).toBeGreaterThanOrEqual(2); // ledger + tasks
    const ledgerPrompt = requests[0] ? [requests[0]!.system, JSON.stringify(requests[0]!.messages)].join("\n") : "";
    expect(ledgerPrompt).toContain("午餐");
    expect(ledgerPrompt).toContain("生活账本");
    expect(memory.metaRow("u1").ledgerCursor).toBe(2);
    expect(memory.metaRow("u1").tasksFingerprint).toBeDefined();

    // void 行也要渲染（作废是记忆事件）
    db.prepare("INSERT INTO ledger_entries (uid, seq, kind, ts, source, target_seq, reason) VALUES ('u1', 3, 'void', 1002, 'ui', 0, '记错了')").run();
    requests.length = 0;
    const mock2 = createMockLlmAdapter([
      { kind: "fn", fn: async (req) => { requests.push(req); return { message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[]}' }] }, finishReason: "stop" as string }; } },
    ]);
    const extractor2 = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock2.adapter, model: "m" }) });
    await extractor2.extractOnce("u1", mock2.adapter, "m");
    const voidPrompt = requests[0] ? JSON.stringify(requests[0]!.messages) : "";
    expect(voidPrompt).toContain("作废");
  });

  it("墓碑主题进提取 prompt", async () => {
    const db = testDb();
    const memory = makeStore(db);
    memory.insertItem("u1", { kind: "fact", content: "旧事", topic: "旧主题", origin: "extracted" });
    memory.deleteItem("u1", memory.listItems("u1")[0]!.id);
    seedChat(db, "u1", "c1", [{ role: "user", text: "新话题", ts: 1000 }]);
    const requests: LlmRequest[] = [];
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async (req) => { requests.push(req); return { message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[]}' }] }, finishReason: "stop" as string }; } },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    await extractor.extractOnce("u1", mock.adapter, "m");
    expect(JSON.stringify(requests[0]!.messages)).toContain("旧主题");
  });
});

describe("调度状态机", () => {
  function setup() {
    const db = testDb();
    const memory = makeStore(db);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => null });
    return { db, memory, extractor };
  }

  it("notify 去抖：90s 内连续登记合并（保持最早计划）；到期 dueUids 命中", () => {
    const { memory, extractor } = setup();
    clock = 100_000;
    extractor.notify("u1");
    expect(memory.metaRow("u1").scheduledTs).toBe(100_000 + 90_000);
    clock = 100_000 + 30_000;
    extractor.notify("u1"); // 已计划且在未来 → 不推迟
    expect(memory.metaRow("u1").scheduledTs).toBe(190_000);
    expect(extractor.dueUids(["u1"], 150_000)).toEqual([]);
    expect(extractor.dueUids(["u1"], 190_000)).toEqual(["u1"]);
  });

  it("最小间隔：距上次提取 <5min → 推迟到间隔边界（只推迟不丢弃）", () => {
    const { memory, extractor } = setup();
    clock = 100_000;
    extractor.notify("u1");
    memory.patchMeta("u1", { lastExtractTs: 100_000 }); // 刚提取过
    clock = 100_000 + 60_000;
    memory.patchMeta("u1", { scheduledTs: null });
    extractor.notify("u1");
    expect(memory.metaRow("u1").scheduledTs).toBe(100_000 + 300_000); // 5min 边界
  });

  it("在飞：未超时不 due；超时判死 due（进程重启恢复语义）", () => {
    const { memory, extractor } = setup();
    memory.patchMeta("u1", {});
    const ensure = memory.metaRow.bind(memory);
    extractor.notify("u1");
    clock = 200_000; // 到期
    memory.patchMeta("u1", { inFlightSince: 199_000 });
    expect(extractor.dueUids(["u1"], clock)).toEqual([]); // 在飞未超时
    clock = 200_000 + 600_000 + 1;
    expect(extractor.dueUids(["u1"], clock)).toEqual(["u1"]); // 超时判死
    void ensure;
  });

  it("runDue：无模型 → busy + 5min 重推 + 在飞释放", async () => {
    const { memory, extractor } = setup();
    clock = 100_000;
    extractor.notify("u1");
    clock = 190_000;
    const summary: ExtractSummary = await extractor.runDue("u1");
    expect(summary.skipped).toBe("busy");
    expect(memory.metaRow("u1").scheduledTs).toBe(clock + 300_000);
    expect(memory.metaRow("u1").inFlightSince).toBeUndefined(); // null 清列后可选字段不出现
  });
});

describe("consolidate", () => {
  it("条目过少 → too_few_items；限速 → too_soon", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const mock = createMockLlmAdapter([]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    memory.insertItem("u1", { kind: "fact", content: "只有一条", origin: "extracted" });
    const r = await extractor.consolidate("u1", mock.adapter, "m");
    expect(r.skipped).toBe("too_few_items");
    // 手动连续两次 → 第二次 too_soon（1 分钟限速）
    await extractor.consolidate("u1", mock.adapter, "m", true);
    const forced = await extractor.consolidate("u1", mock.adapter, "m", true);
    expect(forced.skipped).toBe("too_soon");
  });

  it("近重复合并：词重叠组 → LLM 裁决合并为一条，旧条 superseded", async () => {
    const db = testDb();
    const memory = makeStore(db);
    memory.insertItem("u1", { kind: "preference", content: "喜欢简洁的回复风格", topic: "回复风格", origin: "extracted" });
    memory.insertItem("u1", { kind: "preference", content: "偏好简洁的回复", topic: "回答风格", origin: "extracted" }); // 不同 topic 避免同键取代
    const mock = createMockLlmAdapter([
      { kind: "fn", fn: async () => ({ message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"merged":"偏好简洁的回复风格"}' }] }, finishReason: "stop" as string }) },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    // 造满 6 条触发整理（两条近似 + 四条其他）
    for (const t of ["事实A", "事实B", "事实C", "事实D"]) memory.insertItem("u1", { kind: "fact", content: t, origin: "extracted" });
    const result = await extractor.consolidate("u1", mock.adapter, "m", true);
    expect(result.merged).toBe(1);
    expect(memory.listItems("u1", { status: "active", kind: "preference" }).length).toBe(1);
  });
});

describe("migrateLegacyMemory", () => {
  it("l2/槽 → 条目；水位线初始化=现状；幂等", () => {
    const db = testDb();
    // 模拟 schema v1 老库（DDL 已不再建这两张表，2026-10-01 删）
    db.exec("CREATE TABLE l2_entries (uid TEXT NOT NULL, surface TEXT NOT NULL, id TEXT NOT NULL, section TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '[]', created_ts INTEGER NOT NULL, updated_ts INTEGER, PRIMARY KEY (uid, surface, id))");
    db.exec("CREATE TABLE memory_slots (uid TEXT NOT NULL, slot TEXT NOT NULL, content_md TEXT NOT NULL DEFAULT '', updated_ts INTEGER, PRIMARY KEY (uid, slot))");
    db.prepare("INSERT INTO conversations (cid, uid, title, created_ts) VALUES ('c1', 'u1', '旧会话', 1)").run();
    db.prepare("INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES ('c1', 0, 'user/message', 1, 'user', ?)").run(
      JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "历史消息" }] } }),
    );
    db.prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES ('u1', 'chat', 'old1', '话题', '用户在测试旧链', '[\"chat:c1\"]', 100)").run();
    db.prepare("INSERT INTO memory_slots (uid, slot, content_md, updated_ts) VALUES ('u1', 'profile', '旧画像工程师[^1]。\\n\\n[^1]: chat', 200)").run();
    migrateLegacyMemory(db, { now: () => 1000, randomUUID: () => "r1" });

    const memory = makeStore(db);
    const facts = memory.listItems("u1", { kind: "fact" });
    expect(facts.length).toBe(1);
    expect(facts[0]?.content).toBe("用户在测试旧链");
    expect(facts[0]?.sourceRef).toBe("chat:c1");
    const profile = memory.listItems("u1", { kind: "profile" });
    expect(profile[0]?.origin).toBe("manual"); // 槽迁移 → 手编免疫
    expect(profile[0]?.content).toContain("旧画像工程师"); // 脚注被剥

    const meta = memory.metaRow("u1");
    expect(meta.extractCursor).toBeGreaterThan(0); // = 现状（历史不重喂）
    expect(meta.ledgerCursor).toBeUndefined(); // 空账本存 NULL：不压住未来的 seq=0 首笔

    // 幂等：重跑不重复
    migrateLegacyMemory(db, { now: () => 2000, randomUUID: () => "r2" });
    expect(memory.listItems("u1", { kind: "fact" }).length).toBe(1);
  });

  it("无旧表的新库：不抛，直接落标记（schema v2 起不再建旧表）", () => {
    const db = testDb();
    expect(() => migrateLegacyMemory(db, { now: () => 1000, randomUUID: () => "r1" })).not.toThrow();
    const flag = db.prepare("SELECT value FROM meta WHERE key = 'memory_v2_migrated'").get() as { value: string } | undefined;
    expect(flag?.value).toBe("1000");
    // 重跑：标记已存在，直接返回
    expect(() => migrateLegacyMemory(db, { now: () => 2000, randomUUID: () => "r2" })).not.toThrow();
  });
});

// ── 主题计数与语义候选（2026-09-18 Spec §4.3 checklist 5、14） ──────────

describe("主题计数与语义候选（2026-09-18）", () => {
  it("parseDecisionsJson：topics 数组提取；缺失/非数组 → undefined", () => {
    const withTopics = parseDecisionsJson('{"memories":[],"topics":["健身","饮食"]}');
    expect(withTopics?.topics).toEqual(["健身", "饮食"]);
    expect(parseDecisionsJson('{"memories":[]}')?.topics).toBeUndefined();
    expect(parseDecisionsJson('{"memories":[],"topics":"健身"}')?.topics).toBeUndefined();
  });

  it("提取输出 topics → 计数 → 第三次达标自动晋升 interest", async () => {
    const db = testDb();
    const memory = makeStore(db);
    seedChat(db, "u1", "c1", [{ role: "user", text: "最近在弄门店排班管理", ts: 1000 }]);
    let call = 0;
    const output = (): string => ['{"memories":[],"topics":["门店排班管理"]}', '{"memories":[],"topics":["店排班管理"]}', '{"memories":[],"topics":[" 门店排班管理 "]}'][Math.min(call, 2)]!;
    const step = (): MockScriptStep => ({
      kind: "fn",
      fn: async () => ({
        message: { role: "assistant" as const, content: [{ type: "text" as const, text: output() }] },
        finishReason: "stop" as string,
      }),
    });
    const mock = createMockLlmAdapter([step(), step(), step()]);
    const embedded: string[] = [];
    const extractor = new MemoryExtractor({
      db,
      now: () => clock,
      memory,
      adapterFor: async () => ({ adapter: mock.adapter, model: "m" }),
      embedNewItems: async (_uid, items) => {
        embedded.push(...items.map((i) => i.content));
      },
    });

    const s1 = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(s1.interestsPromoted).toBeUndefined();
    call = 1;
    seedChat(db, "u1", "c2", [{ role: "user", text: "班次又要重排了", ts: 2000 }]);
    const s2 = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(s2.interestsPromoted).toBeUndefined();
    call = 2;
    seedChat(db, "u1", "c3", [{ role: "user", text: "排班工具选型中", ts: 3000 }]);
    const s3 = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(s3.interestsPromoted).toBe(1);
    const interests = memory.listItems("u1", { kind: "interest" });
    expect(interests.length).toBe(1);
    expect(interests[0]?.content).toBe("门店排班管理");
    expect(embedded).toEqual(["门店排班管理"]); // 晋升条目写入即嵌入，不等回填
  });

  it("vectorCandidates：旧条目超限时以语义候选替换；返回 null 退回词法前缀", async () => {
    const db = testDb();
    const memory = makeStore(db);
    for (let i = 0; i < 20; i++) {
      memory.insertItem("u1", { kind: "fact", content: `填充条目内容编号 ${i} 号`, topic: `填充主题${i}`, origin: "extracted" });
    }
    const target = memory.insertItem("u1", { kind: "fact", content: "用户正在减脂控制饮食", topic: "身体状况", origin: "extracted" });
    seedChat(db, "u1", "c1", [{ role: "user", text: "帮我看看这周吃了什么", ts: 1000 }]);
    let capturedPrompt = "";
    const captureStep: MockScriptStep = {
      kind: "fn",
      fn: async (req: LlmRequest) => {
        capturedPrompt = req.messages[0]!.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
        return { message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[],"topics":[]}' }] }, finishReason: "stop" as string };
      },
    };
    const mock = createMockLlmAdapter([captureStep, captureStep]);
    const extractor = new MemoryExtractor({
      db,
      now: () => clock,
      memory,
      adapterFor: async () => ({ adapter: mock.adapter, model: "m" }),
      vectorCandidates: async () => [target.item!],
    });
    await extractor.extractOnce("u1", mock.adapter, "m");
    expect(capturedPrompt).toContain("用户正在减脂控制饮食");
    expect(capturedPrompt).not.toContain("填充条目内容编号 5");

    // null → 词法前缀兜底（填充条目进入候选）
    const extractor2 = new MemoryExtractor({
      db,
      now: () => clock,
      memory,
      adapterFor: async () => ({ adapter: mock.adapter, model: "m" }),
      vectorCandidates: async () => null,
    });
    seedChat(db, "u1", "c2", [{ role: "user", text: "再看看这周吃了什么", ts: 2000 }]);
    await extractor2.extractOnce("u1", mock.adapter, "m");
    expect(capturedPrompt).toContain("填充条目内容编号");
  });

  it("embedNewItems 挂点：决策新增的条目回调给向量写入", async () => {
    const db = testDb();
    const memory = makeStore(db);
    seedChat(db, "u1", "c1", [{ role: "user", text: "我在学钢琴", ts: 1000 }]);
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: async () => ({
          message: { role: "assistant" as const, content: [{ type: "text" as const, text: '{"memories":[{"action":"add","target":null,"kind":"fact","topic":"爱好","content":"用户在学钢琴","importance":3,"source":1,"expires_at":null}],"topics":["乐器学习"]}' }] },
          finishReason: "stop" as string,
        }),
      },
    ]);
    const embedded: string[] = [];
    const extractor = new MemoryExtractor({
      db,
      now: () => clock,
      memory,
      adapterFor: async () => ({ adapter: mock.adapter, model: "m" }),
      embedNewItems: async (_uid, items) => {
        embedded.push(...items.map((i) => i.content));
      },
    });
    const summary = await extractor.extractOnce("u1", mock.adapter, "m");
    expect(summary.added).toBe(1);
    expect(embedded).toEqual(["用户在学钢琴"]);
  });

  it("interest 常驻锚点对提取候选不可见且免疫 update/delete 取代（2026-09-18 E2E 回归）", async () => {
    const db = testDb();
    const memory = makeStore(db);
    memory.insertItem("u1", { kind: "interest", content: "门店排班管理", topic: "门店排班管理", origin: "extracted" });
    const f1 = memory.insertItem("u1", { kind: "fact", content: "用户偏好靠窗座位", topic: "出行", origin: "extracted" });
    const f2 = memory.insertItem("u1", { kind: "fact", content: "用户对花生过敏", topic: "饮食", origin: "extracted" });
    seedChat(db, "u1", "c1", [{ role: "user", text: "聊聊出行和饮食吧", ts: 1000 }]);
    let capturedPrompt = "";
    const mock = createMockLlmAdapter([
      {
        kind: "fn",
        fn: async (req: LlmRequest) => {
          capturedPrompt = req.messages[0]!.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
          return {
            message: {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: '{"memories":[{"action":"update","target":0,"kind":"fact","topic":"出行","content":"用户坐高铁只买靠窗座位","importance":3,"source":1,"expires_at":null},{"action":"delete","target":1}]}' }],
            },
            finishReason: "stop" as string,
          };
        },
      },
    ]);
    const extractor = new MemoryExtractor({ db, now: () => clock, memory, adapterFor: async () => ({ adapter: mock.adapter, model: "m" }) });
    await extractor.extractOnce("u1", mock.adapter, "m");
    expect(capturedPrompt).toContain("用户偏好靠窗座位"); // 非 interest 条目照常进候选
    expect(capturedPrompt).not.toContain("门店排班管理"); // interest 对模型不可见
    expect(memory.getItem("u1", f1.item!.id)!.status).toBe("superseded"); // update 照常取代
    expect(memory.getItem("u1", f2.item!.id)!.status).toBe("superseded"); // delete 照常取代
    const interest = memory.listItems("u1", { kind: "interest" });
    expect(interest).toHaveLength(1);
    expect(interest[0]!.status).toBe("active");
    expect(interest[0]!.supersededBy).toBeUndefined();
  });
});
