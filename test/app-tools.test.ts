// 批次1·tools：四录入工具（模型只能经工具写账本）+ 默认助手 persona（日期注入防算术错）。

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/harness/index";
import { defaultAssistantPrompt } from "../src/app/persona";
import { createLedgerTools } from "../src/app/tools";
import { Ledger, type FlowRecord, type PlanRecord } from "../src/app/ledger";
import { testDb } from "./helpers-db";

// 固定锚：2026-09-03 12:00 UTC（当地 UTC+8 = 20:00 周四）
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

async function freshTools() {
  const ledger = await Ledger.open(testDb(), "u1");
  const tools = createLedgerTools({
    ledger,
    now: () => NOW,
    actor: () => ({ conversationId: "c-1", agentName: "测试助手" }),
  });
  return { ledger, tools, by: (name: string) => tools.find((t) => t.name === name)! };
}

const ctx = { signal: new AbortController().signal, env: { fetch: async () => { throw new Error("no net"); }, now: () => 0, randomUUID: () => "x" } } as Parameters<ToolDefinition["execute"]>[1];

describe("record_flow", () => {
  it("落一笔 agent 来源流水：默认 time=now，actor 带会话归属", async () => {
    const { ledger, by } = await freshTools();
    const value = await by("record_flow").execute({ category: "餐饮", value: 28, unit: "¥", note: "午餐" }, ctx);
    expect(value).toMatchObject({ category: "餐饮", time: NOW });
    const record = ledger.activeRecords()[0] as FlowRecord;
    expect(record.kind).toBe("event");
    expect(record.source).toBe("agent");
    expect(record.actor).toEqual({ conversationId: "c-1", agentName: "测试助手" });
    expect(record.value).toBe(28);
  });

  it("HH:mm 时间串解析到当地今天的该时刻", async () => {
    const { ledger, by } = await freshTools();
    await by("record_flow").execute({ category: "运动", value: 30, unit: "分钟", time: "07:30" }, ctx);
    const record = ledger.activeRecords()[0] as FlowRecord;
    const d = new Date(record.time);
    expect(d.getHours()).toBe(7);
    expect(d.getMinutes()).toBe(30);
    expect(d.toDateString()).toBe(new Date(NOW).toDateString());
  });
});

describe("create_plan / checkin_plan", () => {
  it("建计划返回 planId 前缀；打卡引用并落 done", async () => {
    const { ledger, by } = await freshTools();
    const plan = (await by("create_plan").execute({ title: "晨跑", scope: "day" }, ctx)) as { planId: string };
    expect(plan.planId).toMatch(/^plan-/);
    const record = ledger.activeRecords()[0] as PlanRecord;
    expect(record.title).toBe("晨跑");
    const checkin = await by("checkin_plan").execute({ planId: plan.planId }, ctx);
    expect(checkin).toMatchObject({ planId: plan.planId, done: true, at: NOW });
  });

  it("未知 planId 打卡 → execute 抛错（管线层收敛为 isError TOOL_ERROR）", async () => {
    const { by } = await freshTools();
    await expect(by("checkin_plan").execute({ planId: "plan-nope" }, ctx)).rejects.toThrow();
  });
});

describe("query_ledger", () => {
  it("what=today 复用确定性折叠；what=plans 列活跃计划；category 过滤流水", async () => {
    const { by } = await freshTools();
    await by("record_flow").execute({ category: "餐饮", value: 28 }, ctx);
    await by("record_flow").execute({ category: "运动", value: 30 }, ctx);
    await by("create_plan").execute({ title: "读书", scope: "day" }, ctx);
    const today = (await by("query_ledger").execute({ what: "today" }, ctx)) as { flows: unknown[]; plans: unknown[] };
    expect(today.flows.length).toBe(2);
    expect(today.plans.length).toBe(1);
    const plans = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: { title: string }[] };
    expect(plans.plans[0]!.title).toBe("读书");
    const flows = (await by("query_ledger").execute({ what: "flows", category: "运动" }, ctx)) as { flows: { seq: number; category: string }[] };
    expect(flows.flows.length).toBe(1);
    expect(flows.flows[0]!.category).toBe("运动");
    expect(Number.isInteger(flows.flows[0]!.seq)).toBe(true); // seq 是 void_flow 的引用凭据
  });
});

describe("void_flow / cancel_plan（作废回路，2026-09-04 补）", () => {
  it("void_flow 按 seq 作废：折叠后不可见、审计层保留；坏 seq 抛错", async () => {
    const { ledger, by } = await freshTools();
    const flow = (await by("record_flow").execute({ category: "餐饮", value: 999 }, ctx)) as { seq: number; category: string };
    await by("void_flow").execute({ seq: flow.seq, reason: "记错金额" }, ctx);
    expect(ledger.activeRecords().some((r) => r.seq === flow.seq)).toBe(false); // 折叠剔除
    expect(ledger.readAll().some((r) => r.kind === "void")).toBe(true); // 审计保留
    const again = (await by("record_flow").execute({ category: "餐饮", value: 28 }, ctx)) as { seq: number };
    await by("void_flow").execute({ seq: again.seq }, ctx); // 无 reason 也行
    await expect(by("void_flow").execute({ seq: 999 }, ctx)).rejects.toThrow();
    await expect(by("void_flow").execute({}, ctx)).rejects.toThrow();
  });

  it("cancel_plan 按 planId 作废：计划从视图消失；未知 planId 抛错", async () => {
    const { ledger, by } = await freshTools();
    const plan = (await by("create_plan").execute({ title: "读书", scope: "day" }, ctx)) as { planId: string };
    const value = (await by("cancel_plan").execute({ planId: plan.planId }, ctx)) as { title: string };
    expect(value.title).toBe("读书");
    const plans = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: unknown[] };
    expect(plans.plans).toHaveLength(0);
    expect(ledger.readAll().some((r) => r.kind === "void")).toBe(true);
    await expect(by("cancel_plan").execute({ planId: "plan-nope" }, ctx)).rejects.toThrow();
  });
});

describe("工具契约", () => {
  it("六工具齐备；写工具 exclusive、查询 parallel", async () => {
    const { tools, by } = await freshTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["cancel_plan", "checkin_plan", "create_plan", "query_ledger", "record_flow", "void_flow"]);
    expect(by("record_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("void_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("query_ledger").isConcurrencySafe?.({})).toBe(true);
  });

  it("render 产出文本块（模型输入与 UI 共用）", async () => {
    const { by } = await freshTools();
    const blocks = by("record_flow").output.render({ category: "餐饮", value: 28 }, { seq: 0, time: NOW, category: "餐饮" });
    const first = blocks[0] as { type: string; text: string };
    expect(first.type).toBe("text");
    expect(first.text).toContain("餐饮");
  });
});

describe("defaultAssistantPrompt", () => {
  it("注入当地日期与星期、写账纪律与工具名，零预设分类", () => {
    const prompt = defaultAssistantPrompt({ now: () => NOW, tzOffsetMinutes: 480 });
    expect(prompt).toContain("2026-09-03");
    expect(prompt).toContain("周四");
    expect(prompt).toContain("record_flow");
    expect(prompt).toContain("query_ledger");
    expect(prompt).not.toContain("健身"); // 不举例任何默认分类
  });
});
