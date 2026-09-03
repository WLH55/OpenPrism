// 批次2·memory：三层记忆之 L3 四槽位——读/原子写、脚注剥离、凝练（mock adapter，fail-safe）、注入块、显式偏好追加。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths, type AppPaths } from "../src/app/store";
import { MemoryStore, MEMORY_SLOTS, buildConsolidationPrompt, stripFootnotes } from "../src/app/memory";
import { createMockLlmAdapter } from "../src/harness/index";

let root: string;
let paths: AppPaths;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-memory-"));
  paths = appPaths(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = () => new MemoryStore({ fileIO: nodeFileIO, paths, now: () => 5000 });

describe("stripFootnotes", () => {
  it("剥掉脚注定义行与行内引用，正文保留", () => {
    const md = "喜欢清淡饮食[^1]，作息在改善。\n\n[^1]: chat:abc123";
    expect(stripFootnotes(md)).toBe("喜欢清淡饮食，作息在改善。");
  });
});

describe("MemoryStore 读写", () => {
  it("缺省四槽全空；writeSlot 原子写后可读回", async () => {
    const s = store();
    const empty = await s.read("u1");
    expect(Object.keys(empty).sort()).toEqual([...MEMORY_SLOTS].sort());
    expect(Object.values(empty).every((v) => v === "")).toBe(true);
    await s.writeSlot("u1", "profile", "# 画像\n软件工程师，目标复利。");
    expect((await s.read("u1")).profile).toContain("软件工程师");
  });

  it("injectionBlock：非空槽拼接、剥脚注；全空返回空串", async () => {
    const s = store();
    expect(await s.injectionBlock("u2")).toBe("");
    await s.writeSlot("u2", "profile", "工程师[^1]。");
    await s.writeSlot("u2", "preferences", "- 喜欢简洁回复");
    const block = await s.injectionBlock("u2");
    expect(block).toContain("工程师。");
    expect(block).toContain("喜欢简洁回复");
    expect(block).not.toContain("[^1]");
  });
});

describe("凝练（consolidate）", () => {
  const GOOD_OUTPUT = `<!-- slot: recent -->
最近在调整作息，连续三天 23 点前入睡。

<!-- slot: profile -->
软件工程师，重视复利式成长。

<!-- slot: preferences -->
- 喜欢简洁回复

<!-- slot: scope -->
当前主线：OpenPrism 批次开发。`;

  it("四段输出 → 落盘四槽 + meta 记 lastRunTs/runs", async () => {
    const s = store();
    const { adapter } = createMockLlmAdapter([{ kind: "text", text: GOOD_OUTPUT }]);
    const result = await s.consolidate({ uid: "u3", adapter, model: "mock-1", sessionTexts: ["用户：最近睡得早", "助手：挺好的"] });
    expect(result.changed).toBe(true);
    const memory = await s.read("u3");
    expect(memory.recent).toContain("作息");
    expect(memory.preferences).toContain("简洁回复");
    const meta = await s.meta("u3");
    expect(meta.lastRunTs).toBe(5000);
    expect(meta.runs).toBe(1);
  });

  it("坏输出（无槽标记）→ fail-safe 不落盘", async () => {
    const s = store();
    const { adapter } = createMockLlmAdapter([{ kind: "text", text: "我随便说了点什么" }]);
    const result = await s.consolidate({ uid: "u4", adapter, model: "mock-1", sessionTexts: ["x"] });
    expect(result.changed).toBe(false);
    expect((await s.read("u4")).recent).toBe("");
    expect((await s.meta("u4")).runs).toBe(0);
  });

  it("buildConsolidationPrompt 含会话文本与现有记忆", () => {
    const prompt = buildConsolidationPrompt(["用户：喜欢简洁"], { recent: "旧recent", profile: "", scope: "", preferences: "" });
    expect(prompt).toContain("喜欢简洁");
    expect(prompt).toContain("旧recent");
    expect(prompt).toContain("slot: recent");
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
