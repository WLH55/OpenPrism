// 进程入口（批次 1）：OP_DATA（默认 ./data）+ OP_PORT（默认 8787）。
// 装配：nodeEnv/nodeFileIO → 主密钥 → 用户表 → 会话池（adapter 每次调用现读配置，改设置即时生效）→ HTTP。

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { nodeEnv, nodeFileIO } from "./env";
import { appPaths } from "./store";
import { loadUsers, SessionStore } from "./auth";
import { loadOrCreateMasterKey, open, readModelConfig } from "./secretbox";
import { Ledger } from "./ledger";
import { ConversationStore } from "./conversations";
import { AgentStore } from "./agents";
import { SkillStore } from "./skills";
import { McpRegistry } from "./mcp";
import { MemoryStore } from "./memory";
import { Scheduler, TaskStore, type TaskDef } from "./tasks";
import { NotificationStore } from "./notify";
import { createAppServer } from "./server";
import { createOpenAICompatAdapter, type LlmAdapter } from "../harness/index";

async function main(): Promise<void> {
  const dataRoot = resolve(process.env.OP_DATA ?? "./data");
  const port = Number(process.env.OP_PORT ?? 8787);
  await mkdir(dataRoot, { recursive: true });

  const paths = appPaths(dataRoot);
  const masterKey = await loadOrCreateMasterKey(dataRoot);
  const users = await loadUsers(nodeFileIO, paths.usersFile);
  const usersByUid = new Map([...users.values()].map((u) => [u.uid, u]));
  // 会话持久化（批次4 硬化：重启不掉线）
  const sessions = await SessionStore.load({ fileIO: nodeFileIO, file: join(dataRoot, "sessions.jsonl") }, () => Date.now());

  // 账本实例缓存：同 uid 恒同一 Ledger（串行队列在实例内）
  const ledgers = new Map<string, Promise<Ledger>>();
  const ledgerFor = (uid: string): Promise<Ledger> => {
    let ledger = ledgers.get(uid);
    if (!ledger) {
      ledger = Ledger.open(nodeFileIO, paths.lifeFile(uid));
      ledgers.set(uid, ledger);
    }
    return ledger;
  };

  // adapter 现读配置：改模型设置后下一回合即生效，无需重启或清会话池
  const modelConfigFor = (uid: string) => readModelConfig(nodeFileIO, paths.modelFile(uid));
  const adapterFactory = (uid: string): LlmAdapter => ({
    name: "byok-live",
    async complete(request, options) {
      const config = await modelConfigFor(uid);
      if (!config) {
        throw Object.assign(new Error("model not configured"), { name: "ModelNotConfiguredError" });
      }
      const adapter = createOpenAICompatAdapter(nodeEnv, {
        baseURL: config.baseURL,
        apiKey: config.keyEnc ? open(masterKey, config.keyEnc) : "",
      });
      return adapter.complete(request, options);
    },
  });

  const agents = new AgentStore({ fileIO: nodeFileIO, paths, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const skills = new SkillStore({ fileIO: nodeFileIO, paths, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const mcps = new McpRegistry({ env: nodeEnv, fileIO: nodeFileIO, paths, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const memory = new MemoryStore({ fileIO: nodeFileIO, paths, now: () => Date.now() });
  const tasks = new TaskStore({ fileIO: nodeFileIO, paths, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const notifications = new NotificationStore({ fileIO: nodeFileIO, paths, now: () => Date.now() });

  const conversations = new ConversationStore({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    ledgerFor,
    modelConfigFor,
    adapterFactory,
    now: () => Date.now(),
    agents,
    skills,
    mcps,
    memory,
    tasks,
  });

  // 任务执行体（调度/手动共用）：离线回合跑进任务专属会话，收口后把助手文本落站内通知
  const taskRunner = async (uidRun: string, task: TaskDef): Promise<void> => {
    const agent = await conversations.taskAgent(uidRun, task.id, task.agentId);
    agent.followup(task.instruction);
    await agent.whenIdle();
    const events = agent.sessionLog.readAll();
    const last = [...events].reverse().find((e) => e.type === "assistant/message");
    const text =
      last && last.type === "assistant/message"
        ? last.message.content.filter((b) => b.type === "text").map((b) => (b as { text?: string }).text ?? "").join("")
        : "（任务已执行，无文本输出）";
    await notifications.push(uidRun, { kind: "task_message", taskId: task.id, text: text.slice(0, 500) });
  };

  // 记忆凝练 adapter：现读用户 BYOK 配置
  const adapterFor = async (uid: string) => {
    const config = await modelConfigFor(uid);
    if (!config || !config.keyEnc) return null;
    return {
      adapter: createOpenAICompatAdapter(nodeEnv, { baseURL: config.baseURL, apiKey: open(masterKey, config.keyEnc) }),
      model: config.model,
    };
  };

  const staticDir = resolve("web/dist");
  const server = createAppServer({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    masterKey,
    users,
    usersByUid,
    sessions,
    conversations,
    ledgerFor,
    adapterFor,
    agents,
    skills,
    mcps,
    memory,
    tasks,
    notifications,
    taskRunner,
    ...(existsSync(staticDir) ? { staticDir } : {}),
  });

  const scheduler = new Scheduler({
    uids: () => [...users.values()].map((u) => u.uid),
    tasks,
    runTask: taskRunner,
    now: () => Date.now(),
    logger: (line) => process.stdout.write(`${line}
`),
  });
  scheduler.start();
  process.on("SIGINT", () => {
    scheduler.stop();
    server.close(() => process.exit(0));
  });

  await new Promise<void>((resolveListen) => server.listen(port, "0.0.0.0", resolveListen));
  process.stdout.write(`[openprism] listening on http://127.0.0.1:${port} (data: ${dataRoot}${existsSync(staticDir) ? ", static: web/dist" : ""})\n`);

  // 自动凝练（5.1 本土化：夜间/懒——启动惰性检查）：lastRun 超 20h 且有会话 → 后台跑一次
  void (async () => {
    for (const username of users.keys()) {
      const user = users.get(username)!;
      const meta = await memory.meta(user.uid);
      const stale = meta.lastRunTs === undefined || Date.now() - meta.lastRunTs > 20 * 3600 * 1000;
      if (!stale) continue;
      const hasConversations = (await conversations.list(user.uid)).length > 0;
      if (!hasConversations) continue;
      const built = await adapterFor(user.uid);
      if (!built) continue;
      const texts: string[] = [];
      for (const entry of await conversations.list(user.uid)) {
        for (const line of await nodeFileIO.readAll(join(paths.convDir(user.uid, entry.id), "session.jsonl"))) {
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
      try {
        const result = await memory.consolidate({ uid: user.uid, adapter: built.adapter, model: built.model, sessionTexts: texts.slice(-40) });
        process.stdout.write(`[openprism] memory consolidate ${user.username}: changed=${result.changed}\n`);
      } catch (error) {
        process.stdout.write(`[openprism] memory consolidate ${user.username} failed: ${String((error as Error).message)}\n`);
      }
    }
  })();

}

void main();
