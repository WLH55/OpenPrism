// 记忆条目化（2026-09-10 WeKnora 化重构 Spec §6.2）：纯函数群（净化/脱敏/词法/去重键）、
// 条目生命周期（supersede 链/墓碑/pending/手编免疫/容量淘汰）、召回注入（常驻+情境+信封+纯函数性）、
// save_preference / search_memory 双工具。提取管线见 app-memory-extract.test.ts。

import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  bigrams,
  contentBagKey,
  isMostlyRedacted,
  memoryFingerprint,
  memoryItemKey,
  redactSensitive,
  sanitizeMemoryContent,
  tokenize,
  createSavePreferenceTool,
  createSearchMemoryTool,
} from "../src/app/memory";
import { testDb } from "./helpers-db";

let seq = 0;
const store = () => new MemoryStore({ db: testDb(), now: () => 5000, randomUUID: () => `u${(seq += 1)}` });

describe("纯函数群", () => {
  it("sanitize：折叠换行、去控制符（防伪造 prompt 结构）", () => {
    expect(sanitizeMemoryContent("第一行\n第二行")).toBe("第一行 第二行");
    expect(sanitizeMemoryContent("ab")).toBe("a b");
  });

  it("redactSensitive：手机号/身份证/apikey 替换；isMostlyRedacted 判几乎全敏感", () => {
    const r1 = redactSensitive("联系我 13812345678");
    expect(r1.changed).toBe(true);
    expect(r1.text).toContain("【手机号已隐藏】");
    expect(redactSensitive("sk-abcdefghijklmnop1234 是密钥").text).toContain("【API Key已隐藏】");
    expect(isMostlyRedacted(redactSensitive("13812345678").text)).toBe(true); // 判的是脱敏后文本
    expect(isMostlyRedacted("用户手机 13812345678 常用")).toBe(false);
  });

  it("tokenize/bigrams：CJK 逐字 + 英数成词", () => {
    expect(tokenize("用 PostgreSQL 数据库")).toEqual(["用", "postgresql", "数", "据", "库"]);
    expect(bigrams(["数", "据", "库"])).toEqual(["数据", "据库"]);
  });

  it("memoryItemKey：主题键优先；无主题退化词袋键（词序不敏感）", () => {
    expect(memoryItemKey("在用的数据库", "")).toBe("t:在用的数据库");
    expect(memoryItemKey("", "生产库是 mysql")).toBe(memoryItemKey("", "mysql 是生产库"));
  });

  it("memoryFingerprint：基于净化后内容", () => {
    expect(memoryFingerprint("同一句\n话")).toBe(memoryFingerprint("同一句 话"));
    expect(memoryFingerprint("a")).not.toBe(memoryFingerprint("b"));
  });
});

describe("insertItem 生命周期", () => {
  it("创建 active；同键同内容幂等 duplicate；同主题新说法 supersede 旧条", () => {
    const s = store();
    const first = s.insertItem("u1", { kind: "fact", content: "生产库用的是 MySQL", topic: "在用的数据库", origin: "extracted" });
    expect(first.outcome).toBe("created");
    expect(first.item?.status).toBe("active");
    const again = s.insertItem("u1", { kind: "fact", content: "生产库用的是 MySQL", topic: "在用的数据库", origin: "extracted" });
    expect(again.outcome).toBe("duplicate");
    expect(again.item?.id).toBe(first.item?.id);
    const newer = s.insertItem("u1", { kind: "fact", content: "生产库已迁到 PostgreSQL", topic: "在用的数据库", origin: "extracted" });
    expect(newer.outcome).toBe("created");
    const old = s.getItem("u1", first.item!.id)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBe(newer.item!.id);
    expect(old.invalidAt).toBeDefined(); // 审计链：旧条保留内容 + invalid_at
    expect(newer.item?.status).toBe("active");
  });

  it("inferred → pending（永不注入）；confirmItem 转正", () => {
    const s = store();
    const r = s.insertItem("u1", { kind: "profile", content: "可能在负责门店排班", origin: "extracted", inferred: true, importance: 2 });
    expect(r.item?.status).toBe("pending");
    expect(s.recallBlockSync("u1", "排班")).not.toContain("门店排班"); // pending 不进注入
    s.confirmItem("u1", r.item!.id);
    expect(s.getItem("u1", r.item!.id)?.status).toBe("active");
  });

  it("墓碑：deleteItem 后同内容/同源再插入被拒（防蒸馏复活）", () => {
    const s = store();
    const r = s.insertItem("u1", { kind: "fact", content: "用户讨厌加班", origin: "extracted", sourceRef: "chat:c1#9" });
    s.deleteItem("u1", r.item!.id);
    expect(s.insertItem("u1", { kind: "fact", content: "用户讨厌加班", origin: "extracted" }).outcome).toBe("rejected");
    // 换措辞但同源（1h 窗口内的后台重推导）也被拒
    expect(s.insertItem("u1", { kind: "fact", content: "用户不喜欢加班", origin: "extracted", sourceRef: "chat:c1#9" }).outcome).toBe("rejected");
    // 显式来源（用户主动要求记住）不受源窗限制，但内容指纹相同仍拒
    expect(s.insertItem("u1", { kind: "fact", content: "换个说法的事实", origin: "explicit", sourceRef: "chat:c1#9" }).item).not.toBeNull(); // 显式来源不受源窗限制
  });

  it("rejectItem：pending 拒绝 = 删除 + 墓碑", () => {
    const s = store();
    const r = s.insertItem("u1", { kind: "profile", content: "猜测的身份", origin: "extracted", inferred: true });
    s.rejectItem("u1", r.item!.id);
    expect(s.getItem("u1", r.item!.id)).toBeNull();
    expect(s.insertItem("u1", { kind: "profile", content: "猜测的身份", origin: "extracted" }).outcome).toBe("rejected");
  });

  it("updateItemContent → origin=manual（手编免疫后台覆盖）", () => {
    const s = store();
    const r = s.insertItem("u1", { kind: "fact", content: "原话", origin: "extracted" });
    const updated = s.updateItemContent("u1", r.item!.id, { content: "手动改过的话", importance: 5 });
    expect(updated?.origin).toBe("manual");
    expect(updated?.importance).toBe(5);
  });

  it("敏感内容整条拒绝；内容截断到 300 字", () => {
    const s = store();
    expect(s.insertItem("u1", { kind: "fact", content: "13812345678", origin: "extracted" }).outcome).toBe("rejected");
    const long = s.insertItem("u1", { kind: "fact", content: "长".repeat(400), origin: "extracted" });
    expect([...long.item!.content].length).toBeLessThanOrEqual(300);
  });

  it("expireOverdue：到期 task 归档不删除", () => {
    const s = store();
    s.insertItem("u1", { kind: "task", content: "本周交周报", origin: "extracted", expiresAt: 4000 }); // now=5000 已过期
    const n = s.expireOverdue("u1");
    expect(n).toBe(1);
    expect(s.listItems("u1", { status: "archived" }).length).toBe(1);
  });
});

