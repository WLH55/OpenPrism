// 批次1·ledger：四记录追加、串行写队列、void 折叠、重开续排、未知 kind 容错（ADR 0008：ledger_entries 表）。

import { describe, expect, it } from "vitest";
import { Ledger, type CheckinRecord, type FlowRecord, type PlanRecord } from "../src/app/ledger";
import { testDb } from "./helpers-db";

describe("Ledger", () => {
  it("append 分配单调 seq、注入 ts、source/actor 落档", async () => {
    const ledger = await Ledger.open(testDb(), "u1");
    const flow = await ledger.append({ kind: "event", source: "agent", time: 1000, category: "餐饮", value: 28, unit: "¥", actor: { conversationId: "c1", agentName: "助手" } }, 1234);
    expect(flow.seq).toBe(0);
    expect(flow.ts).toBe(1234);
    expect((flow as FlowRecord).category).toBe("餐饮");
    expect((flow as FlowRecord).actor?.conversationId).toBe("c1");
    const plan = await ledger.append({ kind: "plan", source: "ui", planId: "p-1", title: "晨跑", scope: "day" }, 2000);
    expect(plan.seq).toBe(1);
    expect(plan.ts).toBe(2000);
  });

  it("并发 append 经串行队列后 seq 严格有序、行序与库一致", async () => {
    const db = testDb();
    const ledger = await Ledger.open(db, "u1");
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => ledger.append({ kind: "event", source: "ui", time: i, category: "测试" })),
    );
    const all = ledger.readAll();
    expect(all.map((r) => r.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const rows = db.prepare("SELECT seq FROM ledger_entries WHERE uid = 'u1' ORDER BY seq").all() as unknown as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("重开（同库新实例）从最大 seq 续排，不回退；四类记录字段往返不失真", async () => {
    const db = testDb();
    const first = await Ledger.open(db, "u1");
    await first.append({ kind: "event", source: "ui", time: 1, category: "a", note: "备注", attrs: { 重量: 60 } });
    await first.append({ kind: "event", source: "ui", time: 2, category: "b" });
    await first.append({ kind: "plan", source: "agent", planId: "p-1", title: "晨跑", scope: "ndays", ndays: 7, actor: { conversationId: "c9" } });
    const reopened = await Ledger.open(db, "u1");
    const next = await reopened.append({ kind: "event", source: "ui", time: 3, category: "c" });
    expect(next.seq).toBe(3);
    expect(reopened.readAll().length).toBe(4);
    const flow = reopened.readAll()[0] as FlowRecord;
    expect(flow.note).toBe("备注");
    expect(flow.attrs).toEqual({ 重量: 60 });
    const plan = reopened.readAll()[2] as PlanRecord;
    expect(plan.planId).toBe("p-1");
    expect(plan.scope).toBe("ndays");
    expect(plan.ndays).toBe(7);
    expect(plan.actor?.conversationId).toBe("c9");
  });

  it("void 从 activeRecords 剔除目标，readAll 保留全部（只追加不抹除）；checkin done 往返", async () => {
    const db = testDb();
    const ledger = await Ledger.open(db, "u1");
    const a = await ledger.append({ kind: "event", source: "ui", time: 1, category: "餐饮", value: 18 });
    const b = await ledger.append({ kind: "event", source: "ui", time: 2, category: "运动" });
    const checkin = await ledger.append({ kind: "checkin", source: "ui", planId: "p-1", at: 500, done: true });
    await ledger.append({ kind: "void", source: "ui", targetSeq: a.seq, reason: "记错了" });
    const active = ledger.activeRecords();
    expect(active.map((r) => r.seq)).toEqual([b.seq, checkin.seq]);
    expect(ledger.readAll().length).toBe(4);
    expect((checkin as CheckinRecord).done).toBe(true);

    const reopened = await Ledger.open(db, "u1");
    const checkinBack = reopened.readAll()[2] as CheckinRecord;
    expect(checkinBack.done).toBe(true);
    expect(reopened.activeRecords().map((r) => r.seq)).toEqual([b.seq, checkin.seq]);
  });

  it("用户隔离：同库不同 uid 的账本互不可见，seq 各自从 0 起", async () => {
    const db = testDb();
    const a = await Ledger.open(db, "u-a");
    await a.append({ kind: "event", source: "ui", time: 1, category: "x" });
    const b = await Ledger.open(db, "u-b");
    const record = await b.append({ kind: "event", source: "ui", time: 2, category: "y" });
    expect(record.seq).toBe(0);
    expect(a.readAll()).toHaveLength(1);
    expect(b.readAll()).toHaveLength(1);
  });
});
