// 批次3·tasks：触发器（枚举 + 自研 cron 匹配）、nextDue 单调性、TaskStore CRUD、Scheduler 到点/补跑/跳过
// （tasks/task_runs 表；调度器换实例 = 真实"重启"，数据持久在同库）。

import { describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { createTaskTools, cronMatches, describeTrigger, nextDue, Scheduler, taskTriggerMessage, TaskStore, type TaskDef, type TaskRunTrigger, type TaskTrigger } from "../src/app/tasks";
import { testDb } from "./helpers-db";

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

  it("interval：每 N 天/周从锚点步进；endTs 截止（含当天）", () => {
    const startTs = T("2026-09-01T01:00:00Z"); // 锚点：当地 9-1（周二）09:00
    const from = T("2026-09-03T12:00:00Z"); // 当地 9-3 20:00
    // 每 2 天 → 序列 9-1/9-3/9-5…，9-3 20:00 视角下一次 = 当地 9-5 09:00
    const d2 = nextDue({ kind: "interval", every: 2, unit: "day", time: "09:00", startTs }, from, TZ)!;
    expect(d2).toBe(T("2026-09-05T01:00:00Z"));
    // 每 1 周 → 下个周二 9-8 09:00
    const w1 = nextDue({ kind: "interval", every: 1, unit: "week", time: "09:00", startTs }, from, TZ)!;
    expect(w1).toBe(T("2026-09-08T01:00:00Z"));
    // endTs = 当地 9-5 当天末尾：9-3 视角下一次（9-5）当天仍可；9-5 20:00 视角下一次（9-7）越界 → null
    const endTs = T("2026-09-05T15:59:59.999Z");
    expect(nextDue({ kind: "interval", every: 2, unit: "day", time: "09:00", startTs, endTs }, from, TZ)).toBe(T("2026-09-05T01:00:00Z"));
    expect(nextDue({ kind: "interval", every: 2, unit: "day", time: "09:00", startTs, endTs }, T("2026-09-05T12:00:00Z"), TZ)).toBeNull();
  });

  it("interval month：月末截断（1-31 → 2-28 → 3-31），year 步进 12 个月", () => {
    const startTs = T("2026-01-31T02:00:00Z"); // 当地 1-31 10:00
    const m1 = nextDue({ kind: "interval", every: 1, unit: "month", time: "10:00", startTs }, T("2026-02-20T00:00:00Z"), TZ)!;
    expect(m1).toBe(T("2026-02-28T02:00:00Z")); // 2 月无 31 号 → 28
    const m2 = nextDue({ kind: "interval", every: 1, unit: "month", time: "10:00", startTs }, T("2026-03-01T00:00:00Z"), TZ)!;
    expect(m2).toBe(T("2026-03-31T02:00:00Z")); // 3 月回 31
    const y1 = nextDue({ kind: "interval", every: 1, unit: "year", time: "10:00", startTs }, T("2026-02-20T00:00:00Z"), TZ)!;
    expect(y1).toBe(T("2027-01-31T02:00:00Z"));
  });

  it("interval minute/hour：从 startTs 直步进（与时刻无关）", () => {
    const startTs = T("2026-09-01T01:00:00Z"); // 锚点：当地 9-1 09:00
    const from = T("2026-09-03T12:00:00Z"); // 距锚点 59h
    // 每 90 分钟 → 第 40 步 = 锚点 + 60h = 当地 9-3 21:00
    expect(nextDue({ kind: "interval", every: 90, unit: "minute", startTs }, from, TZ)).toBe(T("2026-09-03T13:00:00Z"));
    // 每 2 小时 → 第 30 步 = 同一刻
    expect(nextDue({ kind: "interval", every: 2, unit: "hour", startTs }, from, TZ)).toBe(T("2026-09-03T13:00:00Z"));
    // endTs 已过 → null
    expect(nextDue({ kind: "interval", every: 90, unit: "minute", startTs, endTs: from - 1 }, from, TZ)).toBeNull();
  });

  it("interval 校验：every ≥1 整数、unit 白名单、endTs 不早于 startTs", async () => {
    const store = new TaskStore({ db: testDb(), now: () => 1, randomUUID: () => "tid-iv" });
    const ok = { kind: "interval", every: 2, unit: "day", time: "09:00", startTs: T("2026-09-01T01:00:00Z") } as const;
    await store.create("u1", { title: "x", instruction: "y", trigger: ok });
    await expect(store.create("u1", { title: "x", instruction: "y", trigger: { ...ok, every: 0 } })).rejects.toThrow();
    await expect(
      store.create("u1", { title: "x", instruction: "y", trigger: { ...ok, unit: "century" } as unknown as TaskTrigger }),
    ).rejects.toThrow();
    await expect(store.create("u1", { title: "x", instruction: "y", trigger: { ...ok, time: "9:00" } })).rejects.toThrow();
    await expect(
      store.create("u1", { title: "x", instruction: "y", trigger: { ...ok, endTs: T("2026-08-31T00:00:00Z") } }),
    ).rejects.toThrow();
  });
});

