// 批次2·agents：三段配置「身份 + 灵魂(persona_md) + 能力绑定」；2026-09-07 五步向导改版——
// 身份字段（描述/emoji/色盘/头像/语言/默认模型）入库；2026-09-28 起名字只来自表单显式输入（不从 persona H1 推导，persona 编辑也不改名）。

import { describe, expect, it } from "vitest";
import { AgentStore, validateIdentityPatch } from "../src/app/agents";
import { composeAssistantPrompt } from "../src/app/persona";
import { testDb } from "./helpers-db";

let aidSeq = 0; // 同一 db 内多次 create 需唯一主键
const store = () =>
  new AgentStore({ db: testDb(), now: () => 1000, randomUUID: () => `aid-${++aidSeq}` });

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

  it("提醒会话：taskFeed 时附加自动触发规则，普通会话不带", () => {
    const feed = composeAssistantPrompt({ now: NOW, tzOffsetMinutes: 480, taskFeed: true });
    expect(feed).toContain("定时提醒会话");
    expect(feed).toContain("不是用户此刻打的字");
    expect(feed).toContain("不要拿这些反问用户");
    expect(composeAssistantPrompt({ now: NOW, tzOffsetMinutes: 480 })).not.toContain("定时提醒会话");
  });

  it("身份块：伙伴名字+描述进 prompt；灵魂优先级声明；无身份退默认助手", () => {
    const withIdentity = composeAssistantPrompt({
      persona: "## 语气\n像老朋友。",
      identity: { name: "小伴", description: "陪我聊日常", language: "" },
      now: NOW,
      tzOffsetMinutes: 480,
    });
    expect(withIdentity).toContain("伙伴「小伴」");
    expect(withIdentity).toContain("陪我聊日常");
    expect(withIdentity).toContain("优先服从灵魂");
    expect(withIdentity).not.toContain("OpenPrism 的生活记录助理"); // 默认身份被身份块替代
    // 语言指令三态
    expect(composeAssistantPrompt({ identity: { name: "A", language: "zh" }, now: NOW })).toContain("简体中文");
    expect(composeAssistantPrompt({ identity: { name: "A", language: "en" }, now: NOW })).toContain("always reply in English");
    expect(composeAssistantPrompt({ identity: { name: "A", language: "" }, now: NOW })).not.toContain("语言要求");
    const plain = composeAssistantPrompt({ now: NOW, tzOffsetMinutes: 480 });
    expect(plain).not.toContain("伙伴「");
  });
});

