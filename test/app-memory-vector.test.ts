// 向量召回（2026-09-18 Spec §4.3 checklist 8–11）：小端 float32 编解码往返、余弦、embeddableText、
// 查询向量缓存（铁律 2 确定性）、recallHits 语义命中与降级（未配置/超时/维度/指纹）、embedNewItems、
// backfill 限速与失败即停。零网络：embed 用确定性注入函数，超时用注入 sleep。

import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createMockLlmAdapter } from "../src/harness/index";
import { MemoryStore, fuseRankings } from "../src/app/memory";
import { BACKFILL_PER_RUN, cosine, createMemoryVector, decodeVector, embeddableText, encodeVector, vectorModelTag } from "../src/app/memory-vector";
import { testDb } from "./helpers-db";

let clock = 100_000;
const now = () => (clock += 1);
let uidSeq = 0;
const makeStore = (db: DatabaseSync): MemoryStore => new MemoryStore({ db, now, randomUUID: () => `x${(uidSeq += 1)}` });

/** 确定性 embed：按关键词给固定 4 维向量（同词同向量、异词正交） */
function keywordEmbed(text: string): number[] {
  if (text.includes("减脂") || text.includes("胖")) return [1, 0, 0, 0];
  if (text.includes("游泳")) return [0, 1, 0, 0];
  return [0, 0, 1, 0];
}

function makeVector(db: DatabaseSync, opts?: { sleepImmediate?: boolean; log?: (line: string) => void }) {
  let current: { adapter: ReturnType<typeof createMockLlmAdapter>["adapter"]; model: string; providerId: string } | null = null;
  const sleep = opts?.sleepImmediate ? async () => {} : undefined;
  const service = createMemoryVector({
    db,
    now,
    embeddingFor: async () => current,
    ...(opts?.log ? { log: opts.log } : {}),
    ...(sleep ? { sleep } : {}),
  });
  return {
    service,
    set(embed: (text: string) => number[] = keywordEmbed) {
      const mock = createMockLlmAdapter([], async (req) => embed(req.input));
      current = { adapter: mock.adapter, model: "embed-v1", providerId: "prov1" };
      return mock;
    },
    clear() {
      current = null;
    },
  };
}

