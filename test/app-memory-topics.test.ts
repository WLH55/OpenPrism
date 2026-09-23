// 主题计数（2026-09-18 Spec §4.3 checklist 2–5）：归一纯函数（相似度/守卫）、TopicStore 存储、
// 三级归一（精确/别名 → 模糊 → 注入式模型裁决）、observeTopics 计数晋升（阈值/遗忘/向量作废）。
// 零网络：模型裁决用 mock adapter 或注入函数，时钟注入固定值。

import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/app/memory";
import {
  bumpTopic,
  createLlmTopicAdjudicator,
  forgetTopic,
  getTopicByKey,
  listUnpromotedTopics,
  listTopTopics,
  markTopicPromoted,
  observeTopics,
  promoteTopicManually,
  resolveTopics,
  restoreTopic,
  sanitizeTopicLabel,
  topicIsSpecificEnough,
  topicLabelIsAnImprovement,
  topicSimilarity,
} from "../src/app/memory-topics";
import { createMockLlmAdapter, llmFailure } from "../src/harness/index";
import { testDb } from "./helpers-db";

let clock = 100_000;
const now = () => (clock += 1);
let uidSeq = 0;
const makeStore = (db: DatabaseSync): MemoryStore => new MemoryStore({ db, now, randomUUID: () => `x${(uidSeq += 1)}` });

describe("归一纯函数", () => {
  it("sanitizeTopicLabel：折叠空白 + 截长 40", () => {
    expect(sanitizeTopicLabel("  门店\n排班  ")).toBe("门店 排班");
    expect([...sanitizeTopicLabel("长".repeat(50))].length).toBe(40);
  });

  it("topicSimilarity：相同=1、无关=0、换说法高重合；Dice 对长标签宽容", () => {
    expect(topicSimilarity("门店排班管理", "门店排班管理")).toBe(1);
    expect(topicSimilarity("门店排班管理", "PostgreSQL 备份")).toBeLessThan(0.2);
    // "排班管理" 是 "门店排班管理" 的子串换说法：bigram {排班,班管,管理} vs 5 grams → 2*3/(3+5)=0.75
    expect(topicSimilarity("排班管理", "门店排班管理")).toBeCloseTo(0.75);
    expect(topicSimilarity("", "门店排班管理")).toBe(0);
  });

  it("topicIsSpecificEnough：≥4 字才可模糊匹配（短标签防误合并）", () => {
    expect(topicIsSpecificEnough("健身")).toBe(false);
    expect(topicIsSpecificEnough("健身房锻炼")).toBe(true);
    expect(topicIsSpecificEnough("PostgreSQL 连接池")).toBe(true);
  });

  it("topicLabelIsAnImprovement：只许更具体，泛化/缩短/凭空发明一律拒绝", () => {
    const canonical = "门店排班管理";
    expect(topicLabelIsAnImprovement(canonical, "门店排班管理系统", "排班管理")).toBe(false); // 更短 = 更宽泛
    expect(topicLabelIsAnImprovement(canonical, "门店排班管理系统", "排班")).toBe(false); // canonical 的子串
    expect(topicLabelIsAnImprovement(canonical, "门店排班管理系统", "完全无关的词")).toBe(false); // 无锚定
    expect(topicLabelIsAnImprovement(canonical, "门店排班管理系统", "连锁门店排班管理")).toBe(true); // 更完整且两侧锚定
    expect(topicLabelIsAnImprovement(canonical, "门店排班管理系统", canonical)).toBe(false); // 同名不算改进
  });
});

