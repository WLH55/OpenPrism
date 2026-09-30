// 计划折叠（2026-09-30 目标层级下线，SDD 2026-09-30_00-29）：PlanState 状态机 / doneSeqs 撤销口径 /
// doneToday 与 done 分离 / 30 天存档窗口 / top3 三终端（逾期 > 今日截止 > 覆盖今天的未完成，无补位）。
// goal 持久化测试保留——历史 goal 行休眠在账本里，Ledger.open 必须仍能读回（服务器真实数据依赖）。

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { top3, todayView } from "../src/app/fold";
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

describe("top3", () => {
  it("排序：逾期 > 今日截止 > 覆盖今天的未完成，封顶 3；今日已 done 不进", () => {
    const items = top3(
      records(
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "a", title: "过期任务", scope: "deadline", due: "2026-09-26" },
        { kind: "plan", ts: NOW - 8000, source: "ui", planId: "b", title: "今日截止任务", scope: "deadline", due: TODAY },
        { kind: "plan", ts: NOW - 7000, source: "ui", planId: "c", title: "今日计划", scope: "day" },
        { kind: "plan", ts: NOW - 6000, source: "ui", planId: "d", title: "已完成的今日计划", scope: "day" },
        { kind: "plan", ts: NOW - 5000, source: "ui", planId: "e", title: "多余候选", scope: "day" },
        { kind: "checkin", ts: NOW - 4000, source: "ui", planId: "d", at: NOW - 4000, done: true },
      ),
      NOW,
      TZ,
    );
    expect(items.map((i) => i.kind)).toEqual(["overdue", "dueToday", "today"]);
    expect(items.map((i) => i.title)).toEqual(["过期任务", "今日截止任务", "今日计划"]);
  });

  it("无补位终端（目标层级 2026-09-30 下线）：候选不足 3 就短着，未来的 deadline 不顶上来", () => {
    const items = top3(
      records(
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "future", title: "明天的任务", scope: "deadline", due: "2026-09-29" },
        { kind: "plan", ts: NOW - 8000, source: "ui", planId: "next-week", title: "下周的任务", scope: "deadline", due: "2026-10-05" },
      ),
      NOW,
      TZ,
    );
    expect(items).toEqual([]); // 历史上的 goal 挂树计划（goalId 残留）也一样：只按计划本体判定
    const withLegacyGoalId = top3(
      records(
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "legacy", title: "挂过树的旧打卡点", scope: "deadline", due: "2026-09-26", goalId: "goal-dead" },
      ),
      NOW,
      TZ,
    );
    expect(withLegacyGoalId).toHaveLength(1); // goalId 被投影层忽略——逾期照常进 top3（AC4 口径）
    expect(withLegacyGoalId[0]).not.toHaveProperty("goalTitle");
  });
});

