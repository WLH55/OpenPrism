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
  it("七工具齐备（目标层级 2026-09-30 下线，goal 三件移除）；写工具 exclusive、查询 parallel", async () => {
    const { tools, by } = await freshTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_plan",
      "checkin_plan",
      "create_plan",
      "query_ledger",
      "record_flow",
      "update_plan",
      "void_flow",
    ]);
    expect(by("record_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("void_flow").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("update_plan").isConcurrencySafe?.({})).toBeFalsy();
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

describe("目标层级下线（2026-09-30 SDD）：goal 工具不存在、goalId 入参明确报错、what=goals 下线", () => {
  it("create_plan/update_plan 传 goalId → 明确报错而非静默忽略（防老对话上下文错行为）", async () => {
    const { by } = await freshTools();
    await expect(by("create_plan").execute({ title: "里程碑", scope: "deadline", due: "2026-10-15", goalId: "goal-any" }, ctx)).rejects.toThrow("已下线");
    const plan = (await by("create_plan").execute({ title: "日记", scope: "day" }, ctx)) as { planId: string };
    await expect(by("update_plan").execute({ planId: plan.planId, goalId: "goal-any" }, ctx)).rejects.toThrow("已下线");
    await expect(by("update_plan").execute({ planId: plan.planId, goalId: "" }, ctx)).rejects.toThrow("已下线"); // 空串（原"解除挂载"语义）同样拒绝
  });

  it("query_ledger what=goals 报未知视角；schema 无 goalId 参数", async () => {
    const { by } = await freshTools();
    await expect(by("query_ledger").execute({ what: "goals" }, ctx)).rejects.toThrow("today | plans | flows");
    expect(JSON.stringify(by("create_plan").parameters)).not.toContain("goalId");
    expect(JSON.stringify(by("update_plan").parameters)).not.toContain("goalId");
    expect(JSON.stringify(by("query_ledger").parameters)).not.toContain("goalId");
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

  it("修订剥离历史 goalId（目标层级下线）：修订后的新版本不带 goalId，已打的卡不因修订丢失", async () => {
    const { ledger, by } = await freshTools();
    // 直写一笔带 goalId 的历史计划（工具面已无法产生，模拟存量数据）
    const legacy = await ledger.append({ kind: "plan", source: "ui", planId: "plan-legacy01", title: "挂过树的旧打卡点", scope: "deadline", due: "2026-10-01", goalId: "goal-dead" }, 1000);
    await by("checkin_plan").execute({ planId: "plan-legacy01" }, ctx);
    await by("update_plan").execute({ planId: "plan-legacy01", title: "改名后的旧打卡点" }, ctx);
    const after = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: { planId: string; title: string; goalId?: string }[] };
    const row = after.plans.find((p) => p.planId === "plan-legacy01")!;
    expect(row.title).toBe("改名后的旧打卡点");
    expect(row.goalId).toBeUndefined(); // 修订即降级为独立计划（goalId 剥离）
    const today = (await by("query_ledger").execute({ what: "today" }, ctx)) as { plans: { planId: string; state: string }[] };
    expect(today.plans.find((p) => p.planId === "plan-legacy01")!.state).toBe("done"); // 打卡史保留
    expect(ledger.readAll().some((r) => r.seq === legacy.seq && r.kind === "plan")).toBe(true); // 旧行留痕未删
  });

  it("报错路径：planId 不存在 / scope 换 deadline 缺 due", async () => {
    const { by } = await freshTools();
    await expect(by("update_plan").execute({ planId: "plan-nope", title: "x" }, ctx)).rejects.toThrow("不存在");
    const plan = (await by("create_plan").execute({ title: "日记", scope: "day" }, ctx)) as { planId: string };
    await expect(by("update_plan").execute({ planId: plan.planId, scope: "deadline" }, ctx)).rejects.toThrow("due");
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

  it("void_flow 指向 plan/goal seq → 报错引导专用工具/历史休眠", async () => {
    const { ledger, by } = await freshTools();
    await by("create_plan").execute({ title: "跑步", scope: "day" }, ctx);
    const planSeq = ledger.activeRecords().find((r) => r.kind === "plan")!.seq;
    await expect(by("void_flow").execute({ seq: planSeq }, ctx)).rejects.toThrow("cancel_plan");
    // 历史 goal 行休眠保留（目标层级下线）：不可作废，报错明说
    const goal = await ledger.append({ kind: "goal", source: "ui", goalId: "goal-hist", level: "direction", title: "健康", status: "active" }, 1000);
    await expect(by("void_flow").execute({ seq: goal.seq }, ctx)).rejects.toThrow("已下线");
  });
});

describe("query_ledger 过滤限量 + 人话回执（2026-09-29）", () => {
  it("plans 全量列出（goalId 过滤随目标层级下线）；limit 截断带 total/truncated；limit 非法拒绝", async () => {
    const { by } = await freshTools();
    await by("create_plan").execute({ title: "a", scope: "day" }, ctx);
    await by("create_plan").execute({ title: "b", scope: "week" }, ctx);
    await by("create_plan").execute({ title: "c", scope: "day" }, ctx);
    const all = (await by("query_ledger").execute({ what: "plans" }, ctx)) as { plans: { title: string }[]; total: number; truncated: boolean };
    expect(all.plans.map((p) => p.title).sort()).toEqual(["a", "b", "c"]);
    expect(all).toMatchObject({ total: 3, truncated: false });
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

  it("render 三视角均为人话摘要而非 JSON 串；凭据保留——today/plans 带 planId（评审 O8；goals 视角随目标层级下线）", async () => {
    const { by } = await freshTools();
    await by("record_flow").execute({ category: "餐饮", value: 28 }, ctx);
    const created = (await by("create_plan").execute({ title: "读书", scope: "day" }, ctx)) as { planId: string };
    const render = (value: unknown) => (by("query_ledger").output!.render!({}, value) as { text: string }[])[0]!.text;
    const today = await by("query_ledger").execute({ what: "today" }, ctx);
    expect(render(today)).toContain("1 笔流水");
    expect(render(today)).toContain("连续记录");
    expect(render(today)).toContain(created.planId); // 未完成计划行带 planId——取消/打卡要拿它调工具
    expect(render(today)).not.toContain("方向进度"); // 目标层级话术零残留
    expect(render(today)).not.toContain("阶段：");
    const plans = await by("query_ledger").execute({ what: "plans" }, ctx);
    expect(render(plans)).toContain("1 个计划");
    expect(render(plans)).toContain(created.planId); // plans 摘要同样保留凭据
    const flows = await by("query_ledger").execute({ what: "flows" }, ctx);
    expect(render(flows)).toContain("1 笔流水");
    expect(render(flows)).toContain("餐饮×1");
    for (const value of [today, plans, flows]) expect(render(value)).not.toContain('{"');
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
