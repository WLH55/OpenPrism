// 批次1·fold：今天页确定性折叠（0 token）——今日流水/计划打卡态/分类合计/streak，全固定时间戳 + 时区注入。

import { describe, expect, it } from "vitest";
import { planScopeCoversToday, todayView } from "../src/app/fold";
import type { LedgerAppend, LedgerRecord, PlanRecord } from "../src/app/ledger";

// 固定时间锚（UTC 毫秒）：2026-09-03 12:00 UTC = 当地（UTC+8）2026-09-03 20:00 周四
const TZ = 480;
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const DAY = 86400000;

// 便利构造：seq 自动编号；ts = 记录落账时间（计划即创建时间）
type WithTs<T> = T extends unknown ? T & { ts: number } : never;
function records(...items: Array<WithTs<LedgerAppend>>): LedgerRecord[] {
  return items.map((item, seq) => ({ ...item, seq }) as LedgerRecord);
}

const mkPlan = (extra: Partial<PlanRecord>, createdTs: number): PlanRecord =>
  ({
    kind: "plan",
    ts: createdTs,
    source: "ui",
    planId: "p",
    title: "t",
    ...extra,
  }) as PlanRecord;

describe("todayView", () => {
  it("只取当地今天的流水，按时间升序；昨日流水不进", () => {
    const view = todayView(
      records(
        { kind: "event", ts: 1, source: "ui", time: Date.UTC(2026, 8, 3, 2, 0), category: "运动", value: 30, unit: "分钟" }, // 当地 10:00
        { kind: "event", ts: 2, source: "ui", time: Date.UTC(2026, 8, 3, 6, 0), category: "餐饮", value: 28, unit: "¥" }, // 当地 14:00
        { kind: "event", ts: 3, source: "ui", time: Date.UTC(2026, 8, 2, 23, 30), category: "餐饮", value: 46, unit: "¥" }, // UTC 9-2 23:30 = 当地 9-3 07:30，属今天
        { kind: "event", ts: 4, source: "ui", time: Date.UTC(2026, 8, 2, 10, 0), category: "餐饮", value: 18, unit: "¥" }, // 当地 9-2 18:00，昨天
      ),
      NOW,
      TZ,
    );
    expect(view.date).toBe("2026-09-03");
    expect(view.flows.map((f) => f.value)).toEqual([46, 30, 28]);
  });

  it("totalByCategory 聚合今天：合计 + 笔数，按合计降序", () => {
    const view = todayView(
      records(
        { kind: "event", ts: 1, source: "ui", time: NOW - 7200000, category: "餐饮", value: 28 },
        { kind: "event", ts: 2, source: "ui", time: NOW - 7100000, category: "餐饮", value: 18 },
        { kind: "event", ts: 3, source: "ui", time: NOW - 7000000, category: "运动", value: 1 },
      ),
      NOW,
      TZ,
    );
    expect(view.totalByCategory).toEqual([
      { category: "餐饮", total: 46, count: 2 },
      { category: "运动", total: 1, count: 1 },
    ]);
  });

  it("计划打卡态：今天有 done 打卡则 done=true 且带 checkinTs；昨天的打卡不算", () => {
    const view = todayView(
      records(
        { kind: "plan", ts: NOW - 3600000, source: "agent", planId: "p1", title: "晨跑", scope: "day" },
        { kind: "plan", ts: NOW - 3500000, source: "ui", planId: "p2", title: "读书", scope: "day" },
        { kind: "checkin", ts: NOW - 3000000, source: "agent", planId: "p1", at: Date.UTC(2026, 8, 3, 1, 0), done: true }, // 当地 9-3 09:00，今天
        { kind: "checkin", ts: NOW - 2900000, source: "ui", planId: "p2", at: Date.UTC(2026, 8, 2, 5, 0), done: true }, // 当地 9-2 13:00，昨天 → 不算
      ),
      NOW,
      TZ,
    );
    expect(view.plans.find((p) => p.planId === "p1")!.done).toBe(true);
    expect(view.plans.find((p) => p.planId === "p1")!.checkinTs).toBe(Date.UTC(2026, 8, 3, 1, 0));
    expect(view.plans.find((p) => p.planId === "p2")!.done).toBe(false);
  });

  it("streak：连续自然日；今天没记则从昨天起算；断了归零", () => {
    const mk = (dayBack: number): LedgerRecord =>
      ({ kind: "event", seq: 0, ts: 1, source: "ui", time: NOW - dayBack * DAY, category: "x" }) as LedgerRecord;
    expect(todayView(records(mk(0), mk(1), mk(2)), NOW, TZ).streakDays).toBe(3);
    expect(todayView(records(mk(1), mk(2)), NOW, TZ).streakDays).toBe(2); // 今天还没记，streak 活到明天
    expect(todayView(records(mk(0), mk(2)), NOW, TZ).streakDays).toBe(1); // 昨天断了，只算今天
    expect(todayView(records(mk(2)), NOW, TZ).streakDays).toBe(0); // 昨天也没有 → 断
  });

  it("void 剔除：被作废的流水不进今天视图", () => {
    const view = todayView(
      records(
        { kind: "event", ts: 1, source: "ui", time: NOW - 1000, category: "餐饮", value: 99 },
        { kind: "void", ts: 2, source: "ui", targetSeq: 0 },
      ),
      NOW,
      TZ,
    );
    expect(view.flows.length).toBe(0);
    expect(view.streakDays).toBe(0);
  });
});

