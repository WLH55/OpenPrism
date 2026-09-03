// 批次3·notify：站内通知（永远在线的兜底通道）——落盘/未读/已读。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeFileIO } from "../src/app/env";
import { appPaths, type AppPaths } from "../src/app/store";
import { inAppChannel, NotificationStore } from "../src/app/notify";

let root: string;
let paths: AppPaths;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-notify-"));
  paths = appPaths(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NotificationStore", () => {
  it("push/list 往返；unreadCount 与 markRead(all|seq)", async () => {
    const store = new NotificationStore({ fileIO: nodeFileIO, paths, now: () => 1000 });
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

  it("通道缝：inAppChannel 委托 push", async () => {
    const store = new NotificationStore({ fileIO: nodeFileIO, paths, now: () => 1 });
    const channel = inAppChannel(store);
    await channel("u2", { kind: "task_message", text: "hi" });
    expect((await store.list("u2"))[0]!.text).toBe("hi");
  });
});
