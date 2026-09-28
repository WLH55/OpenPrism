// B1·goal：目标层级折叠（SDD 2026-09-28 个人工作台业务借鉴 §4）——
// 快照胜出（修订=追加最新）、void 仅真删、层级冒泡聚合、里程碑/周期双口径、软约束 warning、Top3 排序。

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { goalView, top3, todayView } from "../src/app/fold";
import { insertLedgerRecord, Ledger, type GoalRecord, type LedgerAppend, type LedgerRecord } from "../src/app/ledger";
import { ensureGoalKind, openDb } from "../src/app/db";

// 固定时间锚（UTC 毫秒）：2026-09-28 04:00 UTC = 当地（UTC+8）12:00 周一
const TZ = 480;
const NOW = Date.UTC(2026, 8, 28, 4, 0, 0);
const TODAY = "2026-09-28";

// 便利构造：seq 自动编号；ts = 记录落账时间
function records(...items: Array<LedgerAppend & { ts: number }>): LedgerRecord[] {
  return items.map((item, seq) => ({ ...item, seq }) as LedgerRecord);
}

const mkGoal = (goalId: string, ts: number, extra: Partial<GoalRecord> = {}): LedgerAppend & { ts: number } => ({
  kind: "goal",
  ts,
  source: "ui",
  goalId,
  level: "direction",
  title: goalId,
  status: "active",
  ...extra,
});

describe("goalView", () => {
  it("快照胜出：同 goalId 多条，最新 ts 的 title/status/nextStep 生效", () => {
    const view = goalView(
      records(
        mkGoal("g1", 100, { title: "学好英语", status: "active" }),
        mkGoal("g1", 200, { title: "学好英语（修订）", status: "paused", nextStep: "每天背 20 词" }),
      ),
      NOW,
      TZ,
    );
    expect(view.directions).toHaveLength(1);
    const node = view.directions[0]!;
    expect(node.title).toBe("学好英语（修订）");
    expect(node.status).toBe("paused");
    expect(node.nextStep).toBe("每天背 20 词");
    expect(node.updatedAt).toBe(200);
  });

  it("void 仅真删：void 掉最新快照则回退前一条，全 void 则消失", () => {
    const rs = records(
      mkGoal("g1", 100, { title: "v1" }),
      mkGoal("g1", 200, { title: "v2" }),
      { kind: "void", ts: 300, source: "ui", targetSeq: 1 }, // 作废 v2（seq=1）
    );
    expect(goalView(rs, NOW, TZ).directions[0]!.title).toBe("v1");

    const gone = goalView(
      records(
        mkGoal("g1", 100),
        { kind: "void", ts: 300, source: "ui", targetSeq: 0 },
      ),
      NOW,
      TZ,
    );
    expect(gone.directions).toHaveLength(0);
  });

  it("层级冒泡：project 上的里程碑进度聚合到 phase 与 direction", () => {
    const view = goalView(
      records(
        mkGoal("d1", 1, { level: "direction", title: "健康" }),
        mkGoal("p1", 2, { level: "phase", parentId: "d1", title: "8 周减脂" }),
        mkGoal("pr1", 3, { level: "project", parentId: "p1", title: "跑步计划" }),
        { kind: "plan", ts: 4, source: "ui", planId: "m1", title: "里程碑A", scope: "deadline", due: "2026-10-15", goalId: "pr1" },
        { kind: "plan", ts: 5, source: "ui", planId: "m2", title: "里程碑B", scope: "deadline", due: "2026-11-01", goalId: "pr1" },
        { kind: "checkin", ts: 6, source: "ui", planId: "m1", at: NOW - 1000, done: true },
      ),
      NOW,
      TZ,
    );
    expect(view.directions).toHaveLength(1);
    const direction = view.directions[0]!;
    expect(direction.level).toBe("direction");
    const phase = direction.children[0]!;
    expect(phase.level).toBe("phase");
    expect(phase.children[0]!.level).toBe("project");
    // 三个层级 progress 同源（自底向上冒泡）
    for (const node of [direction, phase, phase.children[0]!]) {
      expect(node.progress).toEqual({ done: 1, total: 2, rate: 0.5 });
    }
  });

  it("plan.goalId 挂 direction 直接聚合；孤儿引用宽容跳过", () => {
    const view = goalView(
      records(
        mkGoal("d1", 1),
        { kind: "plan", ts: 2, source: "ui", planId: "m1", title: "里程碑", scope: "deadline", due: "2026-10-15", goalId: "d1" },
        { kind: "plan", ts: 3, source: "ui", planId: "m2", title: "幽灵归属", scope: "deadline", due: "2026-10-15", goalId: "ghost" },
      ),
      NOW,
      TZ,
    );
    expect(view.directions[0]!.progress).toEqual({ done: 0, total: 1, rate: 0 });
  });

  it("recurring 今日口径：覆盖今天且今日 done 才计入 doneToday", () => {
    const mkDayPlan = (planId: string, checkinAt: number | null) =>
      records(
        mkGoal("d1", 1),
        { kind: "plan", ts: NOW - 5000, source: "ui", planId, title: "晨跑", scope: "day", goalId: "d1" },
        ...(checkinAt !== null
          ? [{ kind: "checkin" as const, ts: checkinAt + 1, source: "ui" as const, planId, at: checkinAt, done: true }]
          : []),
      );
    expect(goalView(mkDayPlan("p1", NOW - 1000), NOW, TZ).directions[0]!.recurring).toEqual({ doneToday: 1, total: 1 });
    expect(goalView(mkDayPlan("p1", NOW - 86400000), NOW, TZ).directions[0]!.recurring).toEqual({ doneToday: 0, total: 1 });
    expect(goalView(mkDayPlan("p1", null), NOW, TZ).directions[0]!.recurring).toEqual({ doneToday: 0, total: 1 });
  });

  it("parentId 成环：双方上提为根，聚合不无限递归", () => {
    const view = goalView(
      records(
        mkGoal("a", 1, { level: "phase", parentId: "b" }),
        mkGoal("b", 2, { level: "phase", parentId: "a" }),
      ),
      NOW,
      TZ,
    );
    expect(view.directions.map((n) => n.goalId).sort()).toEqual(["a", "b"]);
  });

  it("软约束 warning：active 方向 >3 优先提示，否则看阶段；paused 不计数", () => {
    const mkDirections = (n: number) => records(...Array.from({ length: n }, (_, i) => mkGoal(`d${i}`, i + 1)));
    expect(goalView(mkDirections(4), NOW, TZ).warning).toContain("4 个方向");
    expect(goalView(mkDirections(3), NOW, TZ).warning).toBeUndefined();

    const fourPhases = records(
      ...Array.from({ length: 3 }, (_, i) => mkGoal(`d${i}`, i + 1)),
      ...Array.from({ length: 4 }, (_, i) => mkGoal(`p${i}`, 10 + i, { level: "phase", parentId: "d0" })),
    );
    expect(goalView(fourPhases, NOW, TZ).warning).toContain("4 个阶段");

    const pausedOnly = records(mkGoal("d0", 1, { status: "paused" }), mkGoal("d1", 2), mkGoal("d2", 3), mkGoal("d3", 4));
    expect(goalView(pausedOnly, NOW, TZ).activeDirectionCount).toBe(3);
    expect(goalView(pausedOnly, NOW, TZ).warning).toBeUndefined();
  });
});

