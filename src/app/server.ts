// HTTP 服务器（批次 1）：node:http 零运行时依赖；JSON API + SSE 流式 + web/dist 静态托管。
// 路由见 spec §4.2；未登录一律 401 JSON；Key 永不回传（BYOK 铁律）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileIO, LlmAdapter, PlatformEnv } from "../harness/index";
import { createOpenAICompatAdapter } from "../harness/index";
import type { AppPaths } from "./store";
import { ensureUserSandbox } from "./store";
import { appendUser, hashPassword, SessionStore, verifyPassword, type UserRecord } from "./auth";
import { open, readModelConfig, seal, writeModelConfig, type ModelConfig } from "./secretbox";
import type { Ledger } from "./ledger";
import { todayView } from "./fold";
import { ModelNotConfiguredError, type ConversationStore } from "./conversations";
import type { AgentStore, AgentBinding } from "./agents";
import type { SkillStore } from "./skills";
import type { McpRegistry } from "./mcp";
import { MEMORY_SLOTS, type MemorySlot, type MemoryStore } from "./memory";

export interface ServerDeps {
  env: PlatformEnv;
  fileIO: FileIO;
  paths: AppPaths;
  masterKey: Buffer;
  /** 启动时载入、注册时追加的共享用户表（键 = username） */
  users: Map<string, UserRecord>;
  sessions: SessionStore;
  conversations: ConversationStore;
  /** 惰性打开该用户账本（today/flows/void/checkin 与会话装配共用同一实例缓存，由宿主实现） */
  ledgerFor(uid: string): Promise<Ledger>;
  /** 连接测试：默认用当前配置发一次 1-token 非流式请求；测试注入 fake（零网络） */
  modelTester?(uid: string, config: ModelConfig | null): Promise<void>;
  /** 记忆凝练用的 adapter（读用户当前 BYOK 配置）；缺省 = 未配置（consolidate 返回 409）；测试注入 mock */
  adapterFor?(uid: string): Promise<{ adapter: LlmAdapter; model: string } | null>;
  agents: AgentStore;
  skills: SkillStore;
  mcps: McpRegistry;
  memory: MemoryStore;
  tasks: import("./tasks").TaskStore;
  notifications: import("./notify").NotificationStore;
  /** 手动/调度共用的任务执行体（main 装配；测试注入 mock） */
  taskRunner(uid: string, task: import("./tasks").TaskDef): Promise<void>;
  staticDir?: string;
}

const COOKIE_NAME = "op_session";
const BODY_LIMIT = 1024 * 1024;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function sendJson(res: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(setCookie ? { "Set-Cookie": setCookie } : {}),
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

/** "HH:mm" → 当地今天该时刻（与 record_flow 工具同语义） */
function parseTimeToday(input: string, now: number): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (!match) throw new Error(`invalid time "${input}"，期望 HH:mm`);
  const base = new Date(now);
  base.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  return base.getTime();
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(deps: ServerDeps, res: ServerResponse, pathName: string): Promise<boolean> {
  if (!deps.staticDir) return false;
  const rel = pathName === "/" ? "index.html" : pathName.slice(1);
  const file = resolve(deps.staticDir, rel);
  if (!file.startsWith(resolve(deps.staticDir))) return false; // 防目录穿越
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const data = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function defaultModelTester(deps: ServerDeps, uid: string, config: ModelConfig | null): Promise<void> {
  if (!config) throw new Error("not_configured");
  const adapter = createOpenAICompatAdapter(deps.env, {
    baseURL: config.baseURL,
    apiKey: config.keyEnc ? open(deps.masterKey, config.keyEnc) : "",
    stream: false,
  });
  await adapter.complete({
    provider: "byok",
    model: config.model,
    system: "",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "ping" }] }],
  });
}

export function createAppServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((error) => {
      if (!res.headersSent) sendError(res, 500, String((error as Error)?.message ?? error));
      else res.end();
    });
  });
}