describe("planScopeCoversToday", () => {
  it("day：仅覆盖创建当天", () => {
    expect(planScopeCoversToday(mkPlan({ scope: "day" }, NOW - 3 * DAY), NOW, TZ)).toBe(false);
    expect(planScopeCoversToday(mkPlan({ scope: "day" }, NOW), NOW, TZ)).toBe(true);
  });

  it("week：同一自然周覆盖（当地周一为一周之始）", () => {
    expect(planScopeCoversToday(mkPlan({ scope: "week" }, NOW - 3 * DAY), NOW, TZ)).toBe(true); // 周一创建，周四今天
    expect(planScopeCoversToday(mkPlan({ scope: "week" }, NOW - 10 * DAY), NOW, TZ)).toBe(false); // 上上周
  });

  it("month：同月覆盖、跨月不覆盖", () => {
    expect(planScopeCoversToday(mkPlan({ scope: "month" }, NOW - 2 * DAY), NOW, TZ)).toBe(true); // 9-1 创建
    expect(planScopeCoversToday(mkPlan({ scope: "month" }, NOW - 20 * DAY), NOW, TZ)).toBe(false); // 8 月创建
  });

  it("year：同自然年覆盖", () => {
    expect(planScopeCoversToday(mkPlan({ scope: "year" }, NOW - 200 * DAY), NOW, TZ)).toBe(true);
    expect(planScopeCoversToday(mkPlan({ scope: "year" }, NOW - 400 * DAY), NOW, TZ)).toBe(false);
  });

  it("ndays：创建日起 N 天内覆盖", () => {
    expect(planScopeCoversToday(mkPlan({ scope: "ndays", ndays: 3 }, NOW - 2 * DAY), NOW, TZ)).toBe(true);
    expect(planScopeCoversToday(mkPlan({ scope: "ndays", ndays: 3 }, NOW - 3 * DAY), NOW, TZ)).toBe(false);
  });

  it("deadline：due 未过即覆盖", () => {
    expect(planScopeCoversToday(mkPlan({ scope: "deadline", due: "2026-09-04" }, NOW - DAY), NOW, TZ)).toBe(true);
    expect(planScopeCoversToday(mkPlan({ scope: "deadline", due: "2026-09-02" }, NOW - 2 * DAY), NOW, TZ)).toBe(false);
  });
});