describe("top3", () => {
  it("排序：逾期 > 今日截止 > 覆盖今天的未完成，封顶 3；今日已 done 不进", () => {
    const items = top3(
      records(
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "a", title: "过期里程碑", scope: "deadline", due: "2026-09-26" },
        { kind: "plan", ts: NOW - 8000, source: "ui", planId: "b", title: "今日截止里程碑", scope: "deadline", due: TODAY },
        { kind: "plan", ts: NOW - 7000, source: "ui", planId: "c", title: "今日计划", scope: "day" },
        { kind: "plan", ts: NOW - 6000, source: "ui", planId: "d", title: "已完成的今日计划", scope: "day" },
        { kind: "plan", ts: NOW - 5000, source: "ui", planId: "e", title: "多余候选", scope: "day" },
        { kind: "checkin", ts: NOW - 4000, source: "ui", planId: "d", at: NOW - 4000, done: true },
      ),
      NOW,
      TZ,
    );
    expect(items.map((i) => i.kind)).toEqual(["overdue", "dueToday", "today"]);
    expect(items.map((i) => i.title)).toEqual(["过期里程碑", "今日截止里程碑", "今日计划"]);
  });

  it("不足 3 用 active 阶段唯一下一步补位；goalTitle 沿链上溯到顶层方向", () => {
    const items = top3(
      records(
        mkGoal("d1", 1, { level: "direction", title: "健康" }),
        mkGoal("p1", 2, { level: "phase", parentId: "d1", title: "8 周减脂", nextStep: "约教练体测" }),
        { kind: "plan", ts: NOW - 7000, source: "ui", planId: "c", title: "今日计划", scope: "day", goalId: "p1" },
      ),
      NOW,
      TZ,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "today", title: "今日计划", goalTitle: "健康" });
    expect(items[1]).toMatchObject({ kind: "nextStep", title: "推进「8 周减脂」：约教练体测", goalTitle: "健康" });
  });

  it("统一执行项（2026-09-28）：下一步补位 = 阶段第一条未完成打卡点（带 planId 可打卡），打卡后让位第二条", () => {
    const base: Array<LedgerAppend & { ts: number }> = [
      mkGoal("d1", 1, { level: "direction", title: "健康" }),
      mkGoal("p1", 2, { level: "phase", parentId: "d1", title: "8 周减脂" }),
      { kind: "plan", ts: NOW - 9000, source: "ui", planId: "m1", title: "约教练做体测", scope: "deadline", due: "2026-10-02", goalId: "p1" },
      { kind: "plan", ts: NOW - 8000, source: "ui", planId: "m2", title: "完成首次 5km", scope: "deadline", due: "2026-10-20", goalId: "p1" },
    ];
    const before = top3(records(...base), NOW, TZ);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: "nextStep", planId: "m1", title: "约教练做体测", goalTitle: "健康" }); // due 最近的第一条，可打卡（有 planId）

    // m1 打卡（doneEver）后：第一条让位 m2
    const after = top3(
      records(...base, { kind: "checkin", ts: NOW - 7000, source: "ui", planId: "m1", at: NOW - 7000, done: true }),
      NOW,
      TZ,
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "nextStep", planId: "m2", title: "完成首次 5km" });
  });

  it("统一执行项：打卡点存在时旧 nextStep 文字不再补位（迁移后语义），打卡点全完成才兜底文字", () => {
    const items = top3(
      records(
        mkGoal("d1", 1, { level: "direction", title: "健康" }),
        mkGoal("p1", 2, { level: "phase", parentId: "d1", title: "8 周减脂", nextStep: "存量文字" }),
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "m1", title: "未来的打卡点", scope: "deadline", due: "2026-10-02", goalId: "p1" },
      ),
      NOW,
      TZ,
    );
    expect(items.map((i) => i.title)).toEqual(["未来的打卡点"]); // 不再出现"推进「…」：存量文字"
  });
});

