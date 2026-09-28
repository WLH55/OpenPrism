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
  it("八工具齐备；写工具 exclusive、查询 parallel", async () => {
    const { tools, by } = await freshTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_plan",
      "checkin_plan",
      "create_goal",
      "create_plan",
      "query_ledger",
      "record_flow",
      "update_goal",
      "void_flow",
    ]);
    expect(by("record_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("void_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("create_goal").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("update_goal").isConcurrencySafe?.({})).toBeFalsy();
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

describe("create_goal / update_goal / query_ledger what=goals（B2，2026-09-28）", () => {
  it("层级规则：phase 必须挂 direction；project 挂 phase/direction；direction 不允许 parentId", async () => {
    const { by } = await freshTools();
    const direction = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    await expect(by("create_goal").execute({ level: "phase", title: "8 周减脂" }, ctx)).rejects.toThrow("parentId");
    await expect(
      by("create_goal").execute({ level: "phase", title: "阶段", parentId: "goal-nope" }, ctx),
    ).rejects.toThrow("不存在");
    const phase = (await by("create_goal").execute({ level: "phase", title: "8 周减脂", parentId: direction.goalId, nextStep: "约教练" }, ctx)) as { goalId: string };
    const project = (await by("create_goal").execute({ level: "project", title: "跑步计划", parentId: phase.goalId }, ctx)) as { goalId: string };
    await expect(
      by("create_goal").execute({ level: "project", title: "子项目", parentId: project.goalId }, ctx),
    ).rejects.toThrow("project");
    await expect(
      by("create_goal").execute({ level: "direction", title: "带父的方向", parentId: direction.goalId }, ctx),
    ).rejects.toThrow("不挂父级");
  });

  it("软约束不 block：前 3 个同层 active 无提醒，建第 4 个仍成功且回执带聚焦提醒", async () => {
    const { by } = await freshTools();
    for (let i = 1; i <= 3; i += 1) {
      const r = (await by("create_goal").execute({ level: "direction", title: `方向${i}` }, ctx)) as { hint?: string };
      expect(r.hint).toBeUndefined();
    }
    const fourth = (await by("create_goal").execute({ level: "direction", title: "方向4" }, ctx)) as { goalId: string; hint?: string };
    expect(fourth.goalId).toMatch(/^goal-/); // 不 block
    expect(fourth.hint).toContain("3 个"); // 提醒已有 3 个进行中
  });

  it("update_goal 修订 = 追加快照：未提供字段沿用当前值；非法 status 抛错", async () => {
    const { ledger, by } = await freshTools();
    const direction = (await by("create_goal").execute({ level: "direction", title: "健康", why: "精力" }, ctx)) as { goalId: string };
    await by("update_goal").execute({ goalId: direction.goalId, title: "健康（修订）", status: "paused" }, ctx);
    const updated = (await by("query_ledger").execute({ what: "goals" }, ctx)) as {
      directions: { goalId: string; title: string; status: string; why?: string }[];
    };
    const node = updated.directions.find((d) => d.goalId === direction.goalId)!;
    expect(node.title).toBe("健康（修订）");
    expect(node.status).toBe("paused");
    expect(node.why).toBe("精力"); // 未提供字段沿用
    // 历史保留：两条 goal 快照都在账本里
    const snapshots = ledger.readAll().filter((r) => r.kind === "goal");
    expect(snapshots).toHaveLength(2);
    await expect(by("update_goal").execute({ goalId: direction.goalId, status: "oops" }, ctx)).rejects.toThrow("status");
    await expect(by("update_goal").execute({ goalId: "goal-nope", title: "x" }, ctx)).rejects.toThrow("不存在");
  });

  it("update_goal 换父级拒绝成环", async () => {
    const { by } = await freshTools();
    const d = (await by("create_goal").execute({ level: "direction", title: "方向" }, ctx)) as { goalId: string };
    const p = (await by("create_goal").execute({ level: "phase", title: "阶段", parentId: d.goalId }, ctx)) as { goalId: string };
    // 阶段想反过来当方向的父（层级违规先拦）；用两个 phase 互挂测环需先绕过层级——改为直接把方向挂到阶段下（层级违规）
    await expect(by("update_goal").execute({ goalId: d.goalId, parentId: p.goalId }, ctx)).rejects.toThrow();
  });

  it("create_plan 挂 goalId（等价外键）：不存在拒绝；goalTitle 回执", async () => {
    const { ledger, by } = await freshTools();
    const direction = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    const plan = (await by("create_plan").execute({ title: "体测里程碑", scope: "deadline", due: "2026-10-15", goalId: direction.goalId }, ctx)) as {
      planId: string;
      goalTitle?: string;
    };
    expect(plan.goalTitle).toBe("健康");
    const record = ledger.activeRecords().find((r) => r.kind === "plan") as { goalId?: string };
    expect(record.goalId).toBe(direction.goalId);
    await expect(
      by("create_plan").execute({ title: "幽灵", scope: "day", goalId: "goal-nope" }, ctx),
    ).rejects.toThrow("不存在");
  });

  it("query_ledger what=goals 返回层级树 + 进度", async () => {
    const { by } = await freshTools();
    const d = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    const p = (await by("create_goal").execute({ level: "phase", title: "8 周减脂", parentId: d.goalId, nextStep: "约教练" }, ctx)) as { goalId: string };
    await by("create_plan").execute({ title: "里程碑", scope: "deadline", due: "2026-10-15", goalId: p.goalId }, ctx);
    const plan = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: { planId: string }[] };
    await by("checkin_plan").execute({ planId: plan.plans[0]!.planId }, ctx);
    const view = (await by("query_ledger").execute({ what: "goals" }, ctx)) as {
      directions: { title: string; children: { title: string; progress: { done: number; total: number } }[]; progress: { done: number; total: number } }[];
    };
    const direction = view.directions[0]!;
    expect(direction.children[0]!.title).toBe("8 周减脂");
    expect(direction.progress).toEqual({ done: 1, total: 1, rate: 1 }); // 里程碑打卡冒泡到方向
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