describe("AgentStore", () => {
  it("create：名字只来自表单（H1 不再推导，缺省「助手」）；list 默认绑定空；persona 可读回", async () => {
    const s = store();
    const entry = await s.create("u1", { name: "教练", persona: "# 无关标题\n盯训练。" });
    expect(entry.name).toBe("教练");
    const noName = await s.create("u1", { persona: "# 灵魂标题\n正文" });
    expect(noName.name).toBe("助手"); // persona 的 H1 不再参与命名；改名走 updateIdentity
    const list = await s.list("u1");
    expect(list).toHaveLength(2);
    expect(list[0]!.binding).toEqual({ skills: [], mcps: [] });
    expect(await s.persona("u1", entry.id)).toBe("# 无关标题\n盯训练。");
  });

  it("无名字兜底「助手」；persona 编辑不改名（名字是表单显式资产）；binding 持久化；remove 生效", async () => {
    const s = store();
    const entry = await s.create("u2", { persona: "随性写的正文，没有标题" });
    expect(entry.name).toBe("助手");
    const renamed = await s.updatePersona("u2", entry.id, "# 庄丽洪 · 学姐\n新文案");
    expect(renamed.name).toBe("助手"); // 名字与 persona 内容无关；改名走 updateIdentity
    await s.updateIdentity("u2", entry.id, { name: "学姐" });
    expect((await s.list("u2"))[0]!.name).toBe("学姐");
    await s.updateBinding("u2", entry.id, { tools: ["record_flow", "query_ledger"], skills: ["sk-1"], mcps: [] });
    expect((await s.list("u2"))[0]!.binding.tools).toEqual(["record_flow", "query_ledger"]);
    await s.remove("u2", entry.id);
    expect(await s.list("u2")).toHaveLength(0);
    await expect(s.persona("u2", entry.id)).rejects.toThrow();
  });

  it("snapshotSync：同步取人设/名字/绑定（systemPrompt 每步热读的底座）；不存在返回 null", async () => {
    const s = store();
    const entry = await s.create("u3", { name: "学姐", persona: "# 随手标题\n温柔。", binding: { tools: ["query_ledger"], skills: ["sk-1"], mcps: [] } });
    const snapshot = s.snapshotSync("u3", entry.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toBe("学姐");
    expect(snapshot!.persona).toContain("温柔");
    expect(snapshot!.binding.tools).toEqual(["query_ledger"]);
    expect(s.snapshotSync("u3", "aid-nope")).toBeNull();
  });
});

describe("AgentStore 身份（五步向导，2026-09-07）", () => {
  const idStore = () => new AgentStore({ db: testDb(), now: () => 1000, randomUUID: () => `aid-${Math.random().toString(36).slice(2, 8)}` });

  it("create 全身份往返：名字只认表单字段；list/snapshotSync 带身份", async () => {
    const s = idStore();
    const entry = await s.create("u1", {
      name: "小伴",
      persona: "# 无关标题\n正文",
      identity: {
        description: "陪我聊日常",
        emoji: "🦊",
        color: "#b0501e",
        avatar: "data:image/png;base64,aGVsbG8=",
        language: "zh",
        modelProviderId: "prov-1",
      },
    });
    expect(entry.name).toBe("小伴"); // 显式名字压过 H1「无关标题」
    const row = (await s.list("u1"))[0]!;
    expect(row.identity).toEqual({
      description: "陪我聊日常",
      emoji: "🦊",
      color: "#b0501e",
      avatar: "data:image/png;base64,aGVsbG8=",
      language: "zh",
      modelProviderId: "prov-1",
    });
    expect(s.snapshotSync("u1", entry.id)!.identity.language).toBe("zh");
    // H1 不再推导名字：无显式名字一律兜底「助手」
    const fallback = await s.create("u1", { persona: "# 教练\n盯训练。" });
    expect(fallback.name).toBe("助手");
  });

  it("updateIdentity：补丁式更新；modelProviderId 空串清空绑定", async () => {
    const s = idStore();
    const entry = await s.create("u2", { name: "管家", persona: "x", identity: { description: "a", emoji: "🤖", color: "", language: "", modelProviderId: "prov-9" } });
    await s.updateIdentity("u2", entry.id, { description: "b", modelProviderId: "" });
    const identity = (await s.list("u2"))[0]!.identity;
    expect(identity.description).toBe("b");
    expect(identity.emoji).toBe("🤖"); // 未动字段保留
    expect(identity.modelProviderId).toBeUndefined(); // 空串 = 清空（跟随会话/全局）
  });

  it("校验拒绝：坏 avatar 前缀 / 超长 avatar / 非法 language / 非法 color / 空 name", async () => {
    const s = idStore();
    const entry = await s.create("u3", { name: "x", persona: "x" });
    expect(() => validateIdentityPatch({ avatar: "http://evil" })).toThrow();
    expect(() => validateIdentityPatch({ avatar: `data:image/png;base64,${"a".repeat(200_001)}` })).toThrow();
    expect(() => validateIdentityPatch({ language: "fr" })).toThrow();
    expect(() => validateIdentityPatch({ color: "red" })).toThrow();
    expect(() => validateIdentityPatch({ name: " " })).toThrow();
    await expect(s.create("u3", { name: "y", persona: "y", identity: { avatar: "javascript:alert(1)" } as never })).rejects.toThrow();
    await expect(s.updateIdentity("u3", entry.id, { language: "kk" })).rejects.toThrow();
  });
});
