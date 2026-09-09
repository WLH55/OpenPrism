// HTTP 服务器（批次 1）：node:http 零运行时依赖；JSON API + SSE 流式 + web/dist 静态托管。
// 路由见 spec §4.2；未登录一律 401 JSON；Key 永不回传（BYOK 铁律）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LlmAdapter, PlatformEnv } from "../harness/index";
import { createOpenAICompatAdapter } from "../harness/index";
import { appendUser, hashPassword, SessionStore, verifyPassword, type UserRecord } from "./auth";
import {
  activeModelId,
  addModelProvider,
  listModelProviders,
  open,
  readModelConfig,
  readModelProviderConfig,
  removeModelProvider,
  seal,
  setActiveModel,
  updateModelProvider,
  type ModelConfig,
} from "./secretbox";
import type { Ledger } from "./ledger";
import { categoryView, listCategories, progressView, todayView } from "./fold";
import { ModelNotConfiguredError, type ConversationStore } from "./conversations";
import type { AgentStore, AgentBinding } from "./agents";
import type { SkillStore } from "./skills";
import type { McpRegistry } from "./mcp";
import { MEMORY_KINDS, MEMORY_STATUSES, type MemoryKind, type MemoryStatus, type MemoryStore } from "./memory";
import type { MemoryExtractor } from "./memory-extract";

