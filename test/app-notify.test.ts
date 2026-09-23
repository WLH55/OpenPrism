// 批次3·notify：站内通知（永远在线的兜底通道）——落库/未读/已读（notifications 表）。

import { describe, expect, it } from "vitest";
import { inAppChannel, NotificationStore } from "../src/app/notify";
import { testDb } from "./helpers-db";

describe("NotificationStore", () => {
  it("push/list 往返；unreadCount 与 markRead(all|seq)", async () => {
    const store = new NotificationStore({ db: testDb(), now: () => 1000 });
    const a = await store.push("u1", { kind: "task_message", taskId: "t1", text: "该睡觉了" });
    const b = await store.push("u1", { kind: "task_message", taskId: "t2", text: "学习打卡了吗" });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect((await store.list("u1")).map((n) => n.text)).toEqual(["该睡觉了", "学习打卡了吗"]);
    expect(await store.unreadCount("u1")).toBe(2);
    await store.markRead("u1", a.seq);
    expect(await store.unreadCount("u1")).toBe(1);
    const unread = await store.list("u1", { unreadOnly: true });
    expect(unread.map((n) => n.seq)).toEqual([1]);
    await store.markRead("u1", "all");
    expect(await store.unreadCount("u1")).toBe(0);
  });

  it("通道缝：inAppChannel 委托 push；用户隔离", async () => {
    const store = new NotificationStore({ db: testDb(), now: () => 1 });
    const channel = inAppChannel(store);
    await channel("u2", { kind: "task_message", text: "hi" });
    await channel("u3", { kind: "task_message", text: "别的用户" });
    expect((await store.list("u2"))[0]!.text).toBe("hi");
    expect((await store.list("u3"))[0]!.seq).toBe(0); // seq 按用户独立
  });
});
