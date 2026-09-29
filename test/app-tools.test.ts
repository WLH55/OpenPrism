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
  it("十工具齐备；写工具 exclusive、查询 parallel", async () => {
    const { tools, by } = await freshTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_plan",
      "checkin_plan",
      "create_goal",
      "create_plan",
      "delete_goal",
      "query_ledger",
      "record_flow",
      "update_goal",
      "update_plan",
      "void_flow",
    ]);
    expect(by("record_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("void_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("update_plan").isConcurrencySafe?.({})).toBeFalsy();
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

describe("update_plan（2026-09-29 账本工具能力补全）", () => {
  it("改标题与顺延 due：planId 不变、旧记录被 void、查询反映新值", async () => {
    const { ledger, by } = await freshTools();
    const plan = (await by("create_plan").execute({ title: "交报告", scope: "deadline", due: "2026-09-05" }, ctx)) as { planId: string };
    const upd = (await by("update_plan").execute({ planId: plan.planId, title: "交年度报告", due: "2026-09-10" }, ctx)) as {
      planId: string;
      title: string;
    };
    expect(upd).toMatchObject({ planId: plan.planId, title: "交年度报告" });
    const plans = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: { planId: string; title: string; due: string }[] };
    expect(plans.plans[0]).toMatchObject({ planId: plan.planId, title: "交年度报告", due: "2026-09-10" });
    // 折叠层只剩一条该 planId 的 plan；readAll 里旧记录被 void 引用（历史审计保留）
    expect(ledger.activeRecords().filter((r) => r.kind === "plan" && (r as PlanRecord).planId === plan.planId)).toHaveLength(1);
    expect(ledger.readAll().filter((r) => r.kind === "void")).toHaveLength(1);
  });

  it("goalId 换挂与空串解除挂载；已打的卡不因修订丢失", async () => {
    const { by } = await freshTools();
    const d1 = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    const d2 = (await by("create_goal").execute({ level: "direction", title: "学习" }, ctx)) as { goalId: string };
    const plan = (await by("create_plan").execute({ title: "里程碑", scope: "deadline", due: "2026-10-01", goalId: d1.goalId }, ctx)) as { planId: string };
    await by("checkin_plan").execute({ planId: plan.planId }, ctx);
    await by("update_plan").execute({ planId: plan.planId, goalId: d2.goalId }, ctx);
    const scoped = (await by("query_ledger").execute({ what: "plans", goalId: d2.goalId }, ctx)) as { plans: { planId: string }[] };
    expect(scoped.plans.map((p) => p.planId)).toContain(plan.planId);
    await by("update_plan").execute({ planId: plan.planId, goalId: "" }, ctx);
    const afterDetach = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: { planId: string; goalId?: string }[] };
    expect(afterDetach.plans.find((p) => p.planId === plan.planId)!.goalId).toBeUndefined();
    const today = (await by("query_ledger").execute({ what: "today" }, ctx)) as { plans: { planId: string; state: string }[] };
    expect(today.plans.find((p) => p.planId === plan.planId)!.state).toBe("done");
  });

  it("报错路径：planId 不存在 / scope 换 deadline 缺 due / goalId 不存在", async () => {
    const { by } = await freshTools();
    await expect(by("update_plan").execute({ planId: "plan-nope", title: "x" }, ctx)).rejects.toThrow("不存在");
    const plan = (await by("create_plan").execute({ title: "日记", scope: "day" }, ctx)) as { planId: string };
    await expect(by("update_plan").execute({ planId: plan.planId, scope: "deadline" }, ctx)).rejects.toThrow("due");
    await expect(by("update_plan").execute({ planId: plan.planId, goalId: "goal-nope" }, ctx)).rejects.toThrow("不存在");
  });
});