describe("TopicStore 存储", () => {
  it("bumpTopic：新行 hits=1；再 bump 计数累加、新说法进别名（≤12）、规范名保持首记", () => {
    const db = testDb();
    const s1 = bumpTopic(db, "u1", now(), "门店排班管理", "门店排班管理", "门店排班管理");
    expect(s1.hits).toBe(1);
    expect(s1.aliases).toEqual([]);
    const s2 = bumpTopic(db, "u1", now(), "门店排班管理", "门店排班管理", "店员班次安排");
    expect(s2.hits).toBe(2);
    expect(s2.aliases).toEqual(["店员班次安排"]);
    expect(s2.topic).toBe("门店排班管理");
    const s3 = bumpTopic(db, "u1", now(), "店员班次安排", "门店排班管理", "门店排班管理");
    expect(s3.hits).toBe(3);
    expect(s3.aliases.some((a) => a === "门店排班管理")).toBe(false); // 规范名不重复进别名
  });

  it("遗忘行不再出现在未晋升/热度列表；restore 恢复；markPromoted 幂等", () => {
    const db = testDb();
    bumpTopic(db, "u1", now(), "健身", "健身", "健身");
    bumpTopic(db, "u1", now(), "减脂", "减脂", "减脂");
    forgetTopic(db, "u1", "健身", now());
    expect(listUnpromotedTopics(db, "u1").map((s) => s.topic)).toEqual(["减脂"]);
    expect(listTopTopics(db, "u1").map((s) => s.topic)).toEqual(["减脂"]);
    markTopicPromoted(db, "u1", "减脂", now());
    markTopicPromoted(db, "u1", "减脂", now());
    expect(getTopicByKey(db, "u1", "减脂")?.promotedTs).toBeDefined();
    restoreTopic(db, "u1", "健身");
    expect(listUnpromotedTopics(db, "u1").map((s) => s.topic)).toEqual(["健身"]); // 减脂已晋升不在列表
  });

  it("promoteTopicManually：写 interest + 标 promoted + 回调嵌入；遗忘行拒绝", async () => {
    const db = testDb();
    const memory = makeStore(db);
    bumpTopic(db, "u1", now(), "游泳", "游泳", "游泳");
    const embedded: string[] = [];
    const stat = await promoteTopicManually({
      db,
      now,
      memory,
      uid: "u1",
      key: "游泳",
      embedNewItems: async (_uid, items) => {
        embedded.push(...items.map((i) => i.content));
      },
    });
    expect(stat?.topic).toBe("游泳");
    expect(memory.listItems("u1", { kind: "interest" })[0]?.content).toBe("游泳");
    expect(embedded).toEqual(["游泳"]);
    expect(getTopicByKey(db, "u1", "游泳")?.promotedTs).toBeDefined();
    bumpTopic(db, "u1", now(), "跑步", "跑步", "跑步");
    forgetTopic(db, "u1", "跑步", now());
    expect(await promoteTopicManually({ db, now, memory, uid: "u1", key: "跑步" })).toBeNull();
  });
});

describe("resolveTopics 三级归一", () => {
  it("tier reused/exact：规范化相等与别名命中", async () => {
    const db = testDb();
    bumpTopic(db, "u1", now(), "门店排班管理", "门店排班管理", "店员班次安排");
    const out = await resolveTopics({
      db,
      uid: "u1",
      surfaces: ["门店排班管理", "店员班次安排", " 门店排班管理 "],
      adjudicate: async () => {
        throw new Error("不该走到裁决层");
      },
    });
    expect(out.map((r) => r.tier)).toEqual(["reused", "exact", "exact"]);
    expect(out.every((r) => r.canonical?.topic === "门店排班管理")).toBe(true);
  });

  it("tier fuzzy：Dice ≥0.80 且 ≥4 字；短标签不模糊匹配", async () => {
    const db = testDb();
    bumpTopic(db, "u1", now(), "门店排班管理", "门店排班管理", "");
    const out = await resolveTopics({ db, uid: "u1", surfaces: ["店排班管理"] });
    expect(out[0]?.tier).toBe("fuzzy");
    expect(out[0]?.canonical?.topic).toBe("门店排班管理");
    // 短标签："健身房" 对 "健身" 两者规范化后都不足 4 字 → 不许模糊归一
    bumpTopic(db, "u1", now(), "健身", "健身", "");
    const short = await resolveTopics({ db, uid: "u1", surfaces: ["健身房"] });
    expect(short[0]?.tier).toBe("new");
    expect(short[0]?.canonical).toBeNull();
  });

  it("tier model：只动未决标签、越界 same_as 忽略、合并名过守卫才生效", async () => {
    const db = testDb();
    bumpTopic(db, "u1", now(), "门店排班管理", "门店排班管理", "");
    bumpTopic(db, "u1", now(), "饮食控制", "饮食控制", ""); // 更晚 bump → 热度序更靠前
    const out = await resolveTopics({
      db,
      uid: "u1",
      surfaces: ["门店排班的审批流程", "减脂餐搭配", "门店排班管理"],
      adjudicate: async (existing, unresolved) => {
        expect(existing).toEqual(["饮食控制", "门店排班管理"]);
        expect(unresolved).toEqual(["门店排班的审批流程", "减脂餐搭配"]);
        return new Map([
          [0, { sameAs: 1, label: "门店排班管理审批" }], // 更具体且与两侧锚定 → 采纳
          [1, { sameAs: 0, label: "饮食" }], // 泛化名 → 守卫拒绝
          [2, { sameAs: 0, label: "越权" }], // 序号 2 不在未决列表 → 忽略
        ]);
      },
    });
    expect(out[0]?.tier).toBe("model");
    expect(out[0]?.canonical?.topic).toBe("门店排班管理");
    expect(out[0]?.mergedLabel).toBe("门店排班管理审批");
    expect(out[1]?.tier).toBe("model");
    expect(out[1]?.canonical?.topic).toBe("饮食控制");
    expect(out[1]?.mergedLabel).toBeUndefined();
    expect(out[2]?.tier).toBe("reused"); // 更可靠层级的判定不被裁决覆盖
  });

  it("同 run 内新说法规范化相同 → 折叠成一行", async () => {
    const db = testDb();
    const out = await resolveTopics({ db, uid: "u1", surfaces: ["游泳锻炼", "游泳锻炼 "] });
    expect(out[0]?.surface).toBe("游泳锻炼");
    expect(out[1]?.surface).toBe("游泳锻炼");
  });
});