describe("编解码与纯函数", () => {
  it("encode/decode：小端 float32 往返（可精确表示的值零损耗）", () => {
    const v = [0.25, 1.5, -2.75, 0, 1024];
    const bytes = encodeVector(v);
    expect(bytes.length).toBe(20);
    expect(decodeVector(bytes)).toEqual(v);
    expect(decodeVector(bytes.buffer as ArrayBuffer)).toEqual(v);
  });

  it("decodeVector：长度非 4 的倍数就地抛错", () => {
    expect(() => decodeVector(new Uint8Array(5))).toThrow();
  });

  it("cosine：同向=1、正交=0、维度不一致就地抛错", () => {
    expect(cosine([1, 0], [2, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow();
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it("embeddableText：主题：内容拼接；同名退化为单段", () => {
    expect(embeddableText({ topic: "在用的数据库", content: "生产库是 MySQL" })).toBe("在用的数据库：生产库是 MySQL");
    expect(embeddableText({ topic: "游泳", content: "游泳" })).toBe("游泳");
    expect(embeddableText({ topic: "", content: "只有内容" })).toBe("只有内容");
  });

  it("vectorModelTag：提供方或模型名任一变更即新标识", () => {
    expect(vectorModelTag("p1", "m1")).toBe("p1:m1");
    expect(vectorModelTag("p1", "m2")).not.toBe(vectorModelTag("p1", "m1"));
  });

  it("fuseRankings：两路都认可排最前、单路按名次、RRF 分数定序", () => {
    // a=1/60, b=1/61+1/60, c=1/62, d=1/61 → b > a > d > c
    expect(fuseRankings(["a", "b", "c"], ["b", "d"])).toEqual(["b", "a", "d", "c"]);
    expect(fuseRankings(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("recallHits：语义命中与降级", () => {
  it("同义改写命中：词法零重合的条目被向量捞回；注入块融合后包含它", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const fat = memory.insertItem("u1", { kind: "fact", content: "用户在减脂", topic: "身体状况", origin: "extracted" });
    memory.insertItem("u1", { kind: "fact", content: "用户每周三次游泳", topic: "运动习惯", origin: "extracted" });
    const v = makeVector(db);
    const mock = v.set();
    await v.service.embedNewItems("u1", memory.listItems("u1", { status: "active" }));

    // 问句与两条记忆字面零重合（"最近胖了怎么办" 不含任何条目用字）
    const hits = await v.service.recallHits("u1", "最近胖了怎么办", { scope: "situational" });
    expect(hits).not.toBeNull();
    expect(hits?.map((h) => h.id)).toEqual([fat.item!.id]); // 胖→[1,0,0,0] 与减脂条目同向、与游泳正交

    // 注入融合：无命中（null）→ 纯词法，零重合 → 情境段为空
    const lexicalOnly = memory.recallBlockSync("u1", "最近胖了怎么办");
    expect(lexicalOnly).not.toContain("减脂");
    // 有命中 → RRF 融合把语义条目拉进情境段
    const fused = memory.recallBlockSync("u1", "最近胖了怎么办", hits ?? undefined);
    expect(fused).toContain("减脂");
    expect(mock.embedRequests.length).toBeGreaterThanOrEqual(1);
  });

  it("查询向量缓存：同文本第二次不再调用 embedding（铁律 2 确定性 + 省调用）", async () => {
    const db = testDb();
    const v = makeVector(db);
    const mock = v.set();
    const first = await v.service.recallHits("u1", "最近胖了怎么办", { scope: "all" });
    const callsAfterFirst = mock.embedRequests.length;
    const second = await v.service.recallHits("u1", "最近胖了怎么办", { scope: "all" });
    expect(first).toEqual(second);
    expect(mock.embedRequests.length).toBe(callsAfterFirst);
    // 不同文本才会再调
    await v.service.recallHits("u1", "换个问题", { scope: "all" });
    expect(mock.embedRequests.length).toBe(callsAfterFirst + 1);
  });

  it("降级：未配置提供方 → null；embed 超时 → null；调用方退纯词法", async () => {
    const db = testDb();
    const v = makeVector(db);
    v.clear();
    expect(await v.service.recallHits("u1", "问题")).toBeNull();

    // 超时：sleep 注入为立即 resolve（竞争 embedding 的慢 Promise）
    const slow = createMemoryVector({
      db,
      now,
      embeddingFor: async () => {
        const mock = createMockLlmAdapter([], async () => new Promise<number[]>(() => undefined));
        return { adapter: mock.adapter, model: "embed-v1", providerId: "prov1" };
      },
      sleep: async () => {},
    });
    expect(await slow.recallHits("u1", "问题", { scope: "all" })).toBeNull();
  });

  it("维度不符与内容过期（指纹不匹配）的向量行按缺失处理", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const item = memory.insertItem("u1", { kind: "fact", content: "用户在减脂", topic: "身体状况", origin: "extracted" });
    // 手插一条维度错误 + 指纹过期的行
    db.prepare("INSERT INTO memory_item_embeddings (uid, item_id, model_id, dims, vector, source_fingerprint, created_ts) VALUES (?, ?, 'prov1:embed-v1', 3, ?, 'stale', 1)").run(
      "u1",
      item.item!.id,
      new Uint8Array(12),
    );
    const v = makeVector(db);
    v.set();
    expect(await v.service.recallHits("u1", "控制体重", { scope: "situational" })).toEqual([]);
  });
});

describe("embedNewItems 与 backfill", () => {
  it("embedNewItems：按 提供方:模型 标识落行；interest 拼别名进向量文本；未配置 = 无操作", async () => {
    const db = testDb();
    const memory = makeStore(db);
    memory.insertItem("u1", { kind: "fact", content: "生产库是 MySQL", topic: "在用的数据库", origin: "extracted" });
    memory.insertItem("u1", { kind: "interest", content: "门店排班管理", topic: "门店排班管理", origin: "extracted" });
    db.prepare("INSERT INTO memory_topic_stats (uid, normalized_key, topic, aliases_json, hits, last_seen_ts) VALUES ('u1', '门店排班管理', '门店排班管理', '[\"店员班次安排\"]', 3, 1)").run();
    const v = makeVector(db);
    const mock = v.set();
    await v.service.embedNewItems("u1", memory.listItems("u1", { status: "active" }));
    const rows = db.prepare("SELECT item_id, model_id, dims FROM memory_item_embeddings WHERE uid = 'u1'").all() as unknown as { item_id: string; model_id: string; dims: number }[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.model_id === "prov1:embed-v1" && r.dims === 4)).toBe(true);
    const interestText = mock.embedRequests.find((r) => r.input.includes("门店排班管理"))?.input ?? "";
    expect(interestText).toContain("店员班次安排"); // 别名只进向量

    v.clear();
    await v.service.embedNewItems("u1", memory.listItems("u1", { status: "active" }));
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_item_embeddings").all() as unknown as { n: number }[])[0]?.n).toBe(2);
  });

  it("backfill：缺失向量按限速补齐；批内失败即停；未配置返回 0", async () => {
    const db = testDb();
    const memory = makeStore(db);
    for (let i = 0; i < 3; i++) memory.insertItem("u1", { kind: "fact", content: `事实条目 ${i} 减脂`, origin: "extracted" });
    // 第二次 embed 调用抛错（模拟提供方中途故障）
    let calls = 0;
    const flaky = createMockLlmAdapter([], async (req) => {
      calls += 1;
      if (calls === 2) throw new Error("provider down");
      return keywordEmbed(req.input);
    });
    const failing = createMemoryVector({
      db,
      now,
      embeddingFor: async () => ({ adapter: flaky.adapter, model: "embed-v1", providerId: "prov1" }),
      log: () => {},
    });
    const filled = await failing.backfill("u1", 10);
    expect(filled).toBe(1); // 第二条失败即停，不空转计费
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_item_embeddings").all() as unknown as { n: number }[])[0]?.n).toBe(1);

    // 恢复后回填：已补的 1 条指纹匹配不重算，剩余 2 条补齐
    const ok = makeVector(db);
    ok.set();
    const refilled = await ok.service.backfill("u1", BACKFILL_PER_RUN);
    expect(refilled).toBe(2);

    // 未配置提供方 → 0
    const none = makeVector(db);
    none.clear();
    expect(await none.service.backfill("u1")).toBe(0);
  });
});