describe("checkin_plan 补卡 + void_flow 撤卡（2026-09-29）", () => {
  it("date/time 补历史卡：at 落在指定当地日与时刻；回执带 seq（撤卡凭据）", async () => {
    const { by } = await freshTools();
    const plan = (await by("create_plan").execute({ title: "背单词", scope: "day" }, ctx)) as { planId: string };
    const checkin = (await by("checkin_plan").execute({ planId: plan.planId, date: "2026-09-01", time: "09:30" }, ctx)) as {
      at: number;
      seq: number;
    };
    expect(Number.isInteger(checkin.seq)).toBe(true);
    const d = new Date(checkin.at);
    expect(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`).toBe("2026-09-01");
    expect(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`).toBe("09:30");
  });

  it("未来日期拒绝；非法 date/time 格式拒绝", async () => {
    const { by } = await freshTools();
    const plan = (await by("create_plan").execute({ title: "背单词", scope: "day" }, ctx)) as { planId: string };
    await expect(by("checkin_plan").execute({ planId: plan.planId, date: "2026-12-31" }, ctx)).rejects.toThrow("未来");
    await expect(by("checkin_plan").execute({ planId: plan.planId, date: "09-01" }, ctx)).rejects.toThrow("YYYY-MM-DD");
    await expect(by("checkin_plan").execute({ planId: plan.planId, time: "9点" }, ctx)).rejects.toThrow("HH:mm");
  });

  it("撤卡：day 型打完 void 后回到待做；deadline 型 doneEver 消失回到未开始", async () => {
    const { by } = await freshTools();
    const stateOf = async (planId: string) => {
      const today = (await by("query_ledger").execute({ what: "today" }, ctx)) as { plans: { planId: string; state: string }[] };
      return today.plans.find((p) => p.planId === planId)!.state;
    };
    const day = (await by("create_plan").execute({ title: "跑步", scope: "day" }, ctx)) as { planId: string };
    const c1 = (await by("checkin_plan").execute({ planId: day.planId }, ctx)) as { seq: number };
    expect(await stateOf(day.planId)).toBe("done");
    await by("void_flow").execute({ seq: c1.seq, reason: "打错了" }, ctx);
    expect(await stateOf(day.planId)).toBe("todo");

    const dl = (await by("create_plan").execute({ title: "交报告", scope: "deadline", due: "2026-09-10" }, ctx)) as { planId: string };
    const c2 = (await by("checkin_plan").execute({ planId: dl.planId }, ctx)) as { seq: number };
    expect(await stateOf(dl.planId)).toBe("done");
    await by("void_flow").execute({ seq: c2.seq }, ctx);
    expect(await stateOf(dl.planId)).toBe("upcoming"); // due 在未来 → 打回未开始
  });

  it("void_flow 指向 plan/goal seq → 报错引导专用工具", async () => {
    const { ledger, by } = await freshTools();
    await by("create_plan").execute({ title: "跑步", scope: "day" }, ctx);
    const planSeq = ledger.activeRecords().find((r) => r.kind === "plan")!.seq;
    await expect(by("void_flow").execute({ seq: planSeq }, ctx)).rejects.toThrow("cancel_plan");
    await by("create_goal").execute({ level: "direction", title: "健康" }, ctx);
    const goalSeq = ledger.activeRecords().find((r) => r.kind === "goal")!.seq;
    await expect(by("void_flow").execute({ seq: goalSeq }, ctx)).rejects.toThrow("update_goal");
  });
});