describe("observeTopics 计数晋升", () => {
  it("同一主题（含换说法）累计 ≥ 阈值 → 自动晋升 interest；未达阈值不晋升", async () => {
    const db = testDb();
    const memory = makeStore(db);
    const deps = { db, now, memory, uid: "u1", threshold: 3 };
    await observeTopics({ ...deps, topics: ["门店排班管理"] });
    await observeTopics({ ...deps, topics: ["店排班管理"] }); // 模糊归一到同一主题
    expect(memory.listItems("u1", { kind: "interest" }).length).toBe(0);
    expect(getTopicByKey(db, "u1", "门店排班管理")?.hits).toBe(2);
    const third = await observeTopics({ ...deps, topics: [" 门店排班管理 "] }); // 精确归一
    expect(third.promoted).toEqual(["门店排班管理"]);
    expect(third.promotedItems.map((i) => i.content)).toEqual(["门店排班管理"]); // 调用方据此写入即嵌入
    const interests = memory.listItems("u1", { kind: "interest" });
    expect(interests.length).toBe(1);
    expect(interests[0]?.content).toBe("门店排班管理");
    expect(interests[0]?.origin).toBe("extracted");
    expect(getTopicByKey(db, "u1", "门店排班管理")?.promotedTs).toBeDefined();
    // 已晋升不再重复晋升；计数继续累积
    const fourth = await observeTopics({ ...deps, topics: ["店排班管理"] });
    expect(fourth.promoted).toEqual([]);
    expect(fourth.promotedItems).toEqual([]);
    expect(memory.listItems("u1", { kind: "interest" }).length).toBe(1);
  });

  it("遗忘主题：不计数、不晋升；主题别名增长作废对应 interest 向量", async () => {
    const db = testDb();
    const memory = makeStore(db);
    bumpTopic(db, "u1", now(), "追剧", "追剧", "追剧");
    forgetTopic(db, "u1", "追剧", now());
    const first = await observeTopics({ db, now, memory, uid: "u1", topics: ["追剧"], threshold: 1 });
    expect(first.counted).toBe(0);
    expect(first.promoted).toEqual([]);
    expect(getTopicByKey(db, "u1", "追剧")?.hits).toBe(1); // 遗忘前的计数保留，之后不再增长

    // 别名增长 → interest 向量行被作废（回填按新说法重建）；阈值 99 = 只计数不晋升
    bumpTopic(db, "u1", now(), "门店排班管理", "门店排班管理", "");
    const interest = memory.insertItem("u1", { kind: "interest", content: "门店排班管理", topic: "门店排班管理", origin: "extracted" });
    db.prepare("INSERT INTO memory_item_embeddings (uid, item_id, model_id, dims, vector, source_fingerprint, created_ts) VALUES (?, ?, 'p:m', 2, ?, 'fp', 1)").run(
      "u1",
      interest.item!.id,
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
    );
    const second = await observeTopics({ db, now, memory, uid: "u1", topics: ["店排班管理"], threshold: 99 });
    expect(second.promoted).toEqual([]);
    expect(second.counted).toBe(1);
    const rows = db.prepare("SELECT item_id FROM memory_item_embeddings WHERE uid = 'u1'").all() as unknown as { item_id: string }[];
    expect(rows.length).toBe(0); // 向量已作废
  });
});

describe("createLlmTopicAdjudicator", () => {
  it("解析模型 JSON → 决策表；垃圾输出/模型失败 → 空 Map（欠合并优于错合并）", async () => {
    const good = createMockLlmAdapter([
      { kind: "text", text: '{"resolutions":[{"index":0,"same_as":1,"label":"持续集成流水线"},{"index":1,"same_as":null}]}' },
    ]);
    const goodOut = await createLlmTopicAdjudicator({ adapter: good.adapter, model: "m" })(["CI 流水线", "数据库"], ["持续集成流水线", "备份策略"]);
    expect(goodOut.get(0)).toEqual({ sameAs: 1, label: "持续集成流水线" });
    expect(goodOut.get(1)?.sameAs).toBeUndefined();

    const garbage = createMockLlmAdapter([{ kind: "text", text: "我无法判断" }]);
    const garbageOut = await createLlmTopicAdjudicator({ adapter: garbage.adapter, model: "m" })(["a"], ["b"]);
    expect(garbageOut.size).toBe(0);

    const failed = createMockLlmAdapter([{ kind: "failure", failure: llmFailure("SERVER", "provider down") }]);
    const failedOut = await createLlmTopicAdjudicator({ adapter: failed.adapter, model: "m", log: () => {} })(["a"], ["b"]);
    expect(failedOut.size).toBe(0);
  });
});
