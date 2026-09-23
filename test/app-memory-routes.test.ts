// 主题计数与向量配置路由（2026-09-18 Spec §4.3 checklist 6、9、16 的服务端面）：
// /api/memory/topics 管理（列表/晋升/不再追踪/撤销）、/api/memory/config（阈值 + embedding 绑定）、
// /api/models kind=embedding。独立 server 实例 + mock adapter 零网络。

import { afterAll, describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { SessionStore, type UserRecord } from "../src/app/auth";
import { Ledger } from "../src/app/ledger";
import { ConversationStore } from "../src/app/conversations";
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { MemoryStore } from "../src/app/memory";
import { bumpTopic } from "../src/app/memory-topics";
import { MemoryExtractor } from "../src/app/memory-extract";
import { TaskStore } from "../src/app/tasks";
import { NotificationStore } from "../src/app/notify";
import { createAppServer } from "../src/app/server";
import { createMockLlmAdapter, type LlmAdapter } from "../src/harness/index";
import { testDb } from "./helpers-db";

const db = testDb();
const users = new Map<string, UserRecord>();
const ledgers = new Map<string, Promise<Ledger>>();
const memory = new MemoryStore({ db, now: () => 5000, randomUUID: () => `mid-${Math.random().toString(36).slice(2, 8)}` });
const { adapter } = createMockLlmAdapter([{ kind: "text", text: '{"memories":[],"topics":[]}' }]);

const json = (body: unknown): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const server = createAppServer({
  env: nodeEnv,
  db,
  masterKey: Buffer.alloc(32, 7),
  users,
  sessions: new SessionStore(db, () => Date.now()),
  conversations: new ConversationStore(
    {
      env: nodeEnv,
      sessionLog: () => Promise.reject(new Error("unused")),
      ledgerFor: async (uid) => {
        let ledger = ledgers.get(uid);
        if (!ledger) {
          ledger = Ledger.open(db, uid);
          ledgers.set(uid, ledger);
        }
        return ledger;
      },
      modelConfigFor: async () => null,
      adapterFactory: () => adapter as LlmAdapter,
      now: () => 1,
      agents: new AgentStore({ db, now: () => 1, randomUUID: () => "a1" }),
      skills: new SkillStore({ db, now: () => 1, randomUUID: () => "s1" }),
      mcps: new McpRegistry({ env: nodeEnv, db, now: () => 1, randomUUID: () => "m1" }),
      memory,
    },
    db,
  ),
  ledgerFor: async (uid) => {
    let ledger = ledgers.get(uid);
    if (!ledger) {
      ledger = Ledger.open(db, uid);
      ledgers.set(uid, ledger);
    }
    return ledger;
  },
  adapterFor: async () => ({ adapter, model: "mock-1" }),
  embeddingTester: async (uid, providerId) => {
    if (!db.prepare("SELECT 1 AS ok FROM model_providers WHERE uid = ? AND id = ? AND kind = 'embedding'").get(uid, providerId)) {
      throw new Error("embedding provider 不存在");
    }
  },
  agents: new AgentStore({ db, now: () => 1, randomUUID: () => "a2" }),
  skills: new SkillStore({ db, now: () => 1, randomUUID: () => "s2" }),
  mcps: new McpRegistry({ env: nodeEnv, db, now: () => 1, randomUUID: () => "m2" }),
  memory,
  memoryExtractor: new MemoryExtractor({ db, now: () => 5000, memory, adapterFor: async () => ({ adapter, model: "mock-1" }) }),
  tasks: new TaskStore({ db, now: () => 1, randomUUID: () => "t1" }),
  notifications: new NotificationStore({ db, now: () => 5000 }),
  taskRunner: async () => {},
});

let baseUrl = "";
let cookie = "";
let chatProviderId = "";
let embedProviderId = "";

const req = async (path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", cookie },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
};

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    resolve();
  });
});
const registered = await fetch(`${baseUrl}/api/auth/register`, json({ username: "lathan", password: "hunter2" }));
cookie = registered.headers.get("set-cookie")!.split(";")[0]!;
const uid = [...users.values()][0]!.uid;

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("主题计数与向量配置路由", () => {
  it("提供方 kind：创建 embedding 用途并回显；默认 chat", async () => {
    const chat = await req("/api/models", { method: "POST", body: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test" } });
    expect(chat.status).toBe(200);
    chatProviderId = chat.body.id;
    const embed = await req("/api/models", { method: "POST", body: { baseURL: "https://api.deepseek.com/v1", model: "text-embedding", apiKey: "sk-test", kind: "embedding" } });
    expect(embed.status).toBe(200);
    embedProviderId = embed.body.id;
    const list = await req("/api/models");
    const kinds = Object.fromEntries(list.body.providers.map((p: { id: string; kind: string }) => [p.id, p.kind]));
    expect(kinds[chatProviderId]).toBe("chat");
    expect(kinds[embedProviderId]).toBe("embedding");
    const bad = await req("/api/models", { method: "POST", body: { baseURL: "https://x.local", model: "m", kind: "video" } });
    expect(bad.status).toBe(400);
  });

  it("窗口下限按用途分：embedding 收 1024 与 512，chat 仍要求 ≥1000；小窗口行切回 chat 须显式改填", async () => {
    const small = await req("/api/models", {
      method: "POST",
      body: { baseURL: "https://api.jina.ai/v1", model: "jina-embeddings-v5-text-small", apiKey: "sk-test", kind: "embedding", contextWindow: 1024 },
    });
    expect(small.status).toBe(200);
    const list = await req("/api/models");
    expect(list.body.providers.find((p: { id: string }) => p.id === small.body.id)).toMatchObject({ kind: "embedding", contextWindow: 1024 });

    const tiny = await req("/api/models", { method: "POST", body: { baseURL: "https://api.jina.ai/v1", model: "m", kind: "embedding", contextWindow: 512 } });
    expect(tiny.status).toBe(200);
    const zero = await req("/api/models", { method: "POST", body: { baseURL: "https://api.jina.ai/v1", model: "m", kind: "embedding", contextWindow: 0 } });
    expect(zero.status).toBe(400);
    expect(zero.body.error).toContain("正整数");
    const chatSmall = await req("/api/models", { method: "POST", body: { baseURL: "https://api.jina.ai/v1", model: "m", contextWindow: 512 } });
    expect(chatSmall.status).toBe(400);
    expect(chatSmall.body.error).toContain("≥1000");

    const switchBack = await req(`/api/models/${tiny.body.id}`, { method: "PUT", body: { kind: "chat" } });
    expect(switchBack.status).toBe(404);
    expect(switchBack.body.error).toContain("≥1000");
    const withWindow = await req(`/api/models/${tiny.body.id}`, { method: "PUT", body: { kind: "chat", contextWindow: 32768 } });
    expect(withWindow.status).toBe(200);
    const relisted = await req("/api/models");
    expect(relisted.body.providers.find((p: { id: string }) => p.id === tiny.body.id)).toMatchObject({ kind: "chat", contextWindow: 32768 });
  });
  it("embedding 提供方连接测试走 embeddingTester", async () => {
    const ok = await req(`/api/models/${embedProviderId}/test`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true });
  });

  it("config：绑定 embedding 提供方与阈值；chat 提供方拒绝绑定；未知提供方 404；非法阈值 400", async () => {
    const patched = await req("/api/memory/config", { method: "PATCH", body: { embeddingProviderId: embedProviderId, interestThreshold: 5 } });
    expect(patched.status).toBe(200);
    expect(patched.body.config).toMatchObject({ interestThreshold: 5, embeddingProviderId: embedProviderId });
    const wrongKind = await req("/api/memory/config", { method: "PATCH", body: { embeddingProviderId: chatProviderId } });
    expect(wrongKind.status).toBe(400);
    const missing = await req("/api/memory/config", { method: "PATCH", body: { embeddingProviderId: "nope" } });
    expect(missing.status).toBe(404);
    const badThreshold = await req("/api/memory/config", { method: "PATCH", body: { interestThreshold: 99 } });
    expect(badThreshold.status).toBe(400);
    const cleared = await req("/api/memory/config", { method: "PATCH", body: { embeddingProviderId: null, interestThreshold: null } });
    expect(cleared.body.config).toMatchObject({ interestThreshold: 3, embeddingProviderId: null });
  });

  it("topics：列表/晋升/不再追踪/撤销", async () => {
    bumpTopic(db, uid, 1000, "门店排班管理", "门店排班管理", "店员班次安排");
    bumpTopic(db, uid, 1001, "门店排班管理", "门店排班管理", "排班管理");
    let list = await req("/api/memory/topics");
    expect(list.body.topics).toHaveLength(1);
    expect(list.body.topics[0]).toMatchObject({ topic: "门店排班管理", hits: 2 });
    expect(list.body.threshold).toBe(3);

    const promoted = await req(`/api/memory/topics/${encodeURIComponent("门店排班管理")}/promote`, { method: "POST" });
    expect(promoted.status).toBe(200);
    const interests = await req("/api/memory/items?kind=interest");
    expect(interests.body.items).toHaveLength(1);
    expect(interests.body.items[0]?.content).toBe("门店排班管理");
    list = await req("/api/memory/topics");
    expect(list.body.topics).toHaveLength(0); // 已晋升出列表

    // 重新计数一条再"不再追踪" → 出列表、拒绝晋升；撤销后回来
    bumpTopic(db, uid, 1002, "健身", "健身", "健身");
    const forgotten = await req(`/api/memory/topics/${encodeURIComponent("健身")}`, { method: "DELETE" });
    expect(forgotten.status).toBe(200);
    expect((await req("/api/memory/topics")).body.topics).toHaveLength(0);
    const promoteForgotten = await req(`/api/memory/topics/${encodeURIComponent("健身")}/promote`, { method: "POST" });
    expect(promoteForgotten.status).toBe(404);
    await req(`/api/memory/topics/${encodeURIComponent("健身")}/restore`, { method: "POST" });
    expect((await req("/api/memory/topics")).body.topics).toHaveLength(1);
  });
});
