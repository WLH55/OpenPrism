// 批次3·tasks：触发器（枚举 + 自研 cron 匹配）、nextDue 单调性、TaskStore CRUD、Scheduler 到点/补跑/跳过。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths, type AppPaths } from "../src/app/store";
import { createTaskTool, cronMatches, nextDue, Scheduler, TaskStore, type TaskTrigger } from "../src/app/tasks";

let root: string;
let paths: AppPaths;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-tasks-"));
  paths = appPaths(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TZ = 480; // UTC+8
const T = (s: string): number => Date.parse(s); // UTC 解析

describe("cronMatches", () => {
  it("* / 数字 / 范围 / 列表 / 步进 / 周日 0|7", () => {
    // 2026-09-03 12:30 UTC = 周四
    const d = new Date(T("2026-09-03T12:30:00Z"));
    expect(cronMatches("30 12 * * *", d)).toBe(true);
    expect(cronMatches("31 12 * * *", d)).toBe(false);
    expect(cronMatches("30 10-14 * * *", d)).toBe(true);
    expect(cronMatches("30 12 3 9 *", d)).toBe(true);
    expect(cronMatches("*/15 * * * *", d)).toBe(true); // 30 % 15 == 0
    expect(cronMatches("* * * * 4", d)).toBe(true); // 周四
    expect(cronMatches("* * * * 0", new Date(T("2026-09-06T00:00:00Z")))).toBe(true); // 周日
    expect(cronMatches("* * * * 7", new Date(T("2026-09-06T00:00:00Z")))).toBe(true); // 7 也是周日
    expect(() => cronMatches("bad", d)).toThrow();
    expect(() => cronMatches("* * * *", d)).toThrow();
  });
});

describe("nextDue", () => {
  it("daily：当地时区次日同时刻；weekly：下一个周四；once：原样或已过→null 语义由调度层处理", () => {
    const now = T("2026-09-03T20:01:00Z"); // 当地 09-04 04:01 周五
    const daily = nextDue({ kind: "daily", time: "23:00" }, now, TZ)!;
    expect(new Date(daily + TZ * 60000).toISOString()).toBe("2026-09-04T23:00:00.000Z"); // 当地 9-4 23:00（未到今天23点）
    const weekly = nextDue({ kind: "weekly", days: [4], time: "08:00" }, now, TZ)!; // 周四 08:00 → 下周四
    expect(new Date(weekly + TZ * 60000).toISOString()).toBe("2026-09-10T08:00:00.000Z");
    expect(nextDue({ kind: "once", at: T("2026-09-03T00:00:00Z") }, now, TZ)).toBe(T("2026-09-03T00:00:00Z"));
  });

  it("monthly/yearly/cron 可解", () => {
    const now = T("2026-09-03T12:00:00Z");
    expect(nextDue({ kind: "monthly", day: 1, time: "09:00" }, now, TZ)).toBeTruthy();
    expect(nextDue({ kind: "yearly", month: 1, day: 1, time: "00:00" }, now, TZ)).toBeTruthy();
    expect(nextDue({ kind: "cron", expr: "0 9 * * *" }, now, TZ)).toBeTruthy();
  });
});

describe("TaskStore", () => {
  it("create 校验 trigger 字段（time 格式/days 范围/cron 合法）；CRUD + runs 往返", async () => {
    const store = new TaskStore({ fileIO: nodeFileIO, paths, now: () => 1000, randomUUID: () => "tid-1" });
    const task = await store.create("u1", {
      title: "23点睡觉提醒",
      instruction: "提醒用户准备睡觉，语气温和。",
      trigger: { kind: "daily", time: "23:00" },
      agentId: undefined,
    });
    expect(task.id).toBe("tid-1");
    expect(task.enabled).toBe(true);
    await expect(store.create("u1", { title: "x", instruction: "y", trigger: { kind: "daily", time: "25:00" } })).rejects.toThrow();
    await expect(store.create("u1", { title: "x", instruction: "y", trigger: { kind: "weekly", days: [9], time: "08:00" } })).rejects.toThrow();
    await expect(store.create("u1", { title: "x", instruction: "y", trigger: { kind: "cron", expr: "oops" } })).rejects.toThrow();

    const updated = await store.update("u1", task.id, { enabled: false });
    expect(updated.enabled).toBe(false);
    await store.recordRun("u1", task.id, { ts: 1, status: "ran" });
    expect((await store.runs("u1", task.id))[0]!.status).toBe("ran");
    await store.remove("u1", task.id);
    expect(await store.list("u1")).toHaveLength(0);
  });
});

describe("Scheduler", () => {
  function makeWorld(uid: string, nowTs: number) {
    const store = new TaskStore({ fileIO: nodeFileIO, paths, now: () => nowTs, randomUUID: () => `tid-${Math.random().toString(36).slice(2, 8)}` });
    const ran: { uid: string; id: string }[] = [];
    const scheduler = new Scheduler({
      uids: () => [uid],
      tasks: store,
      runTask: async (uidRun, task) => {
        ran.push({ uid: uidRun, id: task.id });
      },
      now: () => nowTs,
    });
    return { store, scheduler, ran };
  }

  it("到点即跑；再 tick 不重复", async () => {
    const create = makeWorld("u-due", T("2026-09-03T00:00:00Z")); // 当地 9-3 08:00 建任务
    await create.store.create("u-due", { title: "睡", instruction: "去睡", trigger: { kind: "daily", time: "23:00" }, tzOffsetMinutes: TZ });
    const run = makeWorld("u-due", T("2026-09-03T15:01:00Z")); // 当地 23:01，到期 1 分钟
    expect(await run.scheduler.tick()).toBe(1);
    expect(run.ran).toHaveLength(1);
    expect(await run.scheduler.tick()).toBe(0);
  });

  it("错过 <24h 补跑一次（ran）；≥24h 记 skipped 不跑", async () => {
    const create = makeWorld("u-miss", T("2026-09-03T00:00:00Z")); // due = 当地 9-3 09:00
    const task = await create.store.create("u-miss", { title: "x", instruction: "x", trigger: { kind: "daily", time: "09:00" }, tzOffsetMinutes: TZ });

    const soon = makeWorld("u-miss", T("2026-09-03T02:00:00Z")); // 当地 10:00，错过 1h
    expect(await soon.scheduler.tick()).toBe(1);
    expect((await soon.store.runs("u-miss", task.id)).at(-1)).toMatchObject({ status: "ran" });

    // 另一任务：错过 26h → skipped
    const create2 = makeWorld("u-stale", T("2026-09-03T00:00:00Z"));
    const stale = await create2.store.create("u-stale", { title: "y", instruction: "y", trigger: { kind: "daily", time: "09:00" }, tzOffsetMinutes: TZ });
    const late = makeWorld("u-stale", T("2026-09-04T03:00:00Z")); // 当地 9-4 11:00，due 9-3 09:00 → 26h
    expect(await late.scheduler.tick()).toBe(0);
    expect((await late.store.runs("u-stale", stale.id)).at(-1)).toMatchObject({ status: "skipped" });
    // skipped 后锚点推进，再 tick 不重复记
    expect(await late.scheduler.tick()).toBe(0);
  });

  it("禁用不跑；once 到期跑一次后不再跑", async () => {
    const create = makeWorld("u-off", T("2026-09-03T00:00:00Z"));
    const off = await create.store.create("u-off", { title: "关", instruction: "x", trigger: { kind: "daily", time: "09:00" }, tzOffsetMinutes: TZ });
    await create.store.update("u-off", off.id, { enabled: false });
    const world = makeWorld("u-off", T("2026-09-03T02:00:00Z"));
    await world.scheduler.tick();
    expect(world.ran).toHaveLength(0);

    const createOnce = makeWorld("u-once", T("2026-09-03T00:00:00Z"));
    await createOnce.store.create("u-once", { title: "单次", instruction: "x", trigger: { kind: "once", at: T("2026-09-03T01:30:00Z") } });
    const first = makeWorld("u-once", T("2026-09-03T02:00:00Z"));
    expect(await first.scheduler.tick()).toBe(1);
    const second = makeWorld("u-once", T("2026-09-03T12:00:00Z"));
    expect(await second.scheduler.tick()).toBe(0);
    expect(second.ran).toHaveLength(0);
  });
});

describe("create_task 工具（双入口之二）", () => {
  it("execute 落任务；坏 trigger 抛错（isError 化）", async () => {
    const store = new TaskStore({ fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => "tid-tool" });
    const tool = createTaskTool({ store, uid: "u-tool" });
    const ctx = { signal: new AbortController().signal, env: nodeEnv };
    const value = (await tool.execute({ title: "喝水", instruction: "提醒喝水", trigger: { kind: "daily", time: "10:00" } }, ctx)) as { taskId: string };
    expect(value.taskId).toBe("tid-tool");
    expect((await store.list("u-tool"))).toHaveLength(1);
    await expect(tool.execute({ title: "x", instruction: "y", trigger: { kind: "daily", time: "99:00" } }, ctx)).rejects.toThrow();
    expect(tool.isConcurrencySafe?.({})).toBeFalsy();
  });
});
