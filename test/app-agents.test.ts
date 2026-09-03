// 批次2·agents：三段配置之「人设卡」（纯自由 markdown，名字从 H1 推导）+ CRUD 与能力绑定存取。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeFileIO } from "../src/app/env";
import { appPaths, type AppPaths } from "../src/app/store";
import { AgentStore } from "../src/app/agents";
import { composeAssistantPrompt, extractAgentName } from "../src/app/persona";

let root: string;
let paths: AppPaths;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-agents-"));
  paths = appPaths(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = () =>
  new AgentStore({ fileIO: nodeFileIO, paths, now: () => 1000, randomUUID: () => "aid-1" });

describe("extractAgentName", () => {
  it("取首个 H1 文本；无 H1 返回空串", () => {
    expect(extractAgentName("# 庄丽洪 · 学姐\n你是我认识的人…")).toBe("庄丽洪 · 学姐");
    expect(extractAgentName("## 二级标题不算\n正文")).toBe("");
    expect(extractAgentName("没有标题的正文")).toBe("");
  });
});

describe("composeAssistantPrompt", () => {
  const NOW = () => Date.UTC(2026, 8, 3, 12, 0, 0);

  it("人设 + 记忆块 + 日期 + 纪律四件齐全；默认身份在人设缺省时兜底", () => {
    const withPersona = composeAssistantPrompt({
      persona: "# 学姐\n温柔毒舌，盯你作息。",
      memoryBlock: "## 关于用户\n喜欢清淡饮食",
      now: NOW,
      tzOffsetMinutes: 480,
    });
    expect(withPersona).toContain("温柔毒舌");
    expect(withPersona).toContain("喜欢清淡饮食");
    expect(withPersona).toContain("2026-09-03");
    expect(withPersona).toContain("周四");
    expect(withPersona).toContain("record_flow");
    const fallback = composeAssistantPrompt({ now: NOW, tzOffsetMinutes: 480 });
    expect(fallback).toContain("OpenPrism");
    expect(fallback).not.toContain("undefined");
  });

  it("save_preference 纪律随偏好工具出现（显式偏好才记）", () => {
    const prompt = composeAssistantPrompt({ now: NOW, tzOffsetMinutes: 480 });
    expect(prompt).toContain("save_preference");
    expect(prompt).toContain("不要猜");
  });
});

describe("AgentStore", () => {
  it("create：名字从 H1 推导；list 默认绑定空；persona 可读回", async () => {
    const s = store();
    const entry = await s.create("u1", { persona: "# 教练\n盯训练。" });
    expect(entry.name).toBe("教练");
    const list = await s.list("u1");
    expect(list).toHaveLength(1);
    expect(list[0]!.binding).toEqual({ skills: [], mcps: [] });
    expect(await s.persona("u1", entry.id)).toBe("# 教练\n盯训练。");
  });

  it("无 H1 的名字兜底「助手」；updatePersona 重推导名字；binding 持久化；remove 生效", async () => {
    const s = store();
    const entry = await s.create("u2", { persona: "随性写的正文，没有标题" });
    expect(entry.name).toBe("助手");
    const renamed = await s.updatePersona("u2", entry.id, "# 庄丽洪 · 学姐\n新文案");
    expect(renamed.name).toBe("庄丽洪 · 学姐");
    await s.updateBinding("u2", entry.id, { tools: ["record_flow", "query_ledger"], skills: ["sk-1"], mcps: [] });
    expect((await s.list("u2"))[0]!.binding.tools).toEqual(["record_flow", "query_ledger"]);
    await s.remove("u2", entry.id);
    expect(await s.list("u2")).toHaveLength(0);
    await expect(s.persona("u2", entry.id)).rejects.toThrow();
  });
});
