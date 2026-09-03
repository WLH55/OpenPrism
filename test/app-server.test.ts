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
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { MemoryStore } from "../src/app/memory";
import { TaskStore } from "../src/app/tasks";
import { NotificationStore } from "../src/app/notify";
import type { TaskDef } from "../src/app/tasks";
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
    { kind: "text", text: "<!-- slot: recent -->\n测试期记忆已凝练。" }, // consolidate 用（排在聊天步骤之后）
  ]);

  const agents = new AgentStore({ fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => `aid-${Math.random().toString(36).slice(2, 8)}` });
  const skills = new SkillStore({ fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => `sk-${Math.random().toString(36).slice(2, 8)}` });
  const mcps = new McpRegistry({ env: nodeEnv, fileIO: nodeFileIO, paths, now: () => 1, randomUUID: () => "mc-x" });
  const memory = new MemoryStore({ fileIO: nodeFileIO, paths, now: () => 5000 });
  const tasks = new TaskStore({ fileIO: nodeFileIO, paths, now: () => 1000, randomUUID: () => `tid-${Math.random().toString(36).slice(2, 8)}` });
  const notifications = new NotificationStore({ fileIO: nodeFileIO, paths, now: () => 5000 });
  const conversations = new ConversationStore({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    ledgerFor,
    modelConfigFor: async () => ({ baseURL: "https://mock.local", model: "mock-1" }),
    adapterFactory: () => adapter as LlmAdapter,
    now: () => Date.now(),
    agents,
    skills,
    mcps,
    memory,
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
    adapterFor: async () => ({ adapter, model: "mock-1" }), // consolidate 也走同一 mock 脚本（末位步骤）
    agents,
    skills,
    mcps,
    memory,
    tasks,
    notifications,
    taskRunner: async (uidRun, task: TaskDef) => {
      await notifications.push(uidRun, { kind: "task_message", taskId: task.id, text: `（手动）${task.instruction}` });
    },
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


describe("HTTP API 批次2（agents/skills/mcps/memory/会话切换）", () => {
  it("agents：创建→列表→详情→改人设（名字重推导）→改绑定→删除", async () => {
    const created = (await (await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ persona: "# 教练\n盯训练。" }),
    })).json()) as { id: string; name: string };
    expect(created.name).toBe("教练");
    expect((await (await fetch(`${baseUrl}/api/agents`, { headers: { cookie } })).json()) as unknown[]).toHaveLength(1);
    const detail = (await (await fetch(`${baseUrl}/api/agents/${created.id}`, { headers: { cookie } })).json()) as { persona: string };
    expect(detail.persona).toContain("盯训练");
    const renamed = (await (await fetch(`${baseUrl}/api/agents/${created.id}/persona`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ markdown: "# 学姐\n温柔。" }),
    })).json()) as { name: string };
    expect(renamed.name).toBe("学姐");
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

  it("memory：空槽 → PUT slot → consolidate（注入 adapter，changed=true）→ 槽位落盘", async () => {
    const before = (await (await fetch(`${baseUrl}/api/memory`, { headers: { cookie } })).json()) as { slots: Record<string, string>; meta: { runs: number } };
    expect(before.slots.profile ?? "").toBe("");
    expect(before.meta.runs).toBe(0);
    expect((await fetch(`${baseUrl}/api/memory/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ markdown: "工程师" }),
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/memory/badslot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ markdown: "x" }),
    })).status).toBe(400);
    const consolidated = (await (await fetch(`${baseUrl}/api/memory/consolidate`, { method: "POST", headers: { cookie } })).json()) as { changed: boolean };
    expect(consolidated.changed).toBe(true);
    const after = (await (await fetch(`${baseUrl}/api/memory`, { headers: { cookie } })).json()) as { slots: Record<string, string>; meta: { runs: number } };
    expect(after.slots.recent).toContain("测试期记忆已凝练");
    expect(after.meta.runs).toBe(1);
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
    expect((await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as unknown[]).toHaveLength(1);
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
    expect((await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/tasks`, { headers: { cookie } })).json()) as unknown[]).toHaveLength(0);
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
