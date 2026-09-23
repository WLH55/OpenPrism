// 批次2·skills：标准 Agent Skill（frontmatter 解析）——安装、目录层文本、load_skill 工具（skills 表）。

import { describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import {
  createLoadSkillTool,
  parseSkillFile,
  SkillStore,
  skillCatalogPrompt,
} from "../src/app/skills";
import { testDb } from "./helpers-db";

const SKILL_MD = `---
name: 健身复盘
description: 当用户聊到健身、力量训练、跑步时，用这套复盘框架追问组数/重量/感受
when_to_use: 健身与训练话题
---

# 健身复盘框架

1. 问清今天练了什么部位、几组几次
2. 问主观疲劳度（1-10）
3. 给出下次的加重要建议（+2.5kg 或保持）`;

describe("parseSkillFile", () => {
  it("解析 frontmatter 平面键 + 正文；when_to_use 可选", () => {
    const parsed = parseSkillFile(SKILL_MD);
    expect(parsed.name).toBe("健身复盘");
    expect(parsed.description).toContain("复盘框架");
    expect(parsed.whenToUse).toBe("健身与训练话题");
    expect(parsed.body).toContain("# 健身复盘框架");
  });

  it("description 超过 1024 字符拒绝装进目录层（4b.2 硬约束）", () => {
    const long = `---\nname: x\ndescription: ${"长".repeat(1025)}\n---\n正文`;
    expect(() => parseSkillFile(long)).toThrow();
  });

  it("缺 name 或 description 拒绝", () => {
    expect(() => parseSkillFile("---\nname: x\n---\n正文")).toThrow();
    expect(() => parseSkillFile("没有 frontmatter 的裸文档")).toThrow();
  });
});

describe("SkillStore", () => {
  it("create/list/body/remove 往返；body 返回完整原文（含空行）", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-1" });
    const meta = await store.create("u1", SKILL_MD);
    expect(meta.name).toBe("健身复盘");
    expect((await store.list("u1")).map((s) => s.id)).toEqual(["sk-1"]);
    expect(await store.body("u1", "sk-1")).toBe(SKILL_MD);
    await store.remove("u1", "sk-1");
    expect(await store.list("u1")).toHaveLength(0);
    await expect(store.body("u1", "sk-1")).rejects.toThrow();
  });

  it("listSync：绑定技能的同步目录层（systemPrompt 每步热读）", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-2" });
    const meta = await store.create("u1", SKILL_MD);
    expect(store.listSync("u1", [meta.id]).map((s) => s.name)).toEqual(["健身复盘"]);
    expect(store.listSync("u1", [])).toEqual([]);
    expect(store.listSync("u1", ["nope"])).toEqual([]);
  });
});

describe("skillCatalogPrompt / load_skill", () => {
  it("目录层文本含 name 与 when_to_use，不含正文（渐进式加载）", () => {
    const text = skillCatalogPrompt([
      { id: "sk-1", name: "健身复盘", description: "健身话题用这套复盘框架追问细节", whenToUse: "健身与训练话题" },
    ]);
    expect(text).toContain("健身复盘");
    expect(text).toContain("健身与训练话题");
    expect(text).not.toContain("加重要建议");
    expect(text).toContain("load_skill");
  });

  it("load_skill：execute 返回正文；未知名抛错；exclusive", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-9" });
    await store.create("u1", SKILL_MD);
    const tool = createLoadSkillTool({ store, uid: "u1" });
    const ctx = { signal: new AbortController().signal, env: nodeEnv };
    const value = (await tool.execute({ name: "健身复盘" }, ctx)) as { body: string };
    expect(value.body).toContain("健身复盘框架");
    await expect(tool.execute({ name: "不存在" }, ctx)).rejects.toThrow();
    expect(tool.isConcurrencySafe?.({})).toBeFalsy();
  });
});