describe("TaskStore", () => {
  it("create 校验 trigger 字段（time 格式/days 范围/cron 合法）；CRUD + runs 往返；删除连带清 runs", async () => {
    const store = new TaskStore({ db: testDb(), now: () => 1000, randomUUID: () => "tid-1" });
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
    expect(await store.runs("u1", task.id)).toHaveLength(0);
  });

  it("updateLastRun 推进锚点并持久（同库新实例可见）", async () => {
    const db = testDb();
    const store = new TaskStore({ db, now: () => 1, randomUUID: () => "tid-2" });
    const task = await store.create("u1", { title: "x", instruction: "x", trigger: { kind: "daily", time: "09:00" } });
    await store.updateLastRun("u1", task.id, 777);
    const reopened = new TaskStore({ db, now: () => 1, randomUUID: () => "tid-3" });
    expect((await reopened.get("u1", task.id))?.lastRunTs).toBe(777);
  });
});

describe("Scheduler", () => {
  function makeWorld(db: ReturnType<typeof testDb>, uid: string, nowTs: number) {
    const store = new TaskStore({ db, now: () => nowTs, randomUUID: () => `tid-${Math.random().toString(36).slice(2, 8)}` });
    const ran: { uid: string; id: string; run: TaskRunTrigger }[] = [];
    const scheduler = new Scheduler({
      uids: () => [uid],
      tasks: store,
      runTask: async (uidRun, task, run) => {
        ran.push({ uid: uidRun, id: task.id, run });
      },
      now: () => nowTs,
    });
    return { store, scheduler, ran };
  }

  it("到点即跑；再 tick 不重复", async () => {
    const db = testDb();
    const create = makeWorld(db, "u-due", T("2026-09-03T00:00:00Z")); // 当地 9-3 08:00 建任务
    await create.store.create("u-due", { title: "睡", instruction: "去睡", trigger: { kind: "daily", time: "23:00" }, tzOffsetMinutes: TZ });
    const run = makeWorld(db, "u-due", T("2026-09-03T15:01:00Z")); // 当地 23:01，到期 1 分钟
    expect(await run.scheduler.tick()).toBe(1);
    expect(run.ran).toHaveLength(1);
    // 到点触发带上计划时刻（注入上下文的"计划时刻"就取它）
    expect(run.ran[0]!.run).toEqual({ kind: "scheduled", due: T("2026-09-03T15:00:00Z") });
    expect(await run.scheduler.tick()).toBe(0);
  });

  it("错过 <24h 补跑一次（ran）；≥24h 记 skipped 不跑", async () => {
    const db = testDb();
    const create = makeWorld(db, "u-miss", T("2026-09-03T00:00:00Z")); // due = 当地 9-3 09:00
    const task = await create.store.create("u-miss", { title: "x", instruction: "x", trigger: { kind: "daily", time: "09:00" }, tzOffsetMinutes: TZ });

    const soon = makeWorld(db, "u-miss", T("2026-09-03T02:00:00Z")); // 当地 10:00，错过 1h
    expect(await soon.scheduler.tick()).toBe(1);
    expect((await soon.store.runs("u-miss", task.id)).at(-1)).toMatchObject({ status: "ran" });

    // 另一任务：错过 26h → skipped
    const create2 = makeWorld(db, "u-stale", T("2026-09-03T00:00:00Z"));
    const stale = await create2.store.create("u-stale", { title: "y", instruction: "y", trigger: { kind: "daily", time: "09:00" }, tzOffsetMinutes: TZ });
    const late = makeWorld(db, "u-stale", T("2026-09-04T03:00:00Z")); // 当地 9-4 11:00，due 9-3 09:00 → 26h
    expect(await late.scheduler.tick()).toBe(0);
    expect((await late.store.runs("u-stale", stale.id)).at(-1)).toMatchObject({ status: "skipped" });
    // skipped 后锚点推进，再 tick 不重复记
    expect(await late.scheduler.tick()).toBe(0);
  });

  it("禁用不跑；once 到期跑一次后不再跑", async () => {
    const db = testDb();
    const create = makeWorld(db, "u-off", T("2026-09-03T00:00:00Z"));
    const off = await create.store.create("u-off", { title: "关", instruction: "x", trigger: { kind: "daily", time: "09:00" }, tzOffsetMinutes: TZ });
    await create.store.update("u-off", off.id, { enabled: false });
    const world = makeWorld(db, "u-off", T("2026-09-03T02:00:00Z"));
    await world.scheduler.tick();
    expect(world.ran).toHaveLength(0);

    const createOnce = makeWorld(db, "u-once", T("2026-09-03T00:00:00Z"));
    await createOnce.store.create("u-once", { title: "单次", instruction: "x", trigger: { kind: "once", at: T("2026-09-03T01:30:00Z") } });
    const first = makeWorld(db, "u-once", T("2026-09-03T02:00:00Z"));
    expect(await first.scheduler.tick()).toBe(1);
    const second = makeWorld(db, "u-once", T("2026-09-03T12:00:00Z"));
    expect(await second.scheduler.tick()).toBe(0);
    expect(second.ran).toHaveLength(0);
  });
});

