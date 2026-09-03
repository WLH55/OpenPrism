// HTTP 服务器（批次 1）：node:http 零运行时依赖；JSON API + SSE 流式 + web/dist 静态托管。
// 路由见 spec §4.2；未登录一律 401 JSON；Key 永不回传（BYOK 铁律）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileIO, PlatformEnv } from "../harness/index";
import { createOpenAICompatAdapter } from "../harness/index";
import type { AppPaths } from "./store";
import { ensureUserSandbox } from "./store";
import { appendUser, hashPassword, SessionStore, verifyPassword, type UserRecord } from "./auth";
import { open, readModelConfig, seal, writeModelConfig, type ModelConfig } from "./secretbox";
import type { Ledger } from "./ledger";
import { todayView } from "./fold";
import { ModelNotConfiguredError, type ConversationStore } from "./conversations";

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