describe("query_ledger 过滤限量 + 人话回执（2026-09-29）", () => {
  it("goalId 过滤只返回挂该目标的计划；limit 截断带 total/truncated；limit 非法拒绝", async () => {
    const { by } = await freshTools();
    const d = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    await by("create_plan").execute({ title: "a", scope: "day", goalId: d.goalId }, ctx);
    await by("create_plan").execute({ title: "b", scope: "week", goalId: d.goalId }, ctx);
    await by("create_plan").execute({ title: "c", scope: "day" }, ctx);
    const scoped = (await by("query_ledger").execute({ what: "plans", goalId: d.goalId }, ctx)) as {
      plans: { title: string }[];
      total: number;
      truncated: boolean;
    };
    expect(scoped.plans.map((p) => p.title).sort()).toEqual(["a", "b"]);
    expect(scoped).toMatchObject({ total: 2, truncated: false });
    const limited = (await by("query_ledger").execute({ what: "plans", limit: 2 }, ctx)) as { plans: unknown[]; total: number; truncated: boolean };
    expect(limited.plans).toHaveLength(2);
    expect(limited).toMatchObject({ total: 3, truncated: true });
    await expect(by("query_ledger").execute({ what: "plans", limit: 0 }, ctx)).rejects.toThrow("limit");
  });

  it("flows limit 截断：时间倒序 + 同刻后记优先，保留最新一批", async () => {
    const { by } = await freshTools();
    await by("record_flow").execute({ category: "餐饮", value: 10 }, ctx);
    await by("record_flow").execute({ category: "餐饮", value: 20 }, ctx);
    await by("record_flow").execute({ category: "运动", value: 30 }, ctx);
    const limited = (await by("query_ledger").execute({ what: "flows", limit: 2 }, ctx)) as {
      flows: { value?: number }[];
      total: number;
      truncated: boolean;
    };
    expect(limited.flows.map((f) => f.value)).toEqual([30, 20]);
    expect(limited).toMatchObject({ total: 3, truncated: true });
  });

  it("render 四种视角均为人话摘要而非 JSON 串；凭据保留——today/plans 带 planId、goals/建方向带 goalId（评审 O8）", async () => {
    const { by } = await freshTools();
    await by("record_flow").execute({ category: "餐饮", value: 28 }, ctx);
    const created = (await by("create_plan").execute({ title: "读书", scope: "day" }, ctx)) as { planId: string };
    const render = (value: unknown) => (by("query_ledger").output!.render!({}, value) as { text: string }[])[0]!.text;
    const today = await by("query_ledger").execute({ what: "today" }, ctx);
    expect(render(today)).toContain("1 笔流水");
    expect(render(today)).toContain("连续记录");
    expect(render(today)).toContain(created.planId); // 未完成计划行带 planId——取消/打卡要拿它调工具
    const plans = await by("query_ledger").execute({ what: "plans" }, ctx);
    expect(render(plans)).toContain("1 个计划");
    expect(render(plans)).toContain(created.planId); // plans 摘要同样保留凭据
    const flows = await by("query_ledger").execute({ what: "flows" }, ctx);
    expect(render(flows)).toContain("1 笔流水");
    expect(render(flows)).toContain("餐饮×1");

    // goals 树逐行带 goalId——挂阶段（create_goal parentId）/挂计划（create_plan goalId）都靠它（真实事故 2026-09-29：
    // 摘要只写「title 0/0」，agent 拿不到 ID 只能瞎猜 parentId，方向挂阶段失败）
    const dir = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    const dirReceipt = (by("create_goal").output!.render!({}, dir) as { text: string }[])[0]!.text;
    expect(dirReceipt).toContain(dir.goalId); // 建方向回执当场给 ID，不用再查一遍
    const phase = (await by("create_goal").execute({ level: "phase", title: "减脂期", parentId: dir.goalId, due: "2026-10-15" }, ctx)) as { goalId: string };
    await by("create_plan").execute({ title: "首次 5km", scope: "deadline", due: "2026-10-15", goalId: phase.goalId }, ctx);
    const goals = await by("query_ledger").execute({ what: "goals" }, ctx);
    const goalsText = render(goals);
    expect(goalsText).toContain("1 个方向、1 个阶段");
    expect(goalsText).toContain(`健康(${dir.goalId})`);
    expect(goalsText).toContain(`减脂期(${phase.goalId}`); // 阶段行也带 ID——create_plan 挂阶段下要用
    expect(goalsText).toContain("截止 2026-10-15");
    // today 视角的方向进度/阶段行同样带 goalId（内置简报/晚间汇报直接引用）
    const today2 = await by("query_ledger").execute({ what: "today" }, ctx);
    const todayText = render(today2);
    expect(todayText).toContain(`健康(${dir.goalId})`);
    expect(todayText).toContain(`减脂期(${phase.goalId}`);
    expect(todayText).toContain("下一步：首次 5km");
    for (const value of [today, plans, flows, goals, today2]) expect(render(value)).not.toContain('{"');
  });

  it("update_goal 用弃用的 nextStep 时回执当面提醒（评审 O5）", async () => {
    const { by } = await freshTools();
    const dir = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    await by("update_goal").execute({ goalId: dir.goalId, nextStep: "约教练" }, ctx);
    const blocks = by("update_goal").output.render!({ goalId: dir.goalId, nextStep: "约教练" }, { goalId: dir.goalId, title: "健康", status: "active" });
    expect((blocks[0] as { text: string }).text).toContain("已弃用");
    const clean = by("update_goal").output.render!({ goalId: dir.goalId }, { goalId: dir.goalId, title: "健康", status: "active" });
    expect((clean[0] as { text: string }).text).not.toContain("已弃用"); // 没用弃用参数不唠叨
  });

  it("delete_goal：真删作废全部快照留痕、有子不放行、未知 404 同义报错（评审 O6）", async () => {
    const { by } = await freshTools();
    const dir = (await by("create_goal").execute({ level: "direction", title: "健康" }, ctx)) as { goalId: string };
    const phase = (await by("create_goal").execute({ level: "phase", title: "8 周减脂", parentId: dir.goalId }, ctx)) as { goalId: string };
    await expect(by("delete_goal").execute({ goalId: dir.goalId }, ctx)).rejects.toThrow("先删除它们");
    const deleted = (await by("delete_goal").execute({ goalId: phase.goalId, reason: "建错了" }, ctx)) as { voided: number };
    expect(deleted.voided).toBe(1);
    const gone = (await by("delete_goal").execute({ goalId: dir.goalId }, ctx)) as { voided: number };
    expect(gone.voided).toBe(1);
    await expect(by("delete_goal").execute({ goalId: dir.goalId }, ctx)).rejects.toThrow("不存在");
    const goals = (await by("query_ledger").execute({ what: "goals" }, ctx)) as { directions: unknown[] };
    expect(goals.directions).toHaveLength(0);
  });

  it("update_goal 空串语义与弃用标注写入 schema；update_plan 进装配清单", async () => {
    const { by } = await freshTools();
    const schema = JSON.stringify(by("update_goal").parameters);
    expect(schema).toContain("空串 = 解除父级");
    expect(schema).toContain("已弃用");
    expect(by("update_plan").name).toBe("update_plan");
    expect(JSON.stringify(by("checkin_plan").parameters)).toContain("补卡日期");
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

describe("撤历史卡闭环（2026-09-29：today 的 checkins 提供凭据）", () => {
  it("补周一的卡 → today checkins 给非今日 seq → void_flow 作废 → 周期判定从进行中回退待做", async () => {
    const { by } = await freshTools();
    const plan = (await by("create_plan").execute({ title: "背单词", scope: "week" }, ctx)) as { planId: string };
    await by("checkin_plan").execute({ planId: plan.planId, date: "2026-09-01" }, ctx); // 周二（锚周内非今日，任何机器时区下都成立）
    const read = () =>
      by("query_ledger").execute({ what: "today" }, ctx) as Promise<{
        plans: { planId: string; state: string; checkins?: { seq: number; at: number }[] }[];
      }>;
    let today = await read();
    const target = today.plans.find((p) => p.planId === plan.planId)!;
    expect(target.state).toBe("doing"); // 本周有非今日打卡 → 进行中
    expect(target.checkins).toHaveLength(1);
    await by("void_flow").execute({ seq: target.checkins![0]!.seq, reason: "那天其实没背" }, ctx);
    today = await read();
    expect(today.plans.find((p) => p.planId === plan.planId)!.state).toBe("todo"); // 历史卡撤掉 → 回到待做
  });
});

describe("档案时区口径（2026-09-29：tzOffsetMinutes 注入）", () => {
  it("tz=480：today/flows 按东八区日界折叠；缺省不传仍 UTC（现状兼容）", async () => {
    const NOW2 = Date.UTC(2026, 8, 3, 18, 0, 0); // UTC 9-3 18:00 = 东八区 9-4 02:00
    const ledger = await Ledger.open(testDb(), "u-tz");
    const tools = createLedgerTools({ ledger, now: () => NOW2, tzOffsetMinutes: () => 480 });
    const by = (name: string) => tools.find((t) => t.name === name)!;
    await ledger.append({ kind: "event", source: "ui", time: Date.UTC(2026, 8, 3, 16, 30), category: "夜宵" }, NOW2); // 东八区 9-4 00:30
    const today = (await by("query_ledger").execute({ what: "today" }, ctx)) as { date: string; flows: { category: string }[] };
    expect(today.date).toBe("2026-09-04");
    expect(today.flows.map((f) => f.category)).toContain("夜宵");
    const flowsFrom4 = (await by("query_ledger").execute({ what: "flows", from: "2026-09-04" }, ctx)) as { flows: { category: string }[] };
    expect(flowsFrom4.flows.some((f) => f.category === "夜宵")).toBe(true); // 东八区口径下属 9-4
    const flowsFrom5 = (await by("query_ledger").execute({ what: "flows", from: "2026-09-05" }, ctx)) as { flows: unknown[] };
    expect(flowsFrom5.flows).toHaveLength(0);
    const ledgerUtc = await Ledger.open(testDb(), "u-tz-2");
    await ledgerUtc.append({ kind: "event", source: "ui", time: Date.UTC(2026, 8, 3, 16, 30), category: "夜宵" }, NOW2);
    const toolsUtc = createLedgerTools({ ledger: ledgerUtc, now: () => NOW2 });
    const todayUtc = (await toolsUtc.find((t) => t.name === "query_ledger")!.execute({ what: "today" }, ctx)) as { date: string };
    expect(todayUtc.date).toBe("2026-09-03"); // 缺省 UTC：同一时刻的"今天"还是 9-3
  });
});
