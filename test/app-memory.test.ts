// 批次2·memory：三层记忆之 L3 四槽位——读/写（memory_slots 表）、脚注剥离、
// 同步注入块、显式偏好追加。凝练流水线（L1→L2→L3）见 app-memory-layers.test.ts。

import { describe, expect, it } from "vitest";
import { MemoryStore, MEMORY_SLOTS, stripFootnotes } from "../src/app/memory";
import { testDb } from "./helpers-db";

const store = () => new MemoryStore({ db: testDb(), now: () => 5000 });

describe("stripFootnotes", () => {
  it("剥掉脚注定义行与行内引用，正文保留", () => {
    const md = "喜欢清淡饮食[^1]，作息在改善。\n\n[^1]: chat:abc123";
    expect(stripFootnotes(md)).toBe("喜欢清淡饮食，作息在改善。");
  });
});

describe("MemoryStore 读写", () => {
  it("缺省四槽全空；writeSlot 后可读回", async () => {
    const s = store();
    const empty = await s.read("u1");
    expect(Object.keys(empty).sort()).toEqual([...MEMORY_SLOTS].sort());
    expect(Object.values(empty).every((v) => v === "")).toBe(true);
    await s.writeSlot("u1", "profile", "# 画像\n软件工程师，目标复利。");
    expect((await s.read("u1")).profile).toContain("软件工程师");
  });

  it("injectionBlockSync：非空槽拼接、剥脚注；全空返回空串", async () => {
    const s = store();
    expect(s.injectionBlockSync("u2")).toBe("");
    await s.writeSlot("u2", "profile", "工程师[^1]。");
    await s.writeSlot("u2", "preferences", "- 喜欢简洁回复");
    const block = s.injectionBlockSync("u2");
    expect(block).toContain("工程师。");
    expect(block).toContain("喜欢简洁回复");
    expect(block).not.toContain("[^1]");
  });
});

describe("appendPreference（save_preference 的存储面）", () => {
  it("追加一条带时间戳的列表项；>240 字符拒绝", async () => {
    const s = store();
    await s.appendPreference("u5", "以后叫我龙哥", 1234);
    await s.appendPreference("u5", "回复要简洁", 5678);
    const preferences = (await s.read("u5")).preferences;
    expect(preferences).toContain("以后叫我龙哥");
    expect(preferences).toContain("回复要简洁");
    await expect(s.appendPreference("u5", "长".repeat(241), 1)).rejects.toThrow();
  });
});