describe("触发描述与到点注入（提醒会话上下文）", () => {
  const base: TaskDef = {
    id: "t1",
    uid: "u1",
    title: "工作提醒",
    instruction: "提醒我工作辛苦了，记得照顾好自己",
    trigger: { kind: "daily", time: "17:00" },
    enabled: true,
    tzOffsetMinutes: TZ,
    createdTs: 0,
  };

  it("describeTrigger：各触发器的中文描述（周几用汉字，interval 单复数一致）", () => {
    expect(describeTrigger({ kind: "daily", time: "17:00" })).toBe("每天 17:00");
    expect(describeTrigger({ kind: "weekly", days: [1, 3], time: "08:00" })).toBe("每周一、周三 08:00");
    expect(describeTrigger({ kind: "monthly", day: 5, time: "09:30" })).toBe("每月 5 日 09:30");
    expect(describeTrigger({ kind: "yearly", month: 9, day: 3, time: "09:00" })).toBe("每年 9 月 3 日 09:00");
    expect(describeTrigger({ kind: "interval", every: 2, unit: "hour", startTs: 0 })).toBe("每 2 小时");
    expect(describeTrigger({ kind: "interval", every: 1, unit: "day", time: "09:00", startTs: 0 })).toBe("每天 09:00");
    expect(describeTrigger({ kind: "cron", expr: "0 9 * * *" })).toBe("cron 表达式 0 9 * * *");
    // once 按任务时区显示（UTC+8：UTC 00:00 = 当地 08:00）
    expect(describeTrigger({ kind: "once", at: T("2026-09-03T00:00:00Z") }, TZ)).toBe("单次 2026-09-03 08:00");
  });

  it("taskTriggerMessage：自动触发写全任务内容、重复规则、计划时刻与触发时刻", () => {
    const due = T("2026-09-23T09:00:00Z"); // 当地 17:00
    const text = taskTriggerMessage(base, { kind: "scheduled", due }, due);
    expect(text).toContain("【定时任务触发】工作提醒");
    expect(text).toContain("任务内容：提醒我工作辛苦了，记得照顾好自己");
    expect(text).toContain("重复规则：每天 17:00");
    expect(text).toContain("计划时刻：2026-09-23 17:00");
    expect(text).toContain("触发时刻：2026-09-23 17:00（准点）");
    expect(text).toContain("由系统按计划自动发起");
    expect(text).toContain("不要就这些反问用户");
  });

  it("taskTriggerMessage：补跑标注延迟；手动触发说明来路且不写计划时刻", () => {
    const due = T("2026-09-23T09:00:00Z");
    const late = taskTriggerMessage(base, { kind: "scheduled", due }, due + 80 * 60000);
    expect(late).toContain("触发时刻：2026-09-23 18:20");
    expect(late).toContain("（补跑，比计划晚 1 小时 20 分钟）");
    const manual = taskTriggerMessage(base, { kind: "manual" }, due);
    expect(manual).toContain("触发方式：用户在提醒页手动点了「立即跑」");
    expect(manual).toContain("触发时刻：2026-09-23 17:00");
    expect(manual).not.toContain("计划时刻");
    expect(manual).not.toContain("准点");
  });
});

