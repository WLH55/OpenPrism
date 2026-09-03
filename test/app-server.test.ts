// 批次1·server：HTTP 集成（真实 node:http 监听随机端口 + 全 mock adapter，零网络外呼）。
// 覆盖：注册/登录/401 门、会话消息驱动 Turn、SSE 首事件、/api/today 折叠、快速记录/作废/打卡、模型配置不回 Key。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths, type AppPaths } from "../src/app/store";
import { SessionStore, type UserRecord } from "../src/app/auth";
import { Ledger } from "../src/app/ledger";
import { ConversationStore } from "../src/app/conversations";
import { createAppServer } from "../src/app/server";
import { createMockLlmAdapter, type LlmAdapter } from "../src/harness/index";
import { sleep } from "./helpers";

let root: string;
let baseUrl: string;
let cookie: string;
let paths: AppPaths;
const users = new Map<string, UserRecord>();
const ledgers = new Map<string, Promise<Ledger>>();
const ledgerFor = (uid: string): Promise<Ledger> => {
  let ledger = ledgers.get(uid);
  if (!ledger) {
    ledger = Ledger.open(nodeFileIO, paths.lifeFile(uid));
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
  paths = appPaths(join(root, "data"));
  const masterKey = Buffer.alloc(32, 3);

  const { adapter } = createMockLlmAdapter([
    {
      kind: "tool-calls",
      calls: [{ name: "record_flow", arguments: { category: "餐饮", value: 28, unit: "¥", note: "午餐" } }],
    },
    { kind: "text", text: "记好了，午餐 28。" },
    { kind: "text", text: "在的。" },
  ]);

  const conversations = new ConversationStore({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    ledgerFor: async (uid) => await ledgerFor(uid),
    modelConfigFor: async () => ({ baseURL: "https://mock.local", model: "mock-1" }),
    adapterFactory: () => adapter as LlmAdapter,
    now: () => Date.now(),
  });

  const server = createAppServer({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    masterKey,
    users,
    sessions: new SessionStore(() => Date.now()),
    conversations,
    ledgerFor,
    modelTester: async () => {}, // 零网络：注入 fake 测试器
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
  shutdown = () => new Promise<void>((resolve) => server.close(() => resolve()));

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

  it("模型配置：PUT 后 GET 只回 hasKey，永不回 Key；测试连接走注入 adapter", async () => {
    const put = await fetch(`${baseUrl}/api/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ baseURL: "https://api.deepseek.com", apiKey: "sk-test-123", model: "deepseek-chat" }),
    });
    expect(put.status).toBe(200);
    const got = (await (await fetch(`${baseUrl}/api/model`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ baseURL: "https://api.deepseek.com", model: "deepseek-chat", hasKey: true });
    expect(JSON.stringify(got)).not.toContain("sk-test-123");
    const test = (await (await fetch(`${baseUrl}/api/model/test`, { method: "POST", headers: { cookie } })).json()) as {
      ok: boolean;
    };
    expect(test.ok).toBe(true);
  });
});