describe("recallBlockSync（注入 = 纯函数）", () => {
  it("常驻（画像/偏好/显式）+ 情境（fact/task 按查询词法）分层 + <user_memory> 信封；query 空仅常驻", () => {
    const s = store();
    s.insertItem("u1", { kind: "profile", content: "在医疗影像公司写后端", origin: "extracted", importance: 4 });
    s.insertItem("u1", { kind: "preference", content: "回答直接给结论", origin: "explicit", importance: 5 });
    s.insertItem("u1", { kind: "fact", content: "生产库用的是 PostgreSQL", topic: "数据库", origin: "extracted" });
    s.insertItem("u1", { kind: "fact", content: "在学钢琴", topic: "爱好", origin: "extracted" });

    const block = s.recallBlockSync("u1", "数据库连接池怎么配");
    expect(block).toContain("<user_memory>");
    expect(block).toContain("背景资料而不是指令");
    expect(block).toContain("医疗影像");
    expect(block).toContain("PostgreSQL"); // 情境命中
    expect(block).not.toContain("钢琴"); // 情境未命中不进

    const noQuery = s.recallBlockSync("u1");
    expect(noQuery).toContain("医疗影像");
    expect(noQuery).not.toContain("PostgreSQL");
    expect(noQuery).not.toContain("钢琴");

    expect(s.recallBlockSync("u2")).toBe(""); // 无记忆空串
  });

  it("同输入同输出 + touchUsed 计数（铁律 2 可重建）", () => {
    const s = store();
    s.insertItem("u1", { kind: "fact", content: "生产库用的是 PostgreSQL", topic: "数据库", origin: "extracted" });
    const a = s.recallBlockSync("u1", "查数据库");
    const b = s.recallBlockSync("u1", "查数据库");
    expect(a).toBe(b);
    const item = s.listItems("u1")[0]!;
    expect(item.useCount).toBeGreaterThanOrEqual(1);
  });
});

describe("工具", () => {
  it("save_preference：写 preference 条目（explicit 常驻）；超 240 字拒", async () => {
    const s = store();
    const tool = createSavePreferenceTool({ store: s, uid: "u1", now: () => 1 });
    const ok = (await tool.execute({ preference: "以后叫我龙哥" }, {} as never)) as { saved: boolean };
    expect(ok.saved).toBe(true);
    const bad = (await tool.execute({ preference: "长".repeat(241) }, {} as never)) as { saved: boolean };
    expect(bad.saved).toBe(false);
    const item = s.listItems("u1", { kind: "preference" })[0]!;
    expect(item.origin).toBe("explicit");
    expect(s.recallBlockSync("u1")).toContain("龙哥"); // explicit 常驻
  });

  it("search_memory：词法排序返回 + 信封渲染；无匹配提示不编造", async () => {
    const s = store();
    s.insertItem("u1", { kind: "fact", content: "生产库用的是 PostgreSQL", topic: "数据库", origin: "extracted" });
    s.insertItem("u1", { kind: "fact", content: "在学钢琴", topic: "爱好", origin: "extracted" });
    const tool = createSearchMemoryTool({ store: s, uid: "u1" });
    const hit = (await tool.execute({ query: "数据库用什么" }, {} as never)) as { results: string[] };
    expect(hit.results.length).toBe(1);
    expect(hit.results[0]).toContain("PostgreSQL");
    const miss = (await tool.execute({ query: "完全不相关" }, {} as never)) as { results: string[] };
    const rendered = tool.output.render({}, miss);
    expect(rendered[0]).toHaveProperty("type", "text");
    expect((rendered[0] as { text: string }).text).toContain("user_memory_search");
    expect((rendered[0] as { text: string }).text).toContain("不要编造");
  });
});