describe("任务工具四件套（双入口之二；2026-09-04 补 CRUD）", () => {
  const NOW = Date.UTC(2026, 8, 3, 12, 0, 0); // 当地 20:00
  const ctx = { signal: new AbortController().signal, env: nodeEnv };

  function makeTools(uid: string) {
    const store = new TaskStore({ db: testDb(), now: () => 1, randomUUID: () => "tid-tool" });
    const tools = createTaskTools({ store, uid, now: () => NOW });
    return { store, tools, by: (name: string) => tools.find((t) => t.name === name)! };
  }

  it("create 落任务；坏 trigger 抛错（isError 化）；写工具 exclusive、查询 parallel", async () => {
    const { store, by } = makeTools("u-create");
    const value = (await by("create_task").execute({ title: "喝水", instruction: "提醒喝水", trigger: { kind: "daily", time: "10:00" } }, ctx)) as { taskId: string };
    expect(value.taskId).toBe("tid-tool");
    expect(await store.list("u-create")).toHaveLength(1);
    await expect(by("create_task").execute({ title: "x", instruction: "y", trigger: { kind: "daily", time: "99:00" } }, ctx)).rejects.toThrow();
    expect(by("create_task").isConcurrencySafe?.({})).toBeFalsy();
    expect(by("query_tasks").isConcurrencySafe?.({})).toBe(true);
  });

  it("query_tasks：列出 id/触发/启用态，nextDueAt 按任务时区算；enabled 过滤", async () => {
    const { store, by } = makeTools("u-query");
    await store.create("u-query", { title: "睡觉", instruction: "x", trigger: { kind: "daily", time: "23:00" }, tzOffsetMinutes: TZ });
    const result = (await by("query_tasks").execute({}, ctx)) as { tasks: { id: string; title: string; enabled: boolean; nextDueAt: number }[] };
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.title).toBe("睡觉");
    expect(result.tasks[0]!.enabled).toBe(true);
    // NOW = 当地 9-3 20:00 → daily 23:00 的下次 = 当地 9-3 23:00
    expect(new Date(result.tasks[0]!.nextDueAt + TZ * 60000).toISOString()).toBe("2026-09-03T23:00:00.000Z");
    const off = (await by("query_tasks").execute({ enabled: false }, ctx)) as { tasks: unknown[] };
    expect(off.tasks).toHaveLength(0);
  });

  it("update_task：停用/改触发；坏 trigger 拒绝；空 patch 拒绝", async () => {
    const { store, by } = makeTools("u-update");
    const task = await store.create("u-update", { title: "晨跑", instruction: "x", trigger: { kind: "daily", time: "07:00" } });
    const updated = (await by("update_task").execute({ taskId: task.id, enabled: false }, ctx)) as { enabled: boolean };
    expect(updated.enabled).toBe(false);
    expect((await store.list("u-update"))[0]!.trigger).toEqual({ kind: "daily", time: "07:00" });
    await expect(by("update_task").execute({ taskId: task.id, trigger: { kind: "cron", expr: "oops" } }, ctx)).rejects.toThrow();
    await expect(by("update_task").execute({ taskId: task.id }, ctx)).rejects.toThrow();
    await expect(by("update_task").execute({ taskId: "nope", enabled: true }, ctx)).rejects.toThrow();
  });

  it("delete_task：删除后列表为空；不存在抛错", async () => {
    const { store, by } = makeTools("u-delete");
    const task = await store.create("u-delete", { title: "23:30 那个", instruction: "x", trigger: { kind: "daily", time: "23:30" } });
    const value = (await by("delete_task").execute({ taskId: task.id }, ctx)) as { deleted: string };
    expect(value.deleted).toBe("23:30 那个");
    expect(await store.list("u-delete")).toHaveLength(0);
    await expect(by("delete_task").execute({ taskId: task.id }, ctx)).rejects.toThrow();
  });
});

describe("TaskStore（任务级通知渠道，2026-09-27）", () => {
  it("notifyChannel：wechat 入库往返；缺省 NULL；非法值 create/update 都拒绝", async () => {
    const db = testDb();
    let seq = 0;
    const store = new TaskStore({ db, now: () => 1, randomUUID: () => `tid-nc-${++seq}` });
    const task = await store.create("u1", {
      title: "喝水提醒",
      instruction: "提醒喝水",
      trigger: { kind: "daily", time: "10:00" },
      notifyChannel: "wechat",
    });
    expect(task.notifyChannel).toBe("wechat");
    expect((await store.list("u1"))[0]!.notifyChannel).toBe("wechat");

    const plain = await store.create("u1", { title: "默认站内", instruction: "x", trigger: { kind: "daily", time: "11:00" } });
    expect(plain.notifyChannel).toBeUndefined();
    const raw = db.prepare("SELECT notify_channel FROM tasks WHERE id = ?").get(plain.id) as unknown as { notify_channel: string | null };
    expect(raw.notify_channel).toBeNull();

    await expect(
      store.create("u1", { title: "x", instruction: "y", trigger: { kind: "daily", time: "12:00" }, notifyChannel: "sms" as never }),
    ).rejects.toThrow("notifyChannel");
    await expect(store.update("u1", task.id, { notifyChannel: "email" as never })).rejects.toThrow("notifyChannel");

    const updated = await store.update("u1", task.id, { notifyChannel: "inapp" });
    expect(updated.notifyChannel).toBe("inapp");
    const cleared = await store.update("u1", task.id, {}); // 空 patch 原样保留
    expect(cleared.notifyChannel).toBe("inapp");
  });
});