describe("todayView 增补（B1）", () => {
  it("goalCard 取 3 个 active 方向 + due 最近的 3 个 active 阶段", () => {
    const view = todayView(
      records(
        mkGoal("d1", 1, { title: "方向一" }),
        mkGoal("d2", 2, { title: "方向二" }),
        mkGoal("d3", 3, { title: "方向三" }),
        mkGoal("d4", 4, { title: "方向四" }),
        mkGoal("p1", 5, { level: "phase", parentId: "d1", title: "近的阶段", due: "2026-10-01", nextStep: "下一步A" }),
        mkGoal("p2", 6, { level: "phase", parentId: "d2", title: "远的阶段", due: "2026-12-01", nextStep: "下一步B" }),
      ),
      NOW,
      TZ,
    );
    expect(view.goalCard.directions.map((d) => d.title)).toEqual(["方向一", "方向二", "方向三"]);
    expect(view.goalCard.phases.map((p) => p.title)).toEqual(["近的阶段", "远的阶段"]);
    expect(view.goalCard.warning).toContain("4 个方向");
    expect(view.top3).toHaveLength(2); // 两个 nextStep 补位
    expect(view.top3.every((i) => i.kind === "nextStep")).toBe(true);
  });

  it("统一执行项：goalCard 阶段 nextStep = 第一条未完成打卡点（与 Top3 补位同源）", () => {
    const view = todayView(
      records(
        mkGoal("d1", 1, { level: "direction", title: "健康" }),
        mkGoal("p1", 2, { level: "phase", parentId: "d1", title: "8 周减脂", nextStep: "存量文字" }),
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "m1", title: "约教练做体测", scope: "deadline", due: "2026-10-02", goalId: "p1" },
      ),
      NOW,
      TZ,
    );
    expect(view.goalCard.phases[0]).toMatchObject({ title: "8 周减脂", nextStep: "约教练做体测" });
  });

  it("计划状态折叠（2026-09-28 用户验收）：已过期收编且排最前；未开始/进行中/待做/已完成各就各位；历史完成且已过期的沉出", () => {
    const view = todayView(
      records(
        { kind: "plan", ts: NOW - 90000, source: "ui", planId: "a", title: "逾期打卡点", scope: "deadline", due: "2026-09-26" },
        { kind: "plan", ts: NOW - 80000, source: "ui", planId: "b", title: "今日截止", scope: "deadline", due: TODAY },
        { kind: "plan", ts: NOW - 70000, source: "ui", planId: "c", title: "明天的打卡点", scope: "deadline", due: "2026-09-29" },
        { kind: "plan", ts: Date.UTC(2026, 8, 10), source: "ui", planId: "d", title: "上月做完的旧打卡点", scope: "deadline", due: "2026-09-09" },
        { kind: "checkin", ts: Date.UTC(2026, 8, 10, 2), source: "ui", planId: "d", at: Date.UTC(2026, 8, 10, 2), done: true },
        { kind: "plan", ts: Date.UTC(2026, 8, 20), source: "ui", planId: "e", title: "月度习惯", scope: "month" },
        { kind: "checkin", ts: Date.UTC(2026, 8, 25, 2), source: "ui", planId: "e", at: Date.UTC(2026, 8, 25, 2), done: true },
        { kind: "plan", ts: NOW - 60000, source: "ui", planId: "f", title: "今日习惯", scope: "day" },
        { kind: "plan", ts: NOW - 50000, source: "ui", planId: "g", title: "已完成的未来打卡点", scope: "deadline", due: "2026-10-02" },
        { kind: "checkin", ts: NOW - 1000, source: "ui", planId: "g", at: NOW - 1000, done: true },
      ),
      NOW,
      TZ,
    );
    // 顺序：逾期 > 今天截止 > 进行中（月内做过、今日未做）> 待做 > 未开始（明天）> 已完成
    expect(view.plans.map((p) => p.state)).toEqual(["overdue", "dueToday", "doing", "todo", "upcoming", "done"]);
    expect(view.plans.map((p) => p.planId)).toEqual(["a", "b", "e", "f", "c", "g"]);
    expect(view.plans.some((p) => p.planId === "d")).toBe(false); // 历史完成且已过期 → 沉出今天列表
    const g = view.plans.find((p) => p.planId === "g")!;
    expect(g.done).toBe(true);
    expect(g.doneSeqs).toHaveLength(1); // 撤销 = 作废该打卡（与计划页同规）
  });
});

