// 批次1·server：HTTP 集成（真实 node:http 监听随机端口 + 全 mock adapter，零网络外呼；存储 = :memory: SQLite）。
// 覆盖：注册/登录/401 门、会话消息驱动 Turn、SSE 首事件、/api/today 折叠、快速记录/作废/打卡、模型配置不回 Key。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpGet } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { readUserTz, SessionStore, type UserRecord } from "../src/app/auth";
import { Ledger } from "../src/app/ledger";
import { ConversationStore } from "../src/app/conversations";
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { MemoryStore } from "../src/app/memory";
import { MemoryExtractor } from "../src/app/memory-extract";
import { TaskStore } from "../src/app/tasks";
import { NotificationStore } from "../src/app/notify";
import { SqliteSessionLog } from "../src/app/session-log";
import type { TaskDef, TaskRunTrigger } from "../src/app/tasks";
import { createAppServer } from "../src/app/server";
import { WechatBridge } from "../src/app/wechat-bridge";
import { createMockLlmAdapter, type LlmAdapter } from "../src/harness/index";
import { testDb } from "./helpers-db";
import { sleep } from "./helpers";

let root: string;
let baseUrl: string;
let staticUrl: string;
let cookie: string;
let tasks: import("../src/app/tasks").TaskStore; // 列表失败反馈断言（2026-09-30）直接种运行记录
/** 会话装配读到的模型能力开关：本文件的图片消息用例按需翻转（模拟「模型接入」里的多模态勾选） */
let multimodalModel = false;
// ── 微信桥（2026-09-27）：fake iLink 注入（零网络），路由测试按需改写脚本 ──
const wechatScript = new Map<string, unknown>();
const wechatFetch = async (url: string): Promise<{ ok: boolean; status: number; headers: { get(): null }; json(): Promise<unknown>; text(): Promise<string> }> => {
  const hit = [...wechatScript.entries()].find(([prefix]) => url.includes(prefix));
  if (!hit) throw new Error(`fake iLink (server test): no script for ${url}`);
  const body = typeof hit[1] === "string" ? hit[1] : JSON.stringify(hit[1]);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body };
};
const db = testDb();
const users = new Map<string, UserRecord>();
const ledgers = new Map<string, Promise<Ledger>>();
const ledgerFor = (uid: string): Promise<Ledger> => {
  let ledger = ledgers.get(uid);
  if (!ledger) {
    ledger = Ledger.open(db, uid);
    ledgers.set(uid, ledger);
  }
  return ledger;
};

