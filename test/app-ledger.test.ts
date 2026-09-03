// 批次1·ledger：四记录追加、串行写队列、void 折叠、重启续排、坏行容错。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeFileIO } from "../src/app/env";
import { Ledger, type CheckinRecord, type FlowRecord, type PlanRecord } from "../src/app/ledger";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-ledger-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Ledger", () => {
  it("append 分配单调 seq、注入 ts、source/actor 落档", async () => {
    const ledger = await Ledger.open(nodeFileIO, join(root, "l1", "life.jsonl"));
    const flow = await ledger.append({ kind: "event", source: "agent", time: 1000, category: "餐饮", value: 28, unit: "¥", actor: { conversationId: "c1", agentName: "助手" } }, 1234);
    expect(flow.seq).toBe(0);
    expect(flow.ts).toBe(1234);
    expect((flow as FlowRecord).category).toBe("餐饮");
    expect((flow as FlowRecord).actor?.conversationId).toBe("c1");
    const plan = await ledger.append({ kind: "plan", source: "ui", planId: "p-1", title: "晨跑", scope: "day" }, 2000);
    expect(plan.seq).toBe(1);
    expect(plan.ts).toBe(2000);
  });

  it("并发 append 经串行队列后 seq 严格有序、盘上行序一致", async () => {
    const path = join(root, "l2", "life.jsonl");
    const ledger = await Ledger.open(nodeFileIO, path);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => ledger.append({ kind: "event", source: "ui", time: i, category: "测试" })),
    );
    const all = ledger.readAll();
    expect(all.map((r) => r.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const lines = await nodeFileIO.readAll(path);
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("重启后从盘上最大 seq 续排，不回退", async () => {
    const path = join(root, "l3", "life.jsonl");
    const first = await Ledger.open(nodeFileIO, path);
    await first.append({ kind: "event", source: "ui", time: 1, category: "a" });
    await first.append({ kind: "event", source: "ui", time: 2, category: "b" });
    const reopened = await Ledger.open(nodeFileIO, path);
    const next = await reopened.append({ kind: "event", source: "ui", time: 3, category: "c" });
    expect(next.seq).toBe(2);
    expect(reopened.readAll().length).toBe(3);
  });

  it("void 从 activeRecords 剔除目标，readAll 保留全部（只追加不抹除）", async () => {
    const ledger = await Ledger.open(nodeFileIO, join(root, "l4", "life.jsonl"));
    const a = await ledger.append({ kind: "event", source: "ui", time: 1, category: "餐饮", value: 18 });
    const b = await ledger.append({ kind: "event", source: "ui", time: 2, category: "运动" });
    await ledger.append({ kind: "void", source: "ui", targetSeq: a.seq, reason: "记错了" });
    const active = ledger.activeRecords();
    expect(active.map((r) => r.seq)).toEqual([b.seq]);
    expect(ledger.readAll().length).toBe(3);
  });

  it("打卡记录引用 planId；坏行加载时跳过", async () => {
    const path = join(root, "l5", "life.jsonl");
    await nodeFileIO.appendLine(path, "{broken");
    const ledger = await Ledger.open(nodeFileIO, path);
    const plan = await ledger.append({ kind: "plan", source: "agent", planId: "p-9", title: "读书", scope: "day" });
    const checkin = await ledger.append({ kind: "checkin", source: "ui", planId: "p-9", at: 500, done: true });
    expect((plan as PlanRecord).planId).toBe("p-9");
    expect((checkin as CheckinRecord).done).toBe(true);
    const reopened = await Ledger.open(nodeFileIO, path);
    expect(reopened.readAll().length).toBe(2); // 坏行不计
  });
});