describe("goal 持久化与迁移（B1）", () => {
  it("roundtrip：append goal/带 goalId 的 plan → 重开账本字段完整、可选项缺省不出现", async () => {
    const db = openDb(":memory:");
    const ledger = await Ledger.open(db, "u1");
    const goal = await ledger.append(
      {
        kind: "goal",
        source: "agent",
        goalId: "g-1",
        level: "phase",
        parentId: "d-1",
        title: "8 周减脂",
        due: "2026-11-20",
        nextStep: "约教练",
        status: "active",
        actor: { conversationId: "c1", agentName: "助手" },
      },
      1234,
    );
    expect(goal.seq).toBe(0);
    const plan = await ledger.append(
      { kind: "plan", source: "ui", planId: "p-1", title: "晨跑", scope: "day", goalId: "g-1" },
      2000,
    );
    expect((plan as { goalId?: string }).goalId).toBe("g-1");

    const reopened = await Ledger.open(db, "u1");
    const all = reopened.readAll();
    const goalBack = all.find((r): r is GoalRecord => r.kind === "goal")!;
    expect(goalBack).toMatchObject({ goalId: "g-1", level: "phase", parentId: "d-1", title: "8 周减脂", due: "2026-11-20", nextStep: "约教练", status: "active" });
    expect(goalBack.actor?.agentName).toBe("助手");
    expect("why" in goalBack).toBe(false); // 未填可选项不出现（与旧 JSON 透传同构）
    const planBack = all.find((r) => r.kind === "plan") as { goalId?: string };
    expect(planBack.goalId).toBe("g-1");
  });

  it("ensureGoalKind：旧 schema（CHECK 无 goal、无 goal 列）重建后旧数据保留、goal 可写", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE ledger_entries (
        uid TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('event','plan','checkin','void')),
        ts INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('agent','ui')),
        actor_conv TEXT, actor_agent TEXT, time INTEGER, category TEXT, note TEXT, value REAL, unit TEXT, attrs_json TEXT,
        plan_id TEXT, title TEXT, scope TEXT, due TEXT, ndays INTEGER,
        checkin_plan_id TEXT, at INTEGER, done INTEGER, target_seq INTEGER, reason TEXT,
        PRIMARY KEY (uid, seq)
      );
      INSERT INTO ledger_entries (uid, seq, kind, ts, source, plan_id, title, scope) VALUES ('u1', 0, 'plan', 100, 'ui', 'p-1', '旧计划', 'day');
    `);
    ensureGoalKind(db);
    ensureGoalKind(db); // 幂等
    // 旧数据原样保留
    const oldRow = db.prepare("SELECT plan_id, title FROM ledger_entries WHERE uid = 'u1' AND seq = 0").get() as unknown as { plan_id: string; title: string };
    expect(oldRow).toEqual({ plan_id: "p-1", title: "旧计划" });
    // goal 可写入可读回
    insertLedgerRecord(db, "u1", { kind: "goal", seq: 1, ts: 200, source: "ui", goalId: "g1", level: "direction", title: "健康", status: "active" });
    const goalRow = db.prepare("SELECT kind, goal_id, g_status FROM ledger_entries WHERE uid = 'u1' AND seq = 1").get() as unknown as { kind: string; goal_id: string; g_status: string };
    expect(goalRow).toEqual({ kind: "goal", goal_id: "g1", g_status: "active" });
  });
});
