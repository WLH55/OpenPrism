// 批次4·panels fold：分类目录（归档过滤）、一分类一页（周期切片/30 天日序列/明细）、进步页四指标。全固定时钟。

import { describe, expect, it } from "vitest";
import {
  categoryView,
  listCategories,
  progressView,
  type LedgerAppend,
  type LedgerRecord,
} from "../src/app/fold";

// 2026-09-03 12:00 UTC = 当地（UTC+8）周四 20:00；本周一 = 当地 8-31
const TZ = 480;
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const DAY = 86400000;

function records(...items: Array<LedgerAppend & { ts: number; seq?: number }>): LedgerRecord[] {
  return items.map((item, i) => ({ ...item, seq: item.seq ?? i }) as LedgerRecord);
}
const flow = (time: number, category: string, value?: number, seq?: number): LedgerAppend & { ts: number } => ({
  kind: "event", ts: 1, source: "ui", time, category, ...(value !== undefined ? { value } : {}), ...(seq !== undefined ? { seq } : {}),
});

describe("listCategories", () => {
  it("活跃流水去重出目录，按最近活动倒序；归档剔除", () => {
    const rs = records(
      flow(NOW - 3 * DAY, "运动", 30),
      flow(NOW - DAY, "餐饮", 28),
      flow(NOW - DAY + 1000, "餐饮", 18),
      flow(NOW, "学习", 1),
    );
    const stats = listCategories(rs, []);
    expect(stats.map((s) => s.category)).toEqual(["学习", "餐饮", "运动"]);
    expect(stats[1]).toMatchObject({ count: 2, lastTs: NOW - DAY + 1000 });
    expect(listCategories(rs, ["餐饮"]).map((s) => s.category)).toEqual(["学习", "运动"]);
  });
});

describe("categoryView", () => {
  const rs = records(
    flow(NOW, "运动", 30),               // 当地周四 20:00（今天）
    flow(NOW - 1 * DAY, "运动", 45),     // 周三
    flow(NOW - 5 * DAY, "运动", 20),     // 上周六（本周之外：当地 8-29 < 8-31）
    { kind: "plan", ts: NOW - DAY, source: "ui", planId: "p1", title: "晨跑", scope: "day" }, // 非流水不计
  );

  it("today：只今天；week：本周（周一起）含今天与周三、不含上周六", () => {
    const today = categoryView(rs, { category: "运动", period: "today", now: NOW, tzOffsetMinutes: TZ });
    expect(today.count).toBe(1);
    expect(today.total).toBe(30);
    const week = categoryView(rs, { category: "运动", period: "week", now: NOW, tzOffsetMinutes: TZ });
    expect(week.count).toBe(2);
    expect(week.total).toBe(75);
    expect(week.flows).toHaveLength(2);
  });

  it("month/year 切片；daily 为近 30 天本地日序列（缺日补零）", () => {
    const month = categoryView(rs, { category: "运动", period: "month", now: NOW, tzOffsetMinutes: TZ });
    expect(month.count).toBe(2); // 9 月内两天（上周六实为当地 8-29，属八月）
    const year = categoryView(rs, { category: "运动", period: "year", now: NOW, tzOffsetMinutes: TZ });
    expect(year.count).toBe(3);
    expect(year.daily).toHaveLength(30);
    expect(year.daily.at(-1)).toMatchObject({ count: 1, total: 30 }); // 今天
    expect(year.daily[24]).toMatchObject({ count: 1, total: 20 }); // 5 天前（当地 8-29）有一笔 20
    expect(year.daily[25]).toMatchObject({ count: 0, total: 0 }); // 6 天前无记录
  });

  it("无此分类返回空视图不抛错", () => {
    const view = categoryView(rs, { category: "不存在", period: "week", now: NOW, tzOffsetMinutes: TZ });
    expect(view.count).toBe(0);
    expect(view.flows).toEqual([]);
  });
});

describe("progressView", () => {
  it("四指标：连续 / 本周计划完成率 / 分类周环比 / 近 14 天趋势", () => {
    const rs = records(
      // 本周（周一 8-31 起）：餐饮 2 笔；上周：餐饮 1 笔（+100%）
      flow(NOW - 2 * DAY, "餐饮", 28),
      flow(NOW - 2 * DAY + 1000, "餐饮", 18),
      flow(NOW - 8 * DAY, "餐饮", 46),
      // 连续：今天/昨天/前天
      flow(NOW, "运动", 1),
      flow(NOW - DAY, "运动", 1),
      flow(NOW - 2 * DAY - 2000, "运动", 1),
      // 计划：本周覆盖 2 个（day scope 建于昨天与今天），今天 1 个已打卡
      { kind: "plan", ts: NOW, source: "ui", planId: "pA", title: "今天读书", scope: "day" },
      { kind: "plan", ts: NOW - 3 * DAY, source: "ui", planId: "pOld", title: "上周的", scope: "day" },
      { kind: "checkin", ts: NOW - 1000, source: "ui", planId: "pA", at: NOW - 2000, done: true },
    );
    const view = progressView(rs, NOW, TZ);
    expect(view.streakDays).toBe(3);
    expect(view.completion).toMatchObject({ done: 1, total: 1, rate: 1 }); // 本周只 pA 覆盖
    const wow = view.weekOverWeek.find((w) => w.category === "餐饮")!;
    expect(wow).toMatchObject({ thisWeek: 2, lastWeek: 1, deltaPct: 100 });
    expect(view.trend14).toHaveLength(14);
    expect(view.trend14.at(-1)).toMatchObject({ count: 1 }); // 今天：仅运动（餐饮在周一）
  });
});