describe("todayView 计划折叠", () => {
  it("计划状态折叠（2026-09-28 用户验收）：已过期收编且排最前；未开始/进行中/待做/已完成各就各位；历史完成且已过期的沉出", () => {    const view = todayView(
      records(
        { kind: "plan", ts: NOW - 90000, source: "ui", planId: "a", title: "逾期任务", scope: "deadline", due: "2026-09-26" },
        { kind: "plan", ts: NOW - 80000, source: "ui", planId: "b", title: "今日截止", scope: "deadline", due: TODAY },
        { kind: "plan", ts: NOW - 70000, source: "ui", planId: "c", title: "明天的任务", scope: "deadline", due: "2026-09-29" },
        { kind: "plan", ts: Date.UTC(2026, 8, 10), source: "ui", planId: "d", title: "上月做完的旧任务", scope: "deadline", due: "2026-09-09" },
        { kind: "checkin", ts: Date.UTC(2026, 8, 10, 2), source: "ui", planId: "d", at: Date.UTC(2026, 8, 10, 2), done: true },
        { kind: "plan", ts: Date.UTC(2026, 8, 20), source: "ui", planId: "e", title: "月度习惯", scope: "month" },
        { kind: "checkin", ts: Date.UTC(2026, 8, 25, 2), source: "ui", planId: "e", at: Date.UTC(2026, 8, 25, 2), done: true },
        { kind: "plan", ts: NOW - 60000, source: "ui", planId: "f", title: "今日习惯", scope: "day" },
        { kind: "plan", ts: NOW - 50000, source: "ui", planId: "g", title: "已完成的未来任务", scope: "deadline", due: "2026-10-02" },
        { kind: "checkin", ts: NOW - 1000, source: "ui", planId: "g", at: NOW - 1000, done: true },
      ),
      NOW,
      TZ,
    );
    // 顺序：逾期 > 今天截止 > 进行中（月内做过、今日未做）> 待做 > 未开始（明天）> 已完成（含历史存档，2026-09-29 全量收编）
    expect(view.plans.map((p) => p.state)).toEqual(["overdue", "dueToday", "doing", "todo", "upcoming", "done", "done"]);
    expect(view.plans.map((p) => p.planId)).toEqual(["a", "b", "e", "f", "c", "d", "g"]);
    expect(view.plans.every((p) => typeof p.seq === "number")).toBe(true); // 跳过（作废 plan）定位用
    const d = view.plans.find((p) => p.planId === "d")!;
    expect(d.doneAt).toBe(Date.UTC(2026, 8, 10, 2)); // 完成时刻 = 最新 done 打卡 at（已完成视图排序/过滤用）
    const g = view.plans.find((p) => p.planId === "g")!;
    expect(g.done).toBe(true);
    expect(g.doneSeqs).toHaveLength(1); // 撤销 = 作废该打卡（与计划页同规）
  });

  it("挂树历史计划降级为独立待办（目标层级下线，AC4 口径）：goalId 残留被投影层忽略，不带 goalTitle，状态机照常", () => {
    const view = todayView(
      records(
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "m1", title: "约教练做体测", scope: "deadline", due: "2026-10-02", goalId: "goal-dead" },
        { kind: "plan", ts: NOW - 8000, source: "ui", planId: "t1", title: "买手机壳", scope: "deadline", due: "2026-09-29" },
      ),
      NOW,
      TZ,
    );
    const m1 = view.plans.find((p) => p.planId === "m1")!;
    expect(m1.state).toBe("upcoming");
    expect(m1).not.toHaveProperty("goalTitle"); // 「属于：xx」信号随目标层级一起下线
    expect(view.plans.every((p) => !("goalTitle" in p))).toBe(true);
    expect("goalCard" in view).toBe(false); // 顶层 goalCard 键随目标层级消失（回归锚）
  });

  it("撤销口径与存档窗口（评审 2026-09-29）：周期型今日完成带今日打卡 seq（撤销=作废今日）；完成超 30 天的存档沉出载荷", () => {
    const view = todayView(
      records(
        { kind: "plan", ts: NOW - 9000, source: "ui", planId: "h1", title: "每日习惯", scope: "day" },
        { kind: "checkin", ts: NOW - 1000, source: "ui", planId: "h1", at: NOW - 1000, done: true },
        { kind: "plan", ts: NOW - 50000, source: "ui", planId: "old", title: "老存档", scope: "deadline", due: "2026-08-01" },
        { kind: "checkin", ts: Date.UTC(2026, 7, 20, 2), source: "ui", planId: "old", at: Date.UTC(2026, 7, 20, 2), done: true },
      ),
      NOW,
      TZ,
    );
    const h1 = view.plans.find((p) => p.planId === "h1")!;
    expect(h1.state).toBe("done");
    expect(h1.doneSeqs).toHaveLength(1); // 周期型=今日存活 done 打卡 seq（不是全历史——撤销只退今天）
    expect(h1.doneToday).toBe(true); // #14：今天完成的确定性标记
    expect(view.plans.some((p) => p.planId === "old")).toBe(false); // doneAt 39 天前 → 30 天窗口外沉出（agent 面/载荷界）
  });

  it("doneToday 与 done 分离（评审 #14）：上周完成的任务 state=done 但 doneToday=false——晚间汇报不再把历史完成算进今天", () => {
    const view = todayView(
      records(
        { kind: "plan", ts: NOW - 90000, source: "ui", planId: "m-old", title: "上周做完的任务", scope: "deadline", due: "2026-09-25" },
        { kind: "checkin", ts: NOW - 3 * 86400000, source: "ui", planId: "m-old", at: NOW - 3 * 86400000, done: true },
      ),
      NOW,
      TZ,
    );
    const m = view.plans.find((p) => p.planId === "m-old")!;
    expect(m.state).toBe("done");
    expect(m.done).toBe(true); // deadline 的 done = doneEver
    expect(m.doneToday).toBe(false); // 但不是今天完成的
  });
});

describe("goal 持久化（历史数据休眠保留，2026-09-30 下线）", () => {
  it("roundtrip：历史 goal 行/带 goalId 的 plan 重开账本字段完整——Ledger.open 读服务器真实数据不炸", async () => {
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

  it("ensureGoalKind：旧 schema（CHECK 无 goal、无 goal 列）重建后旧数据保留、goal 行可读", () => {
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
    // goal 行可写入可读回（持久层对历史 kind 的兼容不随功能下线消失）
    insertLedgerRecord(db, "u1", { kind: "goal", seq: 1, ts: 200, source: "ui", goalId: "g1", level: "direction", title: "健康", status: "active" });
    const goalRow = db.prepare("SELECT kind, goal_id, g_status FROM ledger_entries WHERE uid = 'u1' AND seq = 1").get() as unknown as { kind: string; goal_id: string; g_status: string };
    expect(goalRow).toEqual({ kind: "goal", goal_id: "g1", g_status: "active" });
  });
});