async function handle(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  // ── 认证（无需登录） ───────────────────────────────────
  if (method === "POST" && path === "/api/auth/register") {
    const body = (await readBody(req)) as { username?: string; password?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (username.length < 2 || username.length > 32 || /\s/.test(username)) {
      return sendError(res, 400, "username 需要 2-32 个字符且不含空白");
    }
    if (password.length < 6) return sendError(res, 400, "password 至少 6 位");
    if (deps.users.has(username)) return sendError(res, 409, "username already taken");
    const uid = deps.env.randomUUID();
    const user: UserRecord = { uid, username, password: await hashPassword(password), createdTs: deps.env.now() };
    await appendUser(deps.fileIO, deps.paths.usersFile, user);
    deps.users.set(username, user);
    await ensureUserSandbox(deps.paths, uid);
    await deps.ledgerFor(uid); // 注册即建账本文件
    const token = deps.sessions.issue(uid);
    return sendJson(res, 200, { uid, username }, sessionCookie(token));
  }

  if (method === "POST" && path === "/api/auth/login") {
    const body = (await readBody(req)) as { username?: string; password?: string };
    const user = deps.users.get(String(body.username ?? ""));
    if (!user || !(await verifyPassword(String(body.password ?? ""), user.password))) {
      return sendError(res, 401, "用户名或密码错误");
    }
    const token = deps.sessions.issue(user.uid);
    return sendJson(res, 200, { uid: user.uid, username: user.username }, sessionCookie(token));
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = cookieToken(req);
    if (token) deps.sessions.revoke(token);
    return sendJson(res, 200, { ok: true }, clearCookie());
  }

  // ── 登录门 ─────────────────────────────────────────────
  const uid = deps.sessions.verify(cookieToken(req));
  const user = uid ? [...deps.users.values()].find((u) => u.uid === uid) : undefined;
  if (!uid || !user) return sendError(res, 401, "unauthorized");

  if (method === "GET" && path === "/api/auth/me") {
    return sendJson(res, 200, { uid, username: user.username });
  }

  // ── 模型配置（BYOK） ───────────────────────────────────
  if (path === "/api/model") {
    const modelFile = deps.paths.modelFile(uid);
    if (method === "GET") {
      const config = await readModelConfig(deps.fileIO, modelFile);
      return sendJson(res, 200, {
        baseURL: config?.baseURL ?? "",
        model: config?.model ?? "",
        hasKey: Boolean(config?.keyEnc),
      });
    }
    if (method === "PUT") {
      const body = (await readBody(req)) as { baseURL?: string; apiKey?: string; model?: string };
      const baseURL = String(body.baseURL ?? "").trim().replace(/\/+$/, "");
      const model = String(body.model ?? "").trim();
      if (!/^https?:\/\//.test(baseURL)) return sendError(res, 400, "baseURL 需以 http(s):// 开头");
      if (model === "") return sendError(res, 400, "model 必填");
      const existing = await readModelConfig(deps.fileIO, modelFile);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const keyEnc = apiKey !== "" ? seal(deps.masterKey, apiKey) : existing?.keyEnc;
      const config: ModelConfig = { baseURL, model, ...(keyEnc !== undefined ? { keyEnc } : {}) };
      await writeModelConfig(deps.fileIO, modelFile, config);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (method === "POST" && path === "/api/model/test") {
    const config = await readModelConfig(deps.fileIO, deps.paths.modelFile(uid));
    const tester = deps.modelTester ?? ((u, c) => defaultModelTester(deps, u, c));
    try {
      await tester(uid, config);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) });
    }
  }

  // ── 会话 ───────────────────────────────────────────────
  if (path === "/api/conversations" && (method === "GET" || method === "POST")) {
    if (method === "GET") {
      const entries = await deps.conversations.list(uid);
      return sendJson(res, 200, entries.sort((a, b) => b.createdTs - a.createdTs));
    }
    const body = (await readBody(req)) as { title?: string };
    const entry = await deps.conversations.create(
      uid,
      typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim() : undefined,
    );
    return sendJson(res, 200, entry);
  }

  const convMatch = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (convMatch) {
    const cid = decodeURIComponent(convMatch[1]!);
    const sub = convMatch[2] ?? "";

    if (sub === "/events" && method === "GET") {
      const lines = await deps.fileIO.readAll(join(deps.paths.convDir(uid, cid), "session.jsonl"));
      return sendJson(res, 200, lines.map((line) => JSON.parse(line)));
    }

    if (sub === "/messages" && method === "POST") {
      const body = (await readBody(req)) as { text?: string };
      const text = String(body.text ?? "").trim();
      if (text === "") return sendError(res, 400, "text 必填");
      try {
        await deps.conversations.send(uid, cid, text);
        return sendJson(res, 202, { ok: true });
      } catch (error) {
        if (error instanceof ModelNotConfiguredError) return sendError(res, 409, "model_not_configured");
        throw error;
      }
    }

    if (sub === "/stream" && method === "GET") {
      let agent;
      try {
        agent = await deps.conversations.agent(uid, cid);
      } catch (error) {
        if (error instanceof ModelNotConfiguredError) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ type: "error", error: "model_not_configured" })}\n\n`);
          res.end();
          return;
        }
        throw error;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "status", status: agent.status })}\n\n`);
      const unsubscribe = agent.subscribe((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        unsubscribe();
        clearInterval(heartbeat);
      });
      return;
    }

    // 会话伙伴绑定/切换（D4.2）
    if (sub === "/meta" && method === "GET") {
      return sendJson(res, 200, await deps.conversations.metaFor(uid, cid));
    }
    if (sub === "/agent" && method === "PUT") {
      const body = (await readBody(req)) as { agentId?: string };
      try {
        await deps.conversations.switchAgent(uid, cid, String(body.agentId ?? ""));
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendError(res, 404, String((error as Error).message));
      }
    }
  }

  // ── 智能体（三段配置） ─────────────────────────────────
  if (path === "/api/agents" && (method === "GET" || method === "POST")) {
    if (method === "GET") return sendJson(res, 200, await deps.agents.list(uid));
    const body = (await readBody(req)) as { persona?: string; binding?: AgentBinding };
    const persona = String(body.persona ?? "");
    if (persona.trim() === "") return sendError(res, 400, "persona 必填（markdown 自由书写）");
    const entry = await deps.agents.create(uid, {
      persona,
      ...(body.binding ? { binding: body.binding } : {}),
    });
    return sendJson(res, 200, entry);
  }
  const agentMatch = /^\/api\/agents\/([^/]+)(\/[^/]*)?$/.exec(path);
  if (agentMatch) {
    const aid = decodeURIComponent(agentMatch[1]!);
    const sub = agentMatch[2] ?? "";
    const wrap = (error: unknown): void => sendError(res, 404, String((error as Error).message));
    try {
      if (sub === "" && method === "GET") {
        return sendJson(res, 200, { ...(await deps.agents.list(uid)).find((a) => a.id === aid), persona: await deps.agents.persona(uid, aid) });
      }
      if (sub === "" && method === "DELETE") {
        await deps.agents.remove(uid, aid);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === "/persona" && method === "PUT") {
        const body = (await readBody(req)) as { markdown?: string };
        return sendJson(res, 200, await deps.agents.updatePersona(uid, aid, String(body.markdown ?? "")));
      }
      if (sub === "/binding" && method === "PUT") {
        const body = (await readBody(req)) as { binding?: AgentBinding };
        const binding = body.binding;
        if (!binding || !Array.isArray(binding.skills) || !Array.isArray(binding.mcps)) {
          return sendError(res, 400, "binding 需要 skills/mcps 数组");
        }
        await deps.agents.updateBinding(uid, aid, binding);
        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      return wrap(error);
    }
  }

  // ── 技能 ───────────────────────────────────────────────
  if (path === "/api/skills" && (method === "GET" || method === "POST")) {
    if (method === "GET") return sendJson(res, 200, await deps.skills.list(uid));
    const body = (await readBody(req)) as { content?: string };
    try {
      return sendJson(res, 200, await deps.skills.create(uid, String(body.content ?? "")));
    } catch (error) {
      return sendError(res, 400, String((error as Error).message));
    }
  }
  const skillMatch = /^\/api\/skills\/([^/]+)(\/[^/]*)?$/.exec(path);
  if (skillMatch) {
    const sid = decodeURIComponent(skillMatch[1]!);
    const sub = skillMatch[2] ?? "";
    try {
      if (sub === "/body" && method === "GET") return sendJson(res, 200, { body: await deps.skills.body(uid, sid) });
      if (sub === "" && method === "DELETE") {
        await deps.skills.remove(uid, sid);
        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      return sendError(res, 404, String((error as Error).message));
    }
  }

  // ── MCP ────────────────────────────────────────────────
  if (path === "/api/mcps" && (method === "GET" || method === "POST")) {
    if (method === "GET") return sendJson(res, 200, await deps.mcps.list(uid));
    const body = (await readBody(req)) as { name?: string; url?: string; headers?: Record<string, string> };
    try {
      return sendJson(res, 200, await deps.mcps.add(uid, {
        name: String(body.name ?? "").trim() || "MCP",
        url: String(body.url ?? ""),
        ...(body.headers ? { headers: body.headers } : {}),
      }));
    } catch (error) {
      return sendError(res, 400, String((error as Error).message));
    }
  }
  const mcpMatch = /^\/api\/mcps\/([^/]+)(\/[^/]*)?$/.exec(path);
  if (mcpMatch) {
    const mid = decodeURIComponent(mcpMatch[1]!);
    const sub = mcpMatch[2] ?? "";
    try {
      if (sub === "/tools" && method === "POST") {
        const tools = await deps.mcps.toolsFor(uid, mid);
        return sendJson(res, 200, { tools: tools.map((t) => t.name) });
      }
      if (sub === "" && method === "DELETE") {
        await deps.mcps.remove(uid, mid);
        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      return sendError(res, 404, String((error as Error).message));
    }
  }

  // ── 长期记忆 ───────────────────────────────────────────
  if (path === "/api/memory" && method === "GET") {
    const [slots, meta] = await Promise.all([deps.memory.read(uid), deps.memory.meta(uid)]);
    return sendJson(res, 200, { slots, meta });
  }
  const memorySlotMatch = /^\/api\/memory\/([a-z]+)$/.exec(path);
  if (memorySlotMatch && method === "PUT") {
    const slot = memorySlotMatch[1]! as MemorySlot;
    if (!(MEMORY_SLOTS as readonly string[]).includes(slot)) return sendError(res, 400, `slot 只能是 ${MEMORY_SLOTS.join(" / ")}`);
    const body = (await readBody(req)) as { markdown?: string };
    await deps.memory.writeSlot(uid, slot, String(body.markdown ?? ""));
    return sendJson(res, 200, { ok: true });
  }
  if (path === "/api/memory/consolidate" && method === "POST") {
    const built = deps.adapterFor ? await deps.adapterFor(uid) : null;
    if (!built) return sendError(res, 409, "model_not_configured");
    // 会话文本采集：全部会话的 user/assistant 文本，取尾部 40 条
    const texts: string[] = [];
    for (const entry of await deps.conversations.list(uid)) {
      const lines = await deps.fileIO.readAll(join(deps.paths.convDir(uid, entry.id), "session.jsonl"));
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type: string; message?: { role: string; content: { type: string; text?: string }[] } };
          if (event.type === "user/message" || event.type === "assistant/message") {
            const text = (event.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
            if (text.trim() !== "") texts.push(`${event.message?.role === "user" ? "用户" : "助手"}：${text}`);
          }
        } catch {
          // 坏行
        }
      }
    }
    const result = await deps.memory.consolidate({
      uid,
      adapter: built.adapter,
      model: built.model,
      sessionTexts: texts.slice(-40),
    });
    return sendJson(res, 200, result);
  }

  // ── 账本直写（ui 来源） ────────────────────────────────
  if (method === "GET" && path === "/api/today") {
    const tz = Number(url.searchParams.get("tz") ?? "0") || 0;
    const ledger = await deps.ledgerFor(uid);
    return sendJson(res, 200, todayView(ledger.readAll(), deps.env.now(), tz));
  }

  if (method === "POST" && path === "/api/flows") {
    const body = (await readBody(req)) as { category?: string; note?: string; value?: number; unit?: string; time?: string };
    const category = String(body.category ?? "").trim();
    if (category === "") return sendError(res, 400, "category 必填");
    const now = deps.env.now();
    const time = typeof body.time === "string" && body.time !== "" ? parseTimeToday(body.time, now) : now;
    const ledger = await deps.ledgerFor(uid);
    const record = await ledger.append({
      kind: "event",
      source: "ui",
      time,
      category,
      ...(body.note !== undefined ? { note: String(body.note) } : {}),
      ...(body.value !== undefined && body.value !== null ? { value: Number(body.value) } : {}),
      ...(body.unit !== undefined ? { unit: String(body.unit) } : {}),
    });
    return sendJson(res, 200, { seq: record.seq });
  }

  if (method === "POST" && path === "/api/void") {
    const body = (await readBody(req)) as { seq?: number };
    const seq = Number(body.seq);
    if (!Number.isInteger(seq)) return sendError(res, 400, "seq 必须是整数");
    const ledger = await deps.ledgerFor(uid);
    if (!ledger.readAll().some((r) => r.seq === seq)) return sendError(res, 404, "seq 不存在");
    await ledger.append({ kind: "void", source: "ui", targetSeq: seq });
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/checkin") {
    const body = (await readBody(req)) as { planId?: string; done?: boolean };
    const planId = String(body.planId ?? "");
    if (planId === "") return sendError(res, 400, "planId 必填");
    const ledger = await deps.ledgerFor(uid);
    const exists = ledger.activeRecords().some((r) => r.kind === "plan" && (r as { planId: string }).planId === planId);
    if (!exists) return sendError(res, 404, "planId 不存在");
    const record = await ledger.append({
      kind: "checkin",
      source: "ui",
      planId,
      at: deps.env.now(),
      done: body.done ?? true,
    });
    return sendJson(res, 200, { ok: true, ts: record.ts });
  }


  // ── 定时任务（D6） ─────────────────────────────────────
  if (path === "/api/tasks" && (method === "GET" || method === "POST")) {
    if (method === "GET") return sendJson(res, 200, await deps.tasks.list(uid));
    const body = (await readBody(req)) as Record<string, unknown>;
    try {
      const task = await deps.tasks.create(uid, body as never);
      return sendJson(res, 200, task);
    } catch (error) {
      return sendError(res, 400, String((error as Error).message));
    }
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)(\/[^/]*)?$/.exec(path);
  if (taskMatch) {
    const tid = decodeURIComponent(taskMatch[1]!);
    const sub = taskMatch[2] ?? "";
    try {
      if (sub === "" && method === "PUT") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return sendJson(res, 200, await deps.tasks.update(uid, tid, body as never));
      }
      if (sub === "" && method === "DELETE") {
        await deps.tasks.remove(uid, tid);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === "/runs" && method === "GET") {
        return sendJson(res, 200, await deps.tasks.runs(uid, tid));
      }
      if (sub === "/run" && method === "POST") {
        const task = await deps.tasks.get(uid, tid);
        if (!task) return sendError(res, 404, "task 不存在");
        void deps.taskRunner(uid, task).then(
          async () => deps.tasks.recordRun(uid, tid, { ts: deps.env.now(), status: "ran" }),
          async (error) =>
            deps.tasks.recordRun(uid, tid, { ts: deps.env.now(), status: "failed", detail: String((error as Error).message).slice(0, 200) }),
        );
        return sendJson(res, 202, { ok: true });
      }
    } catch (error) {
      return sendError(res, 404, String((error as Error).message));
    }
  }

  // ── 通知（D9 首版站内） ────────────────────────────────
  if (path === "/api/notifications" && method === "GET") {
    const unreadOnly = url.searchParams.get("unread") === "1";
    return sendJson(res, 200, await deps.notifications.list(uid, { unreadOnly }));
  }
  if (path === "/api/notifications/read" && method === "POST") {
    const body = (await readBody(req)) as { seq?: number; all?: boolean };
    await deps.notifications.markRead(uid, body.all === true ? "all" : Number(body.seq));
    return sendJson(res, 200, { ok: true });
  }

  // ── 静态资源（web/dist） ───────────────────────────────
  if (method === "GET" && (await serveStatic(deps, res, path))) return;

  sendError(res, 404, "not found");
}

export async function startServer(deps: ServerDeps, port = 8787, host = "0.0.0.0"): Promise<{ server: Server; port: number }> {
  const server = createAppServer(deps);
  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address() as { port: number };
  return { server, port: address.port };
}