const json = (body: unknown): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-server-"));
  const masterKey = Buffer.alloc(32, 3);

  const { adapter } = createMockLlmAdapter([
    {
      kind: "tool-calls",
      calls: [{ name: "record_flow", arguments: { category: "餐饮", value: 28, unit: "¥", note: "午餐" } }],
    },
    { kind: "text", text: "记好了，午餐 28。" },
    // memory/extract：chat 段决策 add（决策制，2026-09-10 条目化）
    { kind: "text", text: '{"memories":[{"action":"add","target":null,"kind":"fact","topic":"测试链","content":"用户在测试记忆链","importance":3,"source":1,"expires_at":null}]}' },
    // memory/extract：后续段（mc1 会话/账本/任务）无新事实——任务 surface 因内置三件套非空（2026-09-29）多跑一段
    { kind: "text", text: '{"memories":[]}' },
    { kind: "text", text: '{"memories":[]}' },
    { kind: "text", text: '{"memories":[]}' },
  ]);

  const agents = new AgentStore({ db, now: () => 1, randomUUID: () => `aid-${Math.random().toString(36).slice(2, 8)}` });
  const skills = new SkillStore({ db, now: () => 1, randomUUID: () => `sk-${Math.random().toString(36).slice(2, 8)}` });
  const mcps = new McpRegistry({ env: nodeEnv, db, now: () => 1, randomUUID: () => "mc-x" });
  const memory = new MemoryStore({ db, now: () => 5000, randomUUID: () => `mid-${Math.random().toString(36).slice(2, 8)}` });
  const tasksStore = new TaskStore({ db, now: () => 1000, randomUUID: () => `tid-${Math.random().toString(36).slice(2, 8)}` });
  tasks = tasksStore;
  const notifications = new NotificationStore({ db, now: () => 5000 });
  const memoryExtractor = new MemoryExtractor({
    db,
    now: () => 5000,
    memory,
    adapterFor: async () => ({ adapter, model: "mock-1" }),
  });
  const conversations = new ConversationStore(
    {
      env: nodeEnv,
      sessionLog: (key) => Promise.resolve(SqliteSessionLog.open(db, key, () => Date.now())),
      ledgerFor,
      modelConfigFor: async () => ({ baseURL: "https://mock.local", model: "mock-1", ...(multimodalModel ? { multimodal: true } : {}) }),
      adapterFactory: () => adapter as LlmAdapter,
      now: () => Date.now(),
      // 与生产同形态（2026-09-29 时区 spec）：装配按 uid 读用户档案，未上报退服务器本机
      tzOffsetMinutes: (uid) => readUserTz(db, uid) ?? -new Date().getTimezoneOffset(),
      agents,
      skills,
      mcps,
      memory,
    },
    db,
  );

  const serverDeps = {
    env: nodeEnv,
    db,
    masterKey,
    users,
    sessions: new SessionStore(db, () => Date.now()),
    conversations,
    ledgerFor,
    modelTester: async () => {}, // 零网络：注入 fake 测试器
    adapterFor: async () => ({ adapter, model: "mock-1" }), // consolidate 也走同一 mock 脚本（末位步骤）
    agents,
    skills,
    mcps,
    memory,
    memoryExtractor,
    tasks,
    notifications,
    taskRunner: async (uidRun: string, task: TaskDef, run: TaskRunTrigger) => {
      await notifications.push(uidRun, { kind: "task_message", taskId: task.id, text: `（${run.kind}）${task.instruction}` });
    },
    wechat: new WechatBridge({ env: { ...nodeEnv, fetch: wechatFetch }, db, masterKey, conversations, notifications }),
  };
  const server = createAppServer(serverDeps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;

  // 静态托管专用实例：同一份 deps 挂临时静态目录（gzip 与缓存头断言用）
  const staticRoot = join(root, "static");
  await mkdir(join(staticRoot, "assets"), { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>OpenPrism</title>");
  await writeFile(join(staticRoot, "assets", "app-abc123.js"), 'console.log("op");\n'.repeat(400));
  await writeFile(join(staticRoot, "manifest.webmanifest"), JSON.stringify({ name: "OpenPrism" }));
  await writeFile(join(staticRoot, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const staticServer = createAppServer({ ...serverDeps, staticDir: staticRoot });
  await new Promise<void>((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  staticUrl = `http://127.0.0.1:${(staticServer.address() as { port: number }).port}`;
  shutdown = () => new Promise<void>((resolve) => server.close(() => staticServer.close(() => resolve())));

  // 唯一注册用户，cookie 供全部用例复用
  const res = await fetch(`${baseUrl}/api/auth/register`, json({ username: "lathan", password: "hunter2" }));
  expect(res.status).toBe(200);
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

let shutdown: () => Promise<void>;

afterAll(async () => {
  await shutdown();
  await rm(root, { recursive: true, force: true });
});

describe("HTTP API", () => {
  it("health 无需登录", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("未登录访问受保护端点 → 401", async () => {
    expect((await fetch(`${baseUrl}/api/today`)).status).toBe(401);
  });

  it("注册即建沙盒+账本+cookie；重名 409；错误口令 401", async () => {
    const user = users.get("lathan")!;
    expect(user.uid).toBeTruthy();
    expect(ledgers.get(user.uid)).toBeDefined(); // 注册即急切开账本（sync ledgerFor 的前提）
    expect(await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json()).toMatchObject({ username: "lathan" });
    const dup = await fetch(`${baseUrl}/api/auth/register`, json({ username: "lathan", password: "whatever1" }));
    expect(dup.status).toBe(409);
    const bad = await fetch(`${baseUrl}/api/auth/login`, json({ username: "lathan", password: "wrong!!" }));
    expect(bad.status).toBe(401);
  });

  it("聊天闭环：建会话→发消息→Turn 完成→今天页出现该笔流水（折叠 0 token）", async () => {
    const created = await fetch(`${baseUrl}/api/conversations`, {
      ...json({}),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(created.status).toBe(200);
    const conv = (await created.json()) as { id: string };

    const sent = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      ...json({ text: "中午吃面花了 28" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(sent.status).toBe(202);

    // 轮询日志直到 Turn 收口（小真实延迟 + 注入 sleep，符合仓库铁律 5）
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
      await sleep(25);
      const events = (await (
        await fetch(`${baseUrl}/api/conversations/${conv.id}/events`, { headers: { cookie } })
      ).json()) as { type: string }[];
      done = events.some((e) => e.type === "turn/end");
    }
    expect(done).toBe(true);

    const today = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
      flows: { category: string; value?: number }[];
    };
    expect(today.flows.some((f) => f.category === "餐饮" && f.value === 28)).toBe(true);
  });

  it("SSE 流：连接即收 status 事件", async () => {
    const list = (await (await fetch(`${baseUrl}/api/conversations`, { headers: { cookie } })).json()) as { id: string }[];
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/conversations/${list[0]!.id}/stream`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("data:");
    controller.abort();
  });

  it("会话归属（2026-09-27 越权补齐 + 打断端点）：他人 cid 的 messages/stop/stream 一律 404；本人空闲 stop 无害 200", async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, json({ username: "intruder", password: "hunter2" }));
    expect(reg.status).toBe(200);
    const otherCookie = reg.headers.get("set-cookie")!.split(";")[0]!;

    const created = await fetch(`${baseUrl}/api/conversations`, {
      ...json({}),
      headers: { "Content-Type": "application/json", cookie },
    });
    const conv = (await created.json()) as { id: string };

    const tamper = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      ...json({ text: "偷写" }),
      headers: { "Content-Type": "application/json", cookie: otherCookie },
    });
    expect(tamper.status).toBe(404);
    expect((await fetch(`${baseUrl}/api/conversations/${conv.id}/stop`, { method: "POST", headers: { cookie: otherCookie } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/conversations/${conv.id}/stream`, { headers: { cookie: otherCookie } })).status).toBe(404);
    // 越权写入一个字节都不落：日志里没有「偷写」
    const events = (await (
      await fetch(`${baseUrl}/api/conversations/${conv.id}/events`, { headers: { cookie } })
    ).json()) as { type: string; message?: { content?: { text?: string }[] } }[];
    expect(events.some((e) => e.message?.content?.some((b) => (b.text ?? "").includes("偷写")))).toBe(false);
    // 本人：空闲时 stop = 无回合可中止，无害返回 200（不消耗 mock 脚本）
    expect((await fetch(`${baseUrl}/api/conversations/${conv.id}/stop`, { method: "POST", headers: { cookie } })).status).toBe(200);
  });

  it("快速记录（ui 来源）→今天页可见；作废后消失", async () => {
    const posted = await fetch(`${baseUrl}/api/flows`, {
      ...json({ category: "运动", value: 30, unit: "分钟", note: "晨跑" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(posted.status).toBe(200);
    const record = (await posted.json()) as { seq: number };
    const mid = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
      flows: { category: string }[];
    };
    expect(mid.flows.some((f) => f.category === "运动")).toBe(true);
    const voided = await fetch(`${baseUrl}/api/void`, {
      ...json({ seq: record.seq }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(voided.status).toBe(200);
    const after = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
      flows: { category: string }[];
    };
    expect(after.flows.some((f) => f.category === "运动")).toBe(false);
  });

  it("UI 打卡：账本注入计划→checkin 端点→今天页 done=true；未知 planId 404", async () => {
    const uid = users.get("lathan")!.uid;
    const ledger = await ledgers.get(uid)!;
    await ledger.append({ kind: "plan", source: "ui", planId: "p-ui-1", title: "读书", scope: "day" });
    const checked = await fetch(`${baseUrl}/api/checkin`, {
      ...json({ planId: "p-ui-1" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(checked.status).toBe(200);
    const today = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
      plans: { planId: string; done: boolean }[];
    };
    expect(today.plans.find((p) => p.planId === "p-ui-1")!.done).toBe(true);
    const missing = await fetch(`${baseUrl}/api/checkin`, {
      ...json({ planId: "p-nope" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(missing.status).toBe(404);
  });

  it("计划 due 格式校验（评审 2026-09-29 簇 C）：非 ISO 日期 400——折叠层字典序键不容脏数据", async () => {
    for (const bad of ["2026/10/01", "2026-9-30", "2026-13-45", ""]) {
      const res = await fetch(`${baseUrl}/api/plans`, {
        ...json({ title: "坏日期", scope: "deadline", due: bad }),
        headers: { "Content-Type": "application/json", cookie },
      });
      expect(res.status, `due="${bad}"`).toBe(400);
    }
    expect((await fetch(`${baseUrl}/api/plans`, {
      ...json({ title: "好日期", scope: "deadline", due: "2026-10-04" }),
      headers: { "Content-Type": "application/json", cookie },
    })).status).toBe(200);
  });

  it("PUT /api/plans/:planId（2026-09-29）：改标题/due 生效、planId 不变、旧记录 void；未知 404、非法 scope 400", async () => {
    const uid = users.get("lathan")!.uid;
    const ledger = await ledgers.get(uid)!;
    const created = await fetch(`${baseUrl}/api/plans`, {
      ...json({ title: "交报告", scope: "deadline", due: "2026-10-05" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    const { planId } = (await created.json()) as { planId: string };
    const upd = await fetch(`${baseUrl}/api/plans/${planId}`, {
      ...json({ title: "交年度报告", due: "2026-10-10" }),
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(upd.status).toBe(200);
    const today = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
      plans: { planId: string; title: string; due?: string }[];
    };
    const plan = today.plans.find((p) => p.planId === planId)!;
    expect(plan.title).toBe("交年度报告");
    expect(plan.due).toBe("2026-10-10");
    expect(today.plans.filter((p) => p.planId === planId)).toHaveLength(1); // planId 稳定不重复
    // 修订留痕：账本里同 planId 两条 plan（旧版+新版），折叠层只剩新版（旧版被 void）
    const allOfPlan = ledger.readAll().filter((r) => r.kind === "plan" && (r as { planId: string }).planId === planId);
    expect(allOfPlan).toHaveLength(2);
    expect(ledger.activeRecords().filter((r) => r.kind === "plan" && (r as { planId: string }).planId === planId)).toHaveLength(1);
    expect(
      (
        await fetch(`${baseUrl}/api/plans/plan-nope`, {
          ...json({ title: "x" }),
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/api/plans/${planId}`, {
          ...json({ scope: "daily" }),
          method: "PUT",
          headers: { "Content-Type": "application/json", cookie },
        })
      ).status,
    ).toBe(400);
  });

  it("checkin 补卡（2026-09-29）：带 date 补历史卡 → today 的 checkins 出凭据；未来 400、非法格式 400", async () => {
    const uid = users.get("lathan")!.uid;
    const ledger = await ledgers.get(uid)!;
    await ledger.append({ kind: "plan", source: "ui", planId: "p-backfill", title: "背单词", scope: "week" });
    const yesterday = new Date(Date.now() - 86400000); // 真实时钟下取昨天（与既有 UI 打卡用例同模式，相对断言不依赖具体值）
    const dateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    const ok = await fetch(`${baseUrl}/api/checkin`, {
      ...json({ planId: "p-backfill", date: dateStr }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(ok.status).toBe(200);
    const today = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
      plans: { planId: string; checkins?: { seq: number; at: number }[] }[];
    };
    const plan = today.plans.find((p) => p.planId === "p-backfill")!;
    expect(plan.checkins).toHaveLength(1); // 补卡凭据可见（seq 供撤销）
    expect(
      (
        await fetch(`${baseUrl}/api/checkin`, {
          ...json({ planId: "p-backfill", date: "2999-01-01" }), // 绝对未来
          headers: { "Content-Type": "application/json", cookie },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/checkin`, {
          ...json({ planId: "p-backfill", date: "12-31" }), // 非法格式
          headers: { "Content-Type": "application/json", cookie },
        })
      ).status,
    ).toBe(400);
  });

  it("档案时区（2026-09-29）：profile 读写 tz；越界/非整数/字符串 400", async () => {
    const ok = await fetch(`${baseUrl}/api/auth/profile`, {
      ...json({ tzOffsetMinutes: 480 }),
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { tzOffsetMinutes?: number }).tzOffsetMinutes).toBe(480);
    const me = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json()) as { tzOffsetMinutes?: number };
    expect(me.tzOffsetMinutes).toBe(480);
    for (const bad of [9999, 1.5, "480"]) {
      const res = await fetch(`${baseUrl}/api/auth/profile`, {
        ...json({ tzOffsetMinutes: bad }),
        method: "PUT",
        headers: { "Content-Type": "application/json", cookie },
      });
      expect(res.status, `tz=${String(bad)}`).toBe(400);
    }
  });

  it("目标层级下线（2026-09-30 SDD）：/api/goals 全套 404；POST/PUT /api/plans 带 goalId → 400；历史 goal 行不可作废", async () => {
    const uid = users.get("lathan")!.uid;
    const ledger = await ledgers.get(uid)!;
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, { ...json(body), headers: { "Content-Type": "application/json", cookie } });

    // 路由整体下线：任何 method/path 组合都不再命中（落到 404）
    expect((await fetch(`${baseUrl}/api/goals`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/goals`, { ...json({ level: "direction", title: "x" }), headers: { "Content-Type": "application/json", cookie } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/goals/goal-x`, { ...json({ title: "x" }), method: "PUT", headers: { "Content-Type": "application/json", cookie } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/goals/goal-x`, { method: "DELETE", headers: { cookie } })).status).toBe(404);

    // 计划入口不再收 goalId（POST 与 PUT 同规）
    expect((await post("/api/plans", { title: "挂树尝试", scope: "day", goalId: "goal-any" })).status).toBe(400);
    const plan = (await (await post("/api/plans", { title: "普通计划", scope: "day" })).json()) as { planId: string };
    expect((await fetch(`${baseUrl}/api/plans/${plan.planId}`, { ...json({ goalId: "goal-any" }), method: "PUT", headers: { "Content-Type": "application/json", cookie } })).status).toBe(400);

    // 历史 goal 行休眠保留：直写一笔（模拟存量），/api/void 拒绝作废，today/plans 视图不受影响
    const goal = await ledger.append({ kind: "goal", source: "ui", goalId: "goal-hist1", level: "direction", title: "历史方向", status: "active" }, 1000);
    const legacy = await ledger.append({ kind: "plan", source: "ui", planId: "plan-hist0001", title: "挂过树的旧计划", scope: "deadline", due: "2099-01-01", goalId: "goal-hist1" }, 1001);
    expect((await post("/api/void", { seq: goal.seq })).status).toBe(400);
    const today = (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as { plans: { planId: string; goalTitle?: string }[] };
    const legacyRow = today.plans.find((p) => p.planId === "plan-hist0001")!;
    expect(legacyRow).toBeDefined(); // 挂树历史计划照常出现在今天视图（AC4 口径）
    expect(legacyRow.goalTitle).toBeUndefined(); // 「属于：xx」信号下线
    expect(legacy.seq).toBeGreaterThan(0); // 本行只为引用防误删（lint 语义）
  });

describe("HTTP API 批次2（agents/skills/mcps/memory/会话切换）", () => {
  it("agents：创建（带身份）→列表→详情→改人设（名字保留）→改身份→坏 avatar 400→改绑定→删除", async () => {
    const created = (await (await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "教练", persona: "# 教练\n盯训练。", emoji: "🐯", color: "#b0501e", language: "zh" }),
    })).json()) as { id: string; name: string };
    expect(created.name).toBe("教练");
    expect((await (await fetch(`${baseUrl}/api/agents`, { headers: { cookie } })).json()) as unknown[]).toHaveLength(1);
    const detail = (await (await fetch(`${baseUrl}/api/agents/${created.id}`, { headers: { cookie } })).json()) as { persona: string; identity: { emoji: string } };
    expect(detail.persona).toContain("盯训练");
    expect(detail.identity.emoji).toBe("🐯");
    const renamed = (await (await fetch(`${baseUrl}/api/agents/${created.id}/persona`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ markdown: "# 学姐\n温柔。" }),
    })).json()) as { name: string };
    expect(renamed.name).toBe("教练"); // 名字是显式资产，persona 编辑不改名
    const reidentity = (await (await fetch(`${baseUrl}/api/agents/${created.id}/identity`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "学姐" }),
    })).json()) as { name: string };
    expect(reidentity.name).toBe("学姐");
    const badAvatar = await fetch(`${baseUrl}/api/agents/${created.id}/identity`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ avatar: "http://evil" }),
    });
    expect(badAvatar.status).toBe(400);
    const bound = await fetch(`${baseUrl}/api/agents/${created.id}/binding`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ binding: { tools: ["query_ledger"], skills: [], mcps: [] } }),
    });
    expect(bound.status).toBe(200);
    expect(await (await fetch(`${baseUrl}/api/agents/${created.id}`, { method: "DELETE", headers: { cookie } })).json()).toMatchObject({ ok: true });
    expect((await (await fetch(`${baseUrl}/api/agents`, { headers: { cookie } })).json()) as unknown[]).toHaveLength(0);
  });

  it("skills：坏内容 400；好内容安装/列表/正文/删除", async () => {
    const bad = await fetch(`${baseUrl}/api/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ content: "没有 frontmatter" }),
    });
    expect(bad.status).toBe(400);
    const good = (await (await fetch(`${baseUrl}/api/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ content: "---\nname: 测试技能\ndescription: 测试用\n---\n\n# 正文\n内容" }),
    })).json()) as { id: string; name: string };
    expect(good.name).toBe("测试技能");
    const body = (await (await fetch(`${baseUrl}/api/skills/${good.id}/body`, { headers: { cookie } })).json()) as { body: string };
    expect(body.body).toContain("# 正文");
    await fetch(`${baseUrl}/api/skills/${good.id}`, { method: "DELETE", headers: { cookie } });
    expect((await (await fetch(`${baseUrl}/api/skills`, { headers: { cookie } })).json()) as unknown[]).toHaveLength(0);
  });

  it("mcps：非法 URL 400；未知 id 404", async () => {
    const bad = await fetch(`${baseUrl}/api/mcps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "x", url: "ftp://bad" }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/mcps/mc-nope/tools`, { method: "POST", headers: { cookie } });
    expect(missing.status).toBe(404);
    const delMissing = await fetch(`${baseUrl}/api/mcps/mc-nope`, { method: "DELETE", headers: { cookie } });
    expect(delMissing.status).toBe(404);
  });

  it("memory：手动加条目 → 提取（chat 决策 add）→ 条目列表/删除+墓碑 → 清空", async () => {
    const before = (await (await fetch(`${baseUrl}/api/memory`, { headers: { cookie } })).json()) as {
      counts: { total: number };
    };
    expect(before.counts.total).toBe(0);
    // 手动新增（origin=manual）
    const created = (await (await fetch(`${baseUrl}/api/memory/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ kind: "profile", content: "工程师", importance: 4 }),
    })).json()) as { item: { id: string; origin: string } };
    expect(created.item.origin).toBe("manual");
    // 种一个会话供提取（cid=mc1，chat 段水位线之上）
    db.prepare("INSERT INTO conversations (cid, uid, title, created_ts) VALUES ('mc1', ?, '测试会话', 1)").run(users.get("lathan")!.uid);
    db.prepare(
      "INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES ('mc1', 0, 'user/message', 1, 'user', ?)",
    ).run(JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "在测试记忆链" }] } }));

    const extract = (await (await fetch(`${baseUrl}/api/memory/extract`, { method: "POST", headers: { cookie } })).json()) as {
      added: number;
      skipped?: string;
    };
    expect(extract.added).toBe(1);
    expect(extract.skipped).toBeUndefined();
    const after = (await (await fetch(`${baseUrl}/api/memory`, { headers: { cookie } })).json()) as {
      counts: { total: number; active: number };
    };
    expect(after.counts.total).toBe(2);
    expect(after.counts.active).toBe(2);
    const items = (await (await fetch(`${baseUrl}/api/memory/items?status=active`, { headers: { cookie } })).json()) as {
      items: { id: string; content: string }[];
    };
    const extracted = items.items.find((i) => i.content.includes("测试记忆链"));
    expect(extracted).toBeDefined();
    // 删除（+墓碑：后台不再学回）
    expect((await fetch(`${baseUrl}/api/memory/items/${extracted!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/memory/items/${extracted!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);
    // 清空（需要 confirm）
    expect((await fetch(`${baseUrl}/api/memory/items`, { method: "DELETE", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({}) })).status).toBe(400);
    const cleared = (await (await fetch(`${baseUrl}/api/memory/items`, { method: "DELETE", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ confirm: "clear" }) })).json()) as { removed: number };
    expect(cleared.removed).toBe(1);
  });

  it("会话删除与自动命名端点：无用户消息命名不炸（ok:false）；删除后列表减少、再删 404", async () => {
    const list0 = (await (await fetch(`${baseUrl}/api/conversations`, { headers: { cookie } })).json()) as unknown[];
    const created = (await (await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    })).json()) as { id: string };
    const title = (await (await fetch(`${baseUrl}/api/conversations/${created.id}/title`, { method: "POST", headers: { cookie } })).json()) as { ok: boolean };
    expect(title.ok).toBe(false); // 无用户消息：不命名也不炸
    expect((await fetch(`${baseUrl}/api/conversations/${created.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    const list1 = (await (await fetch(`${baseUrl}/api/conversations`, { headers: { cookie } })).json()) as unknown[];
    expect(list1).toHaveLength(list0.length);
    expect((await fetch(`${baseUrl}/api/conversations/${created.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });

  it("会话 meta/切换：默认空 → 切到教练 → meta 生效；未知 404", async () => {
    const agent = (await (await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ persona: "# 教练\n盯。" }),
    })).json()) as { id: string };
    const conv = (await (await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    })).json()) as { id: string };
    const meta0 = (await (await fetch(`${baseUrl}/api/conversations/${conv.id}/meta`, { headers: { cookie } })).json()) as { switches: unknown[] };
    expect(meta0.switches).toEqual([]);
    expect((await fetch(`${baseUrl}/api/conversations/${conv.id}/agent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ agentId: agent.id }),
    })).status).toBe(200);
    const meta1 = (await (await fetch(`${baseUrl}/api/conversations/${conv.id}/meta`, { headers: { cookie } })).json()) as { agentId?: string; switches: unknown[] };
    expect(meta1.agentId).toBe(agent.id);
    expect(meta1.switches).toHaveLength(1);
    expect((await fetch(`${baseUrl}/api/conversations/${conv.id}/agent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ agentId: "aid-nope" }),
    })).status).toBe(404);
  });
});


describe("HTTP API 批次3（定时任务/通知）", () => {
  it("tasks：创建（坏 trigger 400）→列表→启停→手动跑→运行历史", async () => {
    const bad = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ title: "x", instruction: "y", trigger: { kind: "daily", time: "99:00" } }),
    });
    expect(bad.status).toBe(400);
    const created = (await (await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ title: "睡觉提醒", instruction: "提醒睡觉", trigger: { kind: "daily", time: "23:00" }, tzOffsetMinutes: 480 }),
    })).json()) as { id: string };
    expect(created.id).toMatch(/^tid-/);
    // 注册随号种入内置三件套（2026-09-29）：列表 = 3 内置 + 1 自建；内置标记与默认渠道齐
    const afterCreate = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as { builtin?: string; notifyChannel?: string }[];
    expect(afterCreate).toHaveLength(4);
    expect(afterCreate.filter((t) => t.builtin !== undefined).map((t) => t.builtin).sort()).toEqual(["daily-brief", "daily-report", "weekly-review"]);
    expect(afterCreate.every((t) => t.builtin === undefined || (t.notifyChannel ?? "inapp") === "inapp")).toBe(true);
    // HTTP 边界剥离客户端 id/builtin（评审 2026-09-29 B3）：伪造内置身份/抢占确定性 id 无效
    const spoof = (await (await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id: "builtin-daily-brief-hax", builtin: "daily-brief", title: "伪内置", instruction: "x", trigger: { kind: "daily", time: "09:00" } }),
    })).json()) as { id: string; builtin?: string };
    expect(spoof.id).not.toBe("builtin-daily-brief-hax");
    expect(spoof.builtin).toBeUndefined();
    expect((await fetch(`${baseUrl}/api/tasks/${spoof.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200); // 测试垃圾清理
    // 模板投影端点（评审 #13 单源）：三件套与内置任务同源，label 可读
    const templates = (await (await fetch(`${baseUrl}/api/tasks/templates`, { headers: { cookie } })).json()) as {
      builtin: string;
      title: string;
      label: string;
    }[];
    expect(templates.map((t) => t.builtin)).toEqual(["daily-brief", "daily-report", "weekly-review"]);
    expect(templates.every((t) => t.title !== "" && t.label !== "")).toBe(true);
    expect((await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    const run = await fetch(`${baseUrl}/api/tasks/${created.id}/run`, { method: "POST", headers: { cookie } });
    expect(run.status).toBe(202);
    let runs: { status: string }[] = [];
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      runs = (await (await fetch(`${baseUrl}/api/tasks/${created.id}/runs`, { headers: { cookie } })).json()) as { status: string }[];
      if (runs.length > 0) break;
    }
    expect(runs.at(-1)).toMatchObject({ status: "ran" });
    // 手动触发要标明来路：注入上下文按 "manual" 写"用户点了立即跑"，不冒充到点触发
    const notices = (await (await fetch(`${baseUrl}/api/notifications`, { headers: { cookie } })).json()) as { text: string }[];
    expect(notices.some((n) => n.text.startsWith("（manual）"))).toBe(true);
    // 列表附最近一次运行（2026-09-30 失败反馈）：failed + detail 直接随 GET /api/tasks 下发，任务行就地可见
    await tasks.recordRun(users.get("lathan")!.uid, created.id, { ts: 2_000, status: "failed", detail: "余额不足" });
    const withLast = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as {
      id: string;
      lastRun?: { ts: number; status: string; detail?: string } | null;
    }[];
    expect(withLast.find((t) => t.id === created.id)?.lastRun).toMatchObject({ status: "failed", detail: "余额不足" });
    expect(withLast.find((t) => t.id.startsWith("builtin-daily-brief"))?.lastRun).toBe(null); // 未跑过的任务显式 null
    expect((await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    const afterDelete = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as unknown[];
    expect(afterDelete).toHaveLength(3); // 只剩内置三件套（自建已删）
  });

  it("任务编辑入口（2026-09-30，AC5/AC6）：PUT 全字段编辑生效；内置改文案置 customized、resetInstruction 还原；非内置 reset 拒绝", async () => {
    const put = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, { ...json(body), method: "PUT", headers: { "Content-Type": "application/json", cookie } }); // method 必须放在 ...json 之后（json() 设 POST）
    const created = (await (await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ title: "编辑目标", instruction: "原指令", trigger: { kind: "daily", time: "23:00" } }),
    })).json()) as { id: string };

    // 全字段编辑（AC5）：标题/指令/调度/渠道一次 PUT 全生效
    const edited = (await (await put(`/api/tasks/${created.id}`, {
      title: "改名了",
      instruction: "新指令",
      trigger: { kind: "weekly", days: [1, 3], time: "09:30" },
      notifyChannel: "wechat",
    })).json()) as { title: string; instruction: string; trigger: { kind: string; time: string }; notifyChannel?: string };
    expect(edited.title).toBe("改名了");
    expect(edited.instruction).toBe("新指令");
    expect(edited.trigger).toMatchObject({ kind: "weekly", time: "09:30" });
    expect(edited.notifyChannel).toBe("wechat");

    // 内置任务：改指令 → customized 置位（启动同步跳过的标记随行返回）
    const list = (await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as {
      id: string;
      builtin?: string;
    }[];
    const brief = list.find((t) => t.builtin === "daily-brief")!;
    const customized = (await (await put(`/api/tasks/${brief.id}`, { instruction: "我的简报口径" })).json()) as {
      customized?: boolean;
      instruction: string;
    };
    expect(customized.customized).toBe(true);
    // resetInstruction：还原默认文案 + 清除标记
    const restored = (await (await put(`/api/tasks/${brief.id}`, { resetInstruction: true })).json()) as {
      customized?: boolean;
      instruction: string;
    };
    expect(restored.customized).toBeUndefined();
    expect(restored.instruction).not.toBe("我的简报口径");
    // 非内置 resetInstruction → 明确报错（server 统一 404 + message）
    const resetNonBuiltin = await put(`/api/tasks/${created.id}`, { resetInstruction: true });
    expect(resetNonBuiltin.status).toBe(404);
    expect(((await resetNonBuiltin.json()) as { error: string }).error).toContain("只适用于内置任务");
    // 清理
    await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: "DELETE", headers: { cookie } });
  });

  it("习惯计划 HTTP（2026-09-30 习惯化，AC1/AC3）：POST /api/plans 带配额落账、today 视图带进度；非法值与一次性 scope 400；PUT 修订配额", async () => {
    const postPlan = (body: unknown) => fetch(`${baseUrl}/api/plans`, { ...json(body), headers: { "Content-Type": "application/json", cookie } });
    expect((await postPlan({ title: "坏配额", scope: "week", timesPerPeriod: 0 })).status).toBe(400);
    expect((await postPlan({ title: "坏配额", scope: "week", timesPerPeriod: 1.5 })).status).toBe(400);
    expect((await postPlan({ title: "坏配额", scope: "deadline", due: "2026-10-10", timesPerPeriod: 3 })).status).toBe(400);
    const habit = (await (await postPlan({ title: "每周运动三天", scope: "week", timesPerPeriod: 3 })).json()) as { planId: string };

    // 打一次卡 → today 视图 1/3 进行中（tz=480 本地口径）
    await fetch(`${baseUrl}/api/checkin`, { ...json({ planId: habit.planId, done: true }), headers: { "Content-Type": "application/json", cookie } });
    const todayOf = async () =>
      (await (await fetch(`${baseUrl}/api/today?tz=480`, { headers: { cookie } })).json()) as {
        plans: { planId: string; state: string; timesPerPeriod?: number; periodCount?: number }[];
        top3: { planId?: string; progress?: string }[];
      };
    const row = (await todayOf()).plans.find((p) => p.planId === habit.planId)!;
    expect(row).toMatchObject({ state: "doing", timesPerPeriod: 3, periodCount: 1 }); // 一卡 ≠ 已完成（用户原始诉求）
    expect((await todayOf()).top3.find((t) => t.planId === habit.planId)?.progress).toBe("1/3");

    // PUT 修订：配额 3→4（mergePlanUpdate 同源）
    const updated = await fetch(`${baseUrl}/api/plans/${habit.planId}`, {
      ...json({ timesPerPeriod: 4 }),
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(updated.status).toBe(200);
    const row2 = (await todayOf()).plans.find((p) => p.planId === habit.planId)!;
    expect(row2.timesPerPeriod).toBe(4);
    expect(row2.periodCount).toBe(1); // 打卡跨修订保留（planId 稳定）
  });

  it("数据导出（2026-09-30 SDD）：JSON 全量附件含账本与会话事件；MD 时间线含日期分组与对话轮次；未登录 401", async () => {
    // AC3：未登录被全局闸拦下
    expect((await fetch(`${baseUrl}/api/export/data.json`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/export/data.md`)).status).toBe(401);

    // AC1：JSON 全量下载——attachment 头 + 账本记录 + 会话事件（此前批次落的数据都在）
    const jsonRes = await fetch(`${baseUrl}/api/export/data.json`, { headers: { cookie } });
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-disposition")).toContain("attachment");
    expect(jsonRes.headers.get("content-disposition")).toContain("openprism-export-");
    const parsed = (await jsonRes.json()) as {
      exportedAt: string;
      ledger: { kind: string }[];
      conversations: { cid: string; events: { type: string }[] }[];
    };
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.ledger.length).toBeGreaterThan(0);
    expect(parsed.ledger.some((r) => r.kind === "plan")).toBe(true);
    expect(parsed.conversations.length).toBeGreaterThan(0);
    expect(parsed.conversations.some((c) => c.events.some((e) => e.type === "user/message"))).toBe(true);

    // AC2：MD 人读时间线
    const mdRes = await fetch(`${baseUrl}/api/export/data.md`, { headers: { cookie } });
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toContain("text/markdown");
    const md = await mdRes.text();
    expect(md).toContain("# OpenPrism 数据导出");
    expect(md).toContain("## 生活记录");
    expect(md).toMatch(/### \d{4}-\d{2}-\d{2} 周./); // 日期分组标题（含星期）
    expect(md).toContain("## 对话记录");
    expect(md).toContain("**用户**");
    expect(md).toContain("**助手**");
  });

  it("notifications：手动跑产出未读→全部已读", async () => {
    let unreadBefore: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      unreadBefore = (await (await fetch(`${baseUrl}/api/notifications?unread=1`, { headers: { cookie } })).json()) as unknown[];
      if (unreadBefore.length > 0) break;
    }
    expect(unreadBefore.length).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${baseUrl}/api/notifications/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ all: true }),
    })).status).toBe(200);
    const unreadAfter = (await (await fetch(`${baseUrl}/api/notifications?unread=1`, { headers: { cookie } })).json()) as unknown[];
    expect(unreadAfter).toHaveLength(0);
  });
});


describe("HTTP API 批次4（盘面/成长/合并归档/硬化）", () => {
  it("安全头常在", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("盘面：目录/分类页/进步页/合并/归档/取消归档", async () => {
    await fetch(`${baseUrl}/api/flows`, { ...json({ category: "盘面运动", value: 30 }), headers: { "Content-Type": "application/json", cookie } });
    await fetch(`${baseUrl}/api/flows`, { ...json({ category: "盘面餐饮", value: 28 }), headers: { "Content-Type": "application/json", cookie } });
    const panels = (await (await fetch(`${baseUrl}/api/panels`, { headers: { cookie } })).json()) as { categories: { category: string; count: number }[] };
    const names = panels.categories.map((c) => c.category);
    expect(names).toContain("盘面运动");
    expect(names).toContain("盘面餐饮");

    const category = (await (await fetch(`${baseUrl}/api/panels/category/盘面运动?period=week`, { headers: { cookie } })).json()) as { count: number; daily: unknown[] };
    expect(category.count).toBe(1);
    expect(category.daily).toHaveLength(30);

    const progress = (await (await fetch(`${baseUrl}/api/panels/progress`, { headers: { cookie } })).json()) as { streakDays: number; trend14: unknown[] };
    expect(progress.streakDays).toBeGreaterThanOrEqual(1);
    expect(progress.trend14).toHaveLength(14);

    // 合并：盘面运动 → 盘面餐饮
    await fetch(`${baseUrl}/api/panels/merge`, { ...json({ from: "盘面运动", to: "盘面餐饮" }), headers: { "Content-Type": "application/json", cookie } });
    const afterMerge = (await (await fetch(`${baseUrl}/api/panels`, { headers: { cookie } })).json()) as { categories: { category: string; count: number }[] };
    expect(afterMerge.categories.map((c) => c.category)).not.toContain("盘面运动");
    expect(afterMerge.categories.find((c) => c.category === "盘面餐饮")!.count).toBeGreaterThanOrEqual(2);

    // 归档/取消
    await fetch(`${baseUrl}/api/panels/archive`, { ...json({ name: "盘面餐饮" }), headers: { "Content-Type": "application/json", cookie } });
    const archived = (await (await fetch(`${baseUrl}/api/panels`, { headers: { cookie } })).json()) as { categories: { category: string }[]; archived: string[] };
    expect(archived.categories.map((c) => c.category)).not.toContain("盘面餐饮");
    expect(archived.archived).toContain("盘面餐饮");
    await fetch(`${baseUrl}/api/panels/unarchive`, { ...json({ name: "盘面餐饮" }), headers: { "Content-Type": "application/json", cookie } });
    const restored = (await (await fetch(`${baseUrl}/api/panels`, { headers: { cookie } })).json()) as { categories: { category: string }[] };
    expect(restored.categories.map((c) => c.category)).toContain("盘面餐饮");
  });

  it("认证限速：同 IP+用户名 1 分钟超 10 次尝试 → 429", async () => {
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, json({ username: "ratelimit-target", password: "wrong-password" }));
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

  it("多模型接入：新增（Key 只回 hasKey 永不回传）→ 列表 → 切换激活 → 删除回落；测试连接走注入 adapter", async () => {
    const addA = (await (await fetch(`${baseUrl}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ baseURL: "https://api.deepseek.com", apiKey: "sk-test-123", model: "deepseek-chat", contextWindow: 128000 }),
    })).json()) as { id: string };
    const listA = (await (await fetch(`${baseUrl}/api/models`, { headers: { cookie } })).json()) as {
      activeId: string | null;
      providers: { id: string; platform: string; contextWindow: number | null; hasKey: boolean }[];
    };
    expect(listA.activeId).toBe(addA.id); // 首个自动激活
    expect(listA.providers[0]).toMatchObject({ platform: "DeepSeek", contextWindow: 128000, hasKey: true });
    expect(JSON.stringify(listA)).not.toContain("sk-test-123");
    expect((await (await fetch(`${baseUrl}/api/model`, { headers: { cookie } })).json()) as Record<string, unknown>).toMatchObject({
      baseURL: "https://api.deepseek.com",
      model: "deepseek-chat",
      hasKey: true,
    });

    const addB = (await (await fetch(`${baseUrl}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" }),
    })).json()) as { id: string };
    const listB = (await (await fetch(`${baseUrl}/api/models`, { headers: { cookie } })).json()) as { activeId: string | null };
    expect(listB.activeId).toBe(addA.id); // 新增不抢激活
    expect((await fetch(`${baseUrl}/api/models/${addB.id}/active`, { method: "PUT", headers: { cookie } })).status).toBe(200);
    const activeNow = (await (await fetch(`${baseUrl}/api/model`, { headers: { cookie } })).json()) as { model: string };
    expect(activeNow.model).toBe("glm-4.6");

    const badAdd = await fetch(`${baseUrl}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ baseURL: "ftp://bad", model: "x" }),
    });
    expect(badAdd.status).toBe(400);
    const badWindow = await fetch(`${baseUrl}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ baseURL: "https://ok.com", model: "x", contextWindow: 5 }),
    });
    expect(badWindow.status).toBe(400);

    const testConn = (await (await fetch(`${baseUrl}/api/models/${addA.id}/test`, { method: "POST", headers: { cookie } })).json()) as { ok: boolean };
    expect(testConn.ok).toBe(true);

    expect((await fetch(`${baseUrl}/api/models/${addB.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    const listAfter = (await (await fetch(`${baseUrl}/api/models`, { headers: { cookie } })).json()) as { activeId: string | null; providers: unknown[] };
    expect(listAfter.providers).toHaveLength(1);
    expect(listAfter.activeId).toBe(addA.id); // 删激活行 → 回落到剩余的最近一个
  });
});

describe("HTTP API 批次5（多模态图片与个人资料）", () => {
  /** 合法 PNG 头 + 填充：附件校验只认签名，测试不依赖真实图片解码 */
  const PNG_BASE64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]).toString("base64");
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
  const put = (path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });

  it("个人资料：me 默认空形象 → 保存 emoji/色盘/头像 → me 反映；外链头像 400；空串清空", async () => {
    const before = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json()) as {
      face: { avatar: string; emoji: string; color: string };
    };
    expect(before.face).toEqual({ avatar: "", emoji: "", color: "" });

    const saved = (await (await put("/api/auth/profile", { emoji: "🦊", color: "#b0501e", avatar: "data:image/png;base64,AAAA" })).json()) as {
      username: string;
      face: { avatar: string; emoji: string; color: string };
    };
    expect(saved.username).toBe("lathan");
    expect(saved.face).toEqual({ avatar: "data:image/png;base64,AAAA", emoji: "🦊", color: "#b0501e" });

    const after = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json()) as { face: unknown };
    expect(after.face).toEqual(saved.face);

    expect((await put("/api/auth/profile", { avatar: "http://evil/a.png" })).status).toBe(400);
    const cleared = (await (await put("/api/auth/profile", { avatar: "" })).json()) as { face: { avatar: string } };
    expect(cleared.face.avatar).toBe("");
  });

  it("模型多模态开关：新增带标记 → 列表带出 → PUT 可改；embedding 用途强制关掉；非布尔 400", async () => {
    const vision = (await (await post("/api/models", { baseURL: "https://api.openai.com/v1", model: "gpt-5.2", multimodal: true })).json()) as {
      id: string;
    };
    const listed = (await (await fetch(`${baseUrl}/api/models`, { headers: { cookie } })).json()) as {
      providers: { id: string; multimodal: boolean; kind: string }[];
    };
    expect(listed.providers.find((p) => p.id === vision.id)).toMatchObject({ multimodal: true, kind: "chat" });

    expect((await put(`/api/models/${vision.id}`, { multimodal: false })).status).toBe(200);
    const off = (await (await fetch(`${baseUrl}/api/models`, { headers: { cookie } })).json()) as {
      providers: { id: string; multimodal: boolean }[];
    };
    expect(off.providers.find((p) => p.id === vision.id)!.multimodal).toBe(false);
    expect((await put(`/api/models/${vision.id}`, { multimodal: true })).status).toBe(200);

    const embedding = (await (
      await post("/api/models", { baseURL: "https://api.jina.ai/v1", model: "jina-embeddings-v5-text-small", kind: "embedding", multimodal: true })
    ).json()) as { id: string };
    const withEmbedding = (await (await fetch(`${baseUrl}/api/models`, { headers: { cookie } })).json()) as {
      providers: { id: string; multimodal: boolean; kind: string }[];
    };
    expect(withEmbedding.providers.find((p) => p.id === embedding.id)).toMatchObject({ multimodal: false, kind: "embedding" });

    expect((await post("/api/models", { baseURL: "https://x.example.com/v1", model: "x", multimodal: "也许" })).status).toBe(400);

    // 清理：删掉本用例新增的两行，后面的用例按原有供应商列表断言
    await fetch(`${baseUrl}/api/models/${vision.id}`, { method: "DELETE", headers: { cookie } });
    await fetch(`${baseUrl}/api/models/${embedding.id}`, { method: "DELETE", headers: { cookie } });
  });

  it("图片消息：模型没勾多模态 → 409 model_not_multimodal；勾上后图片块随消息落库", async () => {
    const attachment = { kind: "image", name: "shot.png", mediaType: "image/png", dataBase64: PNG_BASE64 };
    const plainConv = (await (await post("/api/conversations", {})).json()) as { id: string };

    const rejected = await post(`/api/conversations/${plainConv.id}/messages`, { text: "看看这张", attachments: [attachment] });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { code?: string }).code).toBe("model_not_multimodal");
    const eventsAfterReject = (await (await fetch(`${baseUrl}/api/conversations/${plainConv.id}/events`, { headers: { cookie } })).json()) as unknown[];
    expect(eventsAfterReject).toHaveLength(0); // 回合没开始，一条事件都不落

    const malformed = await post(`/api/conversations/${plainConv.id}/messages`, {
      text: "坏附件",
      attachments: [{ kind: "image", name: "a.png", mediaType: "image/png", dataBase64: "!!!not base64!!!" }],
    });
    expect(malformed.status).toBe(400);
    expect(((await post(`/api/conversations/${plainConv.id}/messages`, { text: "空消息", attachments: [{ kind: "file", name: "a.md", mediaType: "text/markdown", text: " " }] })).status)).toBe(400);

    multimodalModel = true;
    try {
      const visionConv = (await (await post("/api/conversations", {})).json()) as { id: string };
      const accepted = await post(`/api/conversations/${visionConv.id}/messages`, {
        text: "看看这张",
        attachments: [attachment, { kind: "file", name: "note.md", mediaType: "text/markdown", text: "# 备注" }],
      });
      expect(accepted.status).toBe(202);

      let events: { type: string; message?: { content: unknown[] } }[] = [];
      for (let i = 0; i < 120; i++) {
        await sleep(25);
        events = (await (await fetch(`${baseUrl}/api/conversations/${visionConv.id}/events`, { headers: { cookie } })).json()) as typeof events;
        if (events.some((e) => e.type === "turn/end")) break;
      }
      const userEvent = events.find((e) => e.type === "user/message")!;
      expect(userEvent.message!.content).toEqual([
        { type: "text", text: "看看这张" },
        { type: "image", mediaType: "image/png", data: PNG_BASE64 },
        { type: "file", name: "note.md", mediaType: "text/markdown", text: "# 备注" },
      ]);
    } finally {
      multimodalModel = false;
    }
  });

  it("历史里有图片时切换模型/伙伴到不支持图片的模型 → 409", async () => {
    multimodalModel = true;
    try {
      const conv = (await (await post("/api/conversations", {})).json()) as { id: string };
      expect(
        (
          await post(`/api/conversations/${conv.id}/messages`, {
            text: "看图",
            attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", dataBase64: PNG_BASE64 }],
          })
        ).status,
      ).toBe(202);
      for (let i = 0; i < 120; i++) {
        await sleep(25);
        const events = (await (await fetch(`${baseUrl}/api/conversations/${conv.id}/events`, { headers: { cookie } })).json()) as { type: string }[];
        if (events.some((e) => e.type === "turn/end")) break;
      }
      multimodalModel = false;
      const plain = (await (await post("/api/models", { baseURL: "https://api.deepseek.com", model: "deepseek-chat" })).json()) as { id: string };
      const switched = await put(`/api/conversations/${conv.id}/model`, { providerId: plain.id });
      expect(switched.status).toBe(409);
      expect(((await switched.json()) as { code?: string }).code).toBe("model_not_multimodal");
      await fetch(`${baseUrl}/api/models/${plain.id}`, { method: "DELETE", headers: { cookie } });
    } finally {
      multimodalModel = false;
    }
  });
});

describe("静态托管与会话事件分段（2026-09-23 手机浏览器适配）", () => {
  /** 裸 HTTP 请求：不经 fetch 的透明解压，直接看原始响应头与字节 */
  const rawGet = (urlStr: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      httpGet(urlStr, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      }).on("error", reject);
    });

  it("gzip：Accept-Encoding 带 gzip 时文本资源压缩返回，Vary 与长缓存头正确", async () => {
    const res = await rawGet(`${staticUrl}/assets/app-abc123.js`, { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(gunzipSync(res.body).toString("utf8")).toBe('console.log("op");\n'.repeat(400));
  });

  it("不带 Accept-Encoding 时原样返回；PNG 二进制不压缩", async () => {
    const js = await rawGet(`${staticUrl}/assets/app-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers["content-encoding"]).toBeUndefined();
    expect(js.body.toString("utf8")).toBe('console.log("op");\n'.repeat(400));
    const png = await rawGet(`${staticUrl}/icon.png`, { "Accept-Encoding": "gzip" });
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["cache-control"]).toBe("public, max-age=604800");
  });

  it("入口与清单不缓存；webmanifest 的 Content-Type 正确", async () => {
    const html = await rawGet(`${staticUrl}/`);
    expect(html.status).toBe(200);
    expect(String(html.headers["content-type"])).toContain("text/html");
    expect(html.headers["cache-control"]).toBe("no-cache");
    const manifest = await rawGet(`${staticUrl}/manifest.webmanifest`, { "Accept-Encoding": "gzip" });
    expect(String(manifest.headers["content-type"])).toContain("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("no-cache");
  });

  it("events 归属校验：他人会话 404，本人 200", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: "{}" })
    ).json()) as { id: string };
    const mine = await fetch(`${baseUrl}/api/conversations/${created.id}/events`, { headers: { cookie } });
    expect(mine.status).toBe(200);

    const reg = await fetch(`${baseUrl}/api/auth/register`, json({ username: "intruder-1", password: "hunter2" }));
    expect(reg.status).toBe(200);
    const intruderCookie = reg.headers.get("set-cookie")!.split(";")[0]!;
    const other = await fetch(`${baseUrl}/api/conversations/${created.id}/events`, { headers: { cookie: intruderCookie } });
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("user/message");
  });

  it("events 分段：limit 取最近、before 向上翻页、非法参数 400", async () => {
    const cid = "paging-conv-1";
    db.prepare("INSERT INTO conversations (cid, uid, title, created_ts) VALUES (?, ?, '分段', 1000)").run(cid, users.get("lathan")!.uid);
    const insert = db.prepare(
      "INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, 'user/message', ?, 'user', ?)",
    );
    for (let i = 0; i < 7; i++) {
      insert.run(cid, i, i, JSON.stringify({ type: "user/message", seq: i, ts: i, message: { role: "user", content: [{ type: "text", text: "m" + i }] } }));
    }
    const seqsOf = async (query: string) => {
      const res = await fetch(`${baseUrl}/api/conversations/${cid}/events${query}`, { headers: { cookie } });
      const body = (await res.json()) as { seq: number }[] | { error: string };
      // 400 用例的 body 是 {error}，只有 200 才是事件数组
      return { status: res.status, seqs: Array.isArray(body) ? body.map((e) => e.seq) : [] };
    };
    expect(await seqsOf("")).toEqual({ status: 200, seqs: [0, 1, 2, 3, 4, 5, 6] });
    expect(await seqsOf("?limit=3")).toEqual({ status: 200, seqs: [4, 5, 6] });
    expect(await seqsOf("?limit=3&before=4")).toEqual({ status: 200, seqs: [1, 2, 3] });
    expect(await seqsOf("?limit=5&before=1")).toEqual({ status: 200, seqs: [0] });
    expect(await seqsOf("?limit=5&before=0")).toEqual({ status: 200, seqs: [] });
    expect((await seqsOf("?limit=0")).status).toBe(400);
    expect((await seqsOf("?limit=201")).status).toBe(400);
    expect((await seqsOf("?before=-1")).status).toBe(400);
    expect((await seqsOf("?before=abc")).status).toBe(400);
  });
});

describe("微信桥路由（2026-09-27 iLink 绑定）", () => {
  it("401 门：未登录四个端点全拒", async () => {
    expect((await fetch(`${baseUrl}/api/wechat/bind/qrcode`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/wechat/bind/status?qrcode=x`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/wechat/bind`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/wechat/bind`, { method: "DELETE" })).status).toBe(401);
  });

  it("绑定闭环：qrcode → status(confirmed) 落库启动 → 状态 active → 解绑", async () => {
    wechatScript.set("/ilink/bot/get_bot_qrcode", { qrcode: "qr-1", qrcode_img_content: "https://img.local/qr-1.png" });
    wechatScript.set("/ilink/bot/get_qrcode_status", {
      status: "confirmed",
      bot_token: "bt-server-1",
      ilink_bot_id: "ib-server-1",
      ilink_user_id: "iu-server-1",
    });
    wechatScript.set("/ilink/bot/sendmessage", { ret: 0, errcode: 0 }); // 欢迎语

    const qr = await fetch(`${baseUrl}/api/wechat/bind/qrcode`, { method: "POST", headers: { cookie } });
    expect(qr.status).toBe(200);
    expect(await qr.json()).toEqual({ qrcode: "qr-1", content: "https://img.local/qr-1.png" });

    expect((await fetch(`${baseUrl}/api/wechat/bind/status`, { headers: { cookie } })).status).toBe(400); // 缺 qrcode

    const confirmed = await fetch(`${baseUrl}/api/wechat/bind/status?qrcode=qr-1`, { headers: { cookie } });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ status: "confirmed" });

    const state = (await (await fetch(`${baseUrl}/api/wechat/bind`, { headers: { cookie } })).json()) as {
      bound: boolean;
      state: string;
      ilinkBotId?: string;
    };
    expect(state).toEqual({ bound: true, state: "active", ilinkBotId: "ib-server-1" });

    // 任务通知渠道：非法值 400，wechat 落库往返
    const bad = await fetch(`${baseUrl}/api/tasks`, {
      ...json({ title: "t", instruction: "i", trigger: { kind: "daily", time: "09:00" }, notifyChannel: "sms" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${baseUrl}/api/tasks`, {
      ...json({ title: "喝水", instruction: "提醒喝水", trigger: { kind: "daily", time: "09:00" }, notifyChannel: "wechat" }),
      headers: { "Content-Type": "application/json", cookie },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { notifyChannel?: string }).notifyChannel).toBe("wechat");

    const unbind = await fetch(`${baseUrl}/api/wechat/bind`, { method: "DELETE", headers: { cookie } });
    expect(unbind.status).toBe(200);
    expect(await (await fetch(`${baseUrl}/api/wechat/bind`, { headers: { cookie } })).json()).toEqual({ bound: false, state: "active" });
  });

  it("iLink 故障上抛 502（如二维码接口报错）", async () => {
    wechatScript.delete("/ilink/bot/get_bot_qrcode");
    const fail = await fetch(`${baseUrl}/api/wechat/bind/qrcode`, { method: "POST", headers: { cookie } });
    expect(fail.status).toBe(502);
  });

  it("qrcode 归属校验：他人账号持码轮询 → 403；申请人本人正常", async () => {
    wechatScript.set("/ilink/bot/get_bot_qrcode", { qrcode: "qr-o", qrcode_img_content: "https://img.local/o.png" });
    wechatScript.set("/ilink/bot/get_qrcode_status", { status: "wait" });
    const qr = await fetch(`${baseUrl}/api/wechat/bind/qrcode`, { method: "POST", headers: { cookie } });
    expect(qr.status).toBe(200);

    const reg = await fetch(`${baseUrl}/api/auth/register`, json({ username: "wx-other", password: "pass-1" }));
    expect(reg.status).toBe(200);
    const otherCookie = reg.headers.get("set-cookie")!.split(";")[0]!;

    const hijack = await fetch(`${baseUrl}/api/wechat/bind/status?qrcode=qr-o`, { headers: { cookie: otherCookie } });
    expect(hijack.status).toBe(403); // 把他人扫码确认的 bot 绑到自己账号——拦
    const mine = await fetch(`${baseUrl}/api/wechat/bind/status?qrcode=qr-o`, { headers: { cookie } });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ status: "wait" });
  });

  it("微信对话伙伴（2026-09-28 增补）：401 门；默认 null → 切到具体 → 切回 null；非法 id 404", async () => {
    expect((await fetch(`${baseUrl}/api/wechat/bind/agent`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/wechat/bind/agent`, { ...json({ agentId: null }), headers: { "Content-Type": "application/json" } })).status).toBe(401);

    const initial = (await (await fetch(`${baseUrl}/api/wechat/bind/agent`, { headers: { cookie } })).json()) as { agentId: string | null };
    expect(initial.agentId).toBeNull(); // 会话未建/未绑定 = 默认助手

    const created = (await (await fetch(`${baseUrl}/api/agents`, {
      ...json({ name: "教练", persona: "# 教练\n盯训练。" }),
      headers: { "Content-Type": "application/json", cookie },
    })).json()) as { id: string };

    const put = (agentId: string | null) =>
      fetch(`${baseUrl}/api/wechat/bind/agent`, { ...json({ agentId }), method: "PUT", headers: { "Content-Type": "application/json", cookie } });

    expect((await put(created.id)).status).toBe(200);
    expect(((await (await fetch(`${baseUrl}/api/wechat/bind/agent`, { headers: { cookie } })).json()) as { agentId: string | null }).agentId).toBe(created.id);

    expect((await put(null)).status).toBe(200);
    expect(((await (await fetch(`${baseUrl}/api/wechat/bind/agent`, { headers: { cookie } })).json()) as { agentId: string | null }).agentId).toBeNull();

    expect((await put("aid-nope")).status).toBe(404);
  });
});