export interface ServerDeps {
  env: PlatformEnv;
  /** SQLite 数据库（ADR 0008 领域表） */
  db: DatabaseSync;
  masterKey: Buffer;
  /** 启动时载入、注册时追加的共享用户表（键 = username） */
  users: Map<string, UserRecord>;
  /** uid 二级索引（可选；认证查询免线性扫描） */
  usersByUid?: Map<string, UserRecord>;
  sessions: SessionStore;
  conversations: ConversationStore;
  /** 惰性打开该用户账本（today/flows/void/checkin 与会话装配共用同一实例缓存，由宿主实现） */
  ledgerFor(uid: string): Promise<Ledger>;
  /** 连接测试：默认用当前配置发一次 1-token 非流式请求；测试注入 fake（零网络） */
  modelTester?(uid: string, config: ModelConfig | null): Promise<void>;
  /** 记忆提取/整理用的 adapter（读用户当前 BYOK 配置）；缺省 = 未配置（extract 返回 409）；测试注入 mock */
  adapterFor?(uid: string): Promise<{ adapter: LlmAdapter; model: string } | null>;
  agents: AgentStore;
  skills: SkillStore;
  mcps: McpRegistry;
  memory: MemoryStore;
  /** 记忆提取管线（条目化，2026-09-10）：手动提取/整理端点与去抖调度共用 */
  memoryExtractor: MemoryExtractor;
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

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/** 认证限速：每 IP+用户名 60s 窗口 10 次（内存态，单进程自部署/小公网够用） */
class AuthRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit = 10, private windowMs = 60_000) {}
  take(key: string, now: number): boolean {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export function createAppServer(deps: ServerDeps): Server {
  const limiter = new AuthRateLimiter();
  return createServer((req, res) => {
    setSecurityHeaders(res);
    handle(deps, req, res, limiter).catch((error) => {
      if (!res.headersSent) sendError(res, 500, String((error as Error)?.message ?? error));
      else res.end();
    });
  });
}

async function handle(deps: ServerDeps, req: IncomingMessage, res: ServerResponse, limiter: AuthRateLimiter): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  // 静态资源（web/dist）：登录页本身无需登录；认证门只管 /api/*
  if (method === "GET" && !path.startsWith("/api") && (await serveStatic(deps, res, path))) return;

  // ── 认证（无需登录） ───────────────────────────────────
  if (method === "POST" && path === "/api/auth/register") {
    const body = (await readBody(req)) as { username?: string; password?: string };
    const username = String(body.username ?? "").trim();
    if (!limiter.take(`${req.socket.remoteAddress ?? "?"}|${username}`, deps.env.now())) {
      return sendError(res, 429, "尝试太频繁，一分钟后再试");
    }
    const password = String(body.password ?? "");
    if (username.length < 2 || username.length > 32 || /\s/.test(username)) {
      return sendError(res, 400, "username 需要 2-32 个字符且不含空白");
    }
    if (password.length < 6) return sendError(res, 400, "password 至少 6 位");
    if (deps.users.has(username)) return sendError(res, 409, "username already taken");
    const uid = deps.env.randomUUID();
    const user: UserRecord = { uid, username, password: await hashPassword(password), createdTs: deps.env.now() };
    appendUser(deps.db, user);
    deps.users.set(username, user);
    deps.usersByUid?.set(uid, user);
    await deps.ledgerFor(uid); // 注册即开账本（空账本入缓存）
    const token = deps.sessions.issue(uid);
    return sendJson(res, 200, { uid, username }, sessionCookie(token));
  }

  if (method === "POST" && path === "/api/auth/login") {
    const body = (await readBody(req)) as { username?: string; password?: string };
    const usernameKey = String(body.username ?? "");
    if (!limiter.take(`${req.socket.remoteAddress ?? "?"}|${usernameKey}`, deps.env.now())) {
      return sendError(res, 429, "尝试太频繁，一分钟后再试");
    }
    const user = deps.users.get(usernameKey);
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
  const user = uid ? (deps.usersByUid?.get(uid) ?? [...deps.users.values()].find((u) => u.uid === uid)) : undefined;
  if (!uid || !user) return sendError(res, 401, "unauthorized");

  if (method === "GET" && path === "/api/auth/me") {
    return sendJson(res, 200, { uid, username: user.username });
  }

  // ── 模型接入（BYOK 多供应商） ──────────────────────────
  /** 上下文窗口入参归一：undefined=不改/缺省、null=回默认、正整数=自定义 */
  const parseContextWindow = (input: unknown): number | null | undefined => {
    if (input === undefined) return undefined;
    if (input === null) return null;
    const n = Number(input);
    if (!Number.isInteger(n) || n < 1000) throw new Error("contextWindow 需为 ≥1000 的整数（tokens）");
    return n;
  };
  const validateBaseURL = (baseURL: string): void => {
    if (!/^https?:\/\//.test(baseURL)) throw new Error("baseURL 需以 http(s):// 开头");
  };

  if (path === "/api/models" && method === "GET") {
    return sendJson(res, 200, { activeId: activeModelId(deps.db, uid), providers: listModelProviders(deps.db, uid) });
  }
  if (path === "/api/models" && method === "POST") {
    const body = (await readBody(req)) as { baseURL?: string; apiKey?: string; model?: string; contextWindow?: unknown; platform?: string };
    const baseURL = String(body.baseURL ?? "").trim().replace(/\/+$/, "");
    const model = String(body.model ?? "").trim();
    try {
      validateBaseURL(baseURL);
      if (model === "") throw new Error("model 必填");
      const contextWindow = parseContextWindow(body.contextWindow);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const created = addModelProvider(deps.db, uid, {
        baseURL,
        model,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(apiKey !== "" ? { keyEnc: seal(deps.masterKey, apiKey) } : {}),
        ...(typeof body.platform === "string" && body.platform.trim() !== "" ? { platform: body.platform.trim() } : {}),
      });
      return sendJson(res, 200, { id: created.id });
    } catch (error) {
      return sendError(res, 400, String((error as Error).message));
    }
  }
  const modelsMatch = /^\/api\/models\/([^/]+)(\/[^/]*)?$/.exec(path);
  if (modelsMatch) {
    const providerId = decodeURIComponent(modelsMatch[1]!);
    const sub = modelsMatch[2] ?? "";
    try {
      if (sub === "" && method === "PUT") {
        const body = (await readBody(req)) as { baseURL?: string; apiKey?: string; model?: string; contextWindow?: unknown };
        const patch: { baseURL?: string; model?: string; contextWindow?: number | null; keyEnc?: string } = {};
        if (body.baseURL !== undefined) {
          const baseURL = String(body.baseURL).trim().replace(/\/+$/, "");
          validateBaseURL(baseURL);
          patch.baseURL = baseURL;
        }
        if (body.model !== undefined) {
          const model = String(body.model).trim();
          if (model === "") throw new Error("model 必填");
          patch.model = model;
        }
        const contextWindow = parseContextWindow(body.contextWindow);
        if (contextWindow !== undefined) patch.contextWindow = contextWindow;
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (apiKey !== "") patch.keyEnc = seal(deps.masterKey, apiKey);
        updateModelProvider(deps.db, uid, providerId, patch);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === "" && method === "DELETE") {
        removeModelProvider(deps.db, uid, providerId);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === "/active" && method === "PUT") {
        setActiveModel(deps.db, uid, providerId);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === "/test" && method === "POST") {
        const config = readModelProviderConfig(deps.db, uid, providerId);
        if (!config) return sendError(res, 404, `model provider "${providerId}" 不存在`);
        const tester = deps.modelTester ?? ((u, c) => defaultModelTester(deps, u, c));
        try {
          await tester(uid, config);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) });
        }
      }
    } catch (error) {
      return sendError(res, 404, String((error as Error).message));
    }
  }

  // GET /api/model：激活供应商视图（兼容旧客户端；列表管理走 /api/models）
  if (path === "/api/model" && method === "GET") {
    const config = await readModelConfig(deps.db, uid);
    return sendJson(res, 200, {
      baseURL: config?.baseURL ?? "",
      model: config?.model ?? "",
      hasKey: Boolean(config?.keyEnc),
    });
  }

  // ── 会话 ───────────────────────────────────────────────
  if (path === "/api/conversations" && (method === "GET" || method === "POST")) {
    if (method === "GET") {
      const entries = await deps.conversations.list(uid); // 已按置顶在前、创建时间倒序
      return sendJson(res, 200, entries);
    }
    const body = (await readBody(req)) as { title?: string };
    const entry = await deps.conversations.create(
      uid,
      typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim() : undefined,
    );
    return sendJson(res, 200, entry);
  }

  const convRootMatch = /^\/api\/conversations\/([^/]+)$/.exec(path);
  if (convRootMatch && method === "DELETE") {
    try {
      await deps.conversations.remove(uid, decodeURIComponent(convRootMatch[1]!));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendError(res, 404, String((error as Error).message));
    }
  }

  const convTitleMatch = /^\/api\/conversations\/([^/]+)\/title$/.exec(path);
  if (convTitleMatch && method === "POST") {
    // 自动命名（WeKnora 同款）：仅默认标题的会话生效；失败回退首条消息截断，静默不抛
    try {
      const result = await deps.conversations.autoTitle(uid, decodeURIComponent(convTitleMatch[1]!));
      return sendJson(res, 200, result ?? { ok: false });
    } catch {
      return sendJson(res, 200, { ok: false });
    }
  }

  const convMatch = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (convMatch) {
    const cid = decodeURIComponent(convMatch[1]!);
    const sub = convMatch[2] ?? "";

    if (sub === "/events" && method === "GET") {
      const rows = deps.db.prepare("SELECT event_json FROM conversation_events WHERE cid = ? ORDER BY seq").all(cid) as unknown as {
        event_json: string;
      }[];
      return sendJson(res, 200, rows.map((row) => JSON.parse(row.event_json)));
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
    // 会话级模型绑定（2026-09-07）：providerId = null 表示跟随全局激活
    if (sub === "/model" && method === "PUT") {
      const body = (await readBody(req)) as { providerId?: string | null };
      const providerId = body.providerId ?? null;
      if (providerId !== null && !listModelProviders(deps.db, uid).some((p) => p.id === providerId)) {
        return sendError(res, 404, `model provider "${providerId}" 不存在`);
      }
      try {
        await deps.conversations.switchModel(uid, cid, providerId);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendError(res, 404, String((error as Error).message));
      }
    }
  }

  // ── 智能体（三段配置） ─────────────────────────────────
  if (path === "/api/agents" && (method === "GET" || method === "POST")) {
    if (method === "GET") return sendJson(res, 200, await deps.agents.list(uid));
    const body = (await readBody(req)) as {
      persona?: string;
      name?: string;
      binding?: AgentBinding;
      description?: string;
      emoji?: string;
      color?: string;
      avatar?: string;
      language?: string;
      modelProviderId?: string | null;
    };
    const persona = String(body.persona ?? "");
    if (persona.trim() === "") return sendError(res, 400, "persona 必填（markdown 自由书写）");
    if (body.modelProviderId && !deps.db.prepare("SELECT 1 FROM model_providers WHERE uid = ? AND id = ?").get(uid, body.modelProviderId)) {
      return sendError(res, 400, `模型 "${body.modelProviderId}" 不存在`);
    }
    try {
      const entry = await deps.agents.create(uid, {
        persona,
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.binding ? { binding: body.binding } : {}),
        identity: {
          ...(body.description !== undefined ? { description: String(body.description) } : {}),
          ...(body.emoji !== undefined ? { emoji: String(body.emoji) } : {}),
          ...(body.color !== undefined ? { color: String(body.color) } : {}),
          ...(body.avatar !== undefined ? { avatar: String(body.avatar) } : {}),
          ...(body.language !== undefined ? { language: String(body.language) } : {}),
          ...(body.modelProviderId !== undefined ? { modelProviderId: body.modelProviderId === null ? "" : String(body.modelProviderId) } : {}),
        },
      });
      return sendJson(res, 200, entry);
    } catch (error) {
      return sendError(res, 400, String((error as Error).message));
    }
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
      if (sub === "/identity" && method === "PUT") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const key of ["name", "description", "emoji", "color", "avatar", "language", "modelProviderId"] as const) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        if (typeof patch.modelProviderId === "string" && patch.modelProviderId !== "") {
          const hit = deps.db.prepare("SELECT 1 FROM model_providers WHERE uid = ? AND id = ?").get(uid, patch.modelProviderId);
          if (!hit) return sendError(res, 400, `模型 "${String(patch.modelProviderId)}" 不存在`);
        }
        try {
          const entry = await deps.agents.updateIdentity(uid, aid, patch);
          // 伙伴默认模型变更 → 弃池其绑定会话（下一回合重装配）
          deps.conversations.evictAgentConversations(uid, aid);
          return sendJson(res, 200, entry);
        } catch (error) {
          const msg = String((error as Error).message);
          return sendError(res, msg.includes("不存在") ? 404 : 400, msg);
        }
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

  // ── 长期记忆（条目化，2026-09-10 WeKnora 化重构） ──
  if (path === "/api/memory" && method === "GET") {
    const counts = deps.memory.countByStatus(uid);
    const meta = deps.memory.metaRow(uid);
    return sendJson(res, 200, { counts, meta });
  }
  if (path === "/api/memory/items" && method === "GET") {
    const kindParam = url.searchParams.get("kind");
    const statusParam = url.searchParams.get("status");
    const kind = (MEMORY_KINDS as readonly string[]).includes(kindParam ?? "") ? (kindParam as MemoryKind) : undefined;
    const status = (MEMORY_STATUSES as readonly string[]).includes(statusParam ?? "") ? (statusParam as MemoryStatus) : undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "100")) || 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
    return sendJson(res, 200, { items: deps.memory.listItems(uid, { kind, status, limit, offset }) });
  }
  if (path === "/api/memory/items" && method === "POST") {
    const body = (await readBody(req)) as { kind?: string; content?: string; importance?: number; topic?: string };
    const kind = (MEMORY_KINDS as readonly string[]).includes(String(body.kind ?? "")) ? (body.kind as MemoryKind) : "fact";
    const content = String(body.content ?? "").trim();
    if (content === "") return sendError(res, 400, "content 必填");
    const result = deps.memory.insertItem(uid, {
      kind,
      content,
      ...(body.topic !== undefined ? { topic: String(body.topic) } : {}),
      ...(body.importance !== undefined ? { importance: Number(body.importance) } : {}),
      origin: "manual",
    });
    if (!result.item) return sendError(res, 400, "内容被拒绝（敏感材料或重复）");
    return sendJson(res, 200, { item: result.item });
  }
  if (path === "/api/memory/items" && method === "DELETE") {
    const body = (await readBody(req)) as { confirm?: string };
    if (body.confirm !== "clear") return sendError(res, 400, "需要 confirm:clear");
    const removed = deps.memory.clearAll(uid);
    return sendJson(res, 200, { removed });
  }
  const memoryItemMatch = /^\/api\/memory\/items\/([^/]+)(\/confirm|\/reject)?$/.exec(path);
  if (memoryItemMatch) {
    const id = memoryItemMatch[1]!;
    const suffix = memoryItemMatch[2];
    try {
      if (suffix === undefined && method === "PUT") {
        const body = (await readBody(req)) as { content?: string; importance?: number; topic?: string };
        const item = deps.memory.updateItemContent(uid, id, {
          ...(body.content !== undefined ? { content: String(body.content) } : {}),
          ...(body.importance !== undefined ? { importance: Number(body.importance) } : {}),
          ...(body.topic !== undefined ? { topic: String(body.topic) } : {}),
        });
        return sendJson(res, 200, { item });
      }
      if (suffix === undefined && method === "DELETE") {
        deps.memory.deleteItem(uid, id);
        return sendJson(res, 200, { ok: true });
      }
      if (suffix === "/confirm" && method === "POST") {
        deps.memory.confirmItem(uid, id);
        return sendJson(res, 200, { ok: true });
      }
      if (suffix === "/reject" && method === "POST") {
        deps.memory.rejectItem(uid, id);
        return sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      return sendError(res, 404, String((error as Error).message));
    }
  }
  if (path === "/api/memory/extract" && method === "POST") {
    const built = deps.adapterFor ? await deps.adapterFor(uid) : null;
    if (!built) return sendError(res, 409, "model_not_configured");
    return sendJson(res, 200, await deps.memoryExtractor.extractOnce(uid, built.adapter, built.model));
  }
  if (path === "/api/memory/consolidate" && method === "POST") {
    const built = deps.adapterFor ? await deps.adapterFor(uid) : null;
    if (!built) return sendError(res, 409, "model_not_configured");
    return sendJson(res, 200, await deps.memoryExtractor.consolidate(uid, built.adapter, built.model, true));
  }
  if (path === "/api/memory/export" && method === "GET") {
    const items = deps.memory.listItems(uid, { limit: 20000 });
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="openprism-memory.json"' });
    res.end(body);
    return;
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


  // ── 盘面/成长（D7/D11.3，确定性折叠；归档名单存 archives 表） ──
  const readArchived = async (): Promise<string[]> => {
    const row = deps.db.prepare("SELECT list_json FROM archives WHERE uid = ?").get(uid) as
      | { list_json: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.list_json) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const writeArchived = (list: string[]): void => {
    deps.db
      .prepare(
        "INSERT INTO archives (uid, list_json, updated_ts) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET list_json = excluded.list_json, updated_ts = excluded.updated_ts",
      )
      .run(uid, JSON.stringify(list), deps.env.now());
  };

  if (path === "/api/panels" && method === "GET") {
    const ledger = await deps.ledgerFor(uid);
    return sendJson(res, 200, {
      categories: listCategories(ledger.readAll(), await readArchived()),
      archived: await readArchived(),
    });
  }
  if (path === "/api/panels/progress" && method === "GET") {
    const ledger = await deps.ledgerFor(uid);
    return sendJson(res, 200, progressView(ledger.readAll(), deps.env.now(), -new Date().getTimezoneOffset()));
  }
  if (path === "/api/panels/merge" && method === "POST") {
    const body = (await readBody(req)) as { from?: string; to?: string };
    const from = String(body.from ?? "").trim();
    const to = String(body.to ?? "").trim();
    if (from === "" || to === "" || from === to) return sendError(res, 400, "from/to 必填且不同");
    const ledger = await deps.ledgerFor(uid);
    const flows = ledger.activeRecords().filter((r) => r.kind === "event" && (r as { category: string }).category === from);
    for (const record of flows) {
      const flow = record as import("./ledger").FlowRecord;
      await ledger.append({ kind: "void", source: "ui", targetSeq: flow.seq, reason: `合并到「${to}」` });
      await ledger.append({
        kind: "event",
        source: "ui",
        time: flow.time,
        category: to,
        ...(flow.note !== undefined ? { note: flow.note } : {}),
        ...(flow.value !== undefined ? { value: flow.value } : {}),
        ...(flow.unit !== undefined ? { unit: flow.unit } : {}),
      });
    }
    return sendJson(res, 200, { moved: flows.length });
  }
  if ((path === "/api/panels/archive" || path === "/api/panels/unarchive") && method === "POST") {
    const body = (await readBody(req)) as { name?: string };
    const name = String(body.name ?? "").trim();
    if (name === "") return sendError(res, 400, "name 必填");
    const current = await readArchived();
    const next = path.endsWith("/archive")
      ? current.includes(name) ? current : [...current, name]
      : current.filter((n) => n !== name);
    writeArchived(next);
    return sendJson(res, 200, { archived: next });
  }
  const panelCategory = /^\/api\/panels\/category\/([^/]+)$/.exec(path);
  if (panelCategory && method === "GET") {
    const name = decodeURIComponent(panelCategory[1]!);
    const periodParam = url.searchParams.get("period") ?? "week";
    const period = (["today", "week", "month", "year"] as const).find((p) => p === periodParam) ?? "week";
    const ledger = await deps.ledgerFor(uid);
    return sendJson(res, 200, categoryView(ledger.readAll(), { category: name, period, now: deps.env.now(), tzOffsetMinutes: -new Date().getTimezoneOffset() }));
  }

  sendError(res, 404, "not found");
}

export async function startServer(deps: ServerDeps, port = 8787, host = "0.0.0.0"): Promise<{ server: Server; port: number }> {
  const server = createAppServer(deps);
  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address() as { port: number };
  return { server, port: address.port };
}
