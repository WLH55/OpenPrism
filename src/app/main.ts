// 进程入口（ADR 0008）：OP_DATA（默认 ./data）+ OP_PORT（默认 8787）+ OP_DB（默认 {OP_DATA}/openprism.db）。
// 装配：openDb → 旧数据迁移（幂等）→ 主密钥 → 用户表 → 会话池（adapter 每次调用现读配置，改设置即时生效）→ HTTP。
// 内存模型：启动只载用户表；账本/会话/任务等按 uid 懒加载（活跃工作集），不再全量预载。

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { nodeEnv } from "./env";
import { appPaths } from "./store";
import { openDb } from "./db";
import { migrateLegacy, migrateLegacyModelConfig } from "./migrate";
import { loadUsers, SessionStore } from "./auth";
import { loadOrCreateMasterKey, open, readModelConfig, readModelProviderConfig, type ModelConfig } from "./secretbox";
import { Ledger } from "./ledger";
import { ConversationStore } from "./conversations";
import { SqliteSessionLog } from "./session-log";
import { AgentStore } from "./agents";
import { SkillStore } from "./skills";
import { McpRegistry } from "./mcp";
import { MemoryStore } from "./memory";
import { MemoryLayers } from "./memory-layers";
import { Scheduler, TaskStore, type TaskDef } from "./tasks";
import { NotificationStore } from "./notify";
import { createAppServer } from "./server";
import { createOpenAICompatAdapter, type LlmAdapter } from "../harness/index";

async function main(): Promise<void> {
  const dataRoot = resolve(process.env.OP_DATA ?? "./data");
  const port = Number(process.env.OP_PORT ?? 8787);
  const dbFile = process.env.OP_DB ? resolve(process.env.OP_DB) : appPaths(dataRoot).dbFile;
  await mkdir(dataRoot, { recursive: true });

  const db = openDb(dbFile);
  const migrated = migrateLegacy(db, dataRoot);
  if (migrated) {
    process.stdout.write(`[openprism] legacy JSONL imported into ${dbFile}\n`);
  }
  migrateLegacyModelConfig(db); // 旧单模型配置 → model_providers（幂等）

  const masterKey = await loadOrCreateMasterKey(dataRoot, appPaths(dataRoot).secretKeyFile);
  const users = await loadUsers(db);
  const usersByUid = new Map([...users.values()].map((u) => [u.uid, u]));
  const sessions = new SessionStore(db, () => Date.now());

  // 账本实例缓存：同 uid 恒同一 Ledger（串行写队列在实例内；按需懒加载）
  const ledgers = new Map<string, Promise<Ledger>>();
  const ledgerFor = (uid: string): Promise<Ledger> => {
    let ledger = ledgers.get(uid);
    if (!ledger) {
      ledger = Ledger.open(db, uid);
      ledgers.set(uid, ledger);
    }
    return ledger;
  };

  // adapter 现读配置：改模型设置后下一回合即生效，无需重启或清会话池。
  // 会话绑定了 providerId 时现读该供应商行，否则读用户全局激活。
  const modelConfigFor = async (uid: string, providerId?: string | null): Promise<ModelConfig | null> =>
    providerId ? readModelProviderConfig(db, uid, providerId) : readModelConfig(db, uid);
  const adapterFactory = (uid: string, providerId: string | null, config: ModelConfig): LlmAdapter => ({
    name: "byok-live",
    async complete(request, options) {
      const live = providerId ? ((await readModelProviderConfig(db, uid, providerId)) ?? config) : ((await readModelConfig(db, uid)) ?? config);
      const adapter = createOpenAICompatAdapter(nodeEnv, {
        baseURL: live.baseURL,
        apiKey: live.keyEnc ? open(masterKey, live.keyEnc) : "",
      });
      return adapter.complete(request, options);
    },
  });

  const agents = new AgentStore({ db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const skills = new SkillStore({ db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const mcps = new McpRegistry({ env: nodeEnv, db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const memory = new MemoryStore({ db, now: () => Date.now() });
  const tasks = new TaskStore({ db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const memoryLayers = new MemoryLayers({ db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID(), ledgerFor, tasks }, memory);
  const notifications = new NotificationStore({ db, now: () => Date.now() });

  const conversations = new ConversationStore(
    {
      env: nodeEnv,
      sessionLog: (key) => Promise.resolve(SqliteSessionLog.open(db, key, () => Date.now())),
      ledgerFor,
      modelConfigFor,
      adapterFactory,
      now: () => Date.now(),
      agents,
      skills,
      mcps,
      memory,
      tasks,
    },
    db,
  );

  // 任务执行体（调度/手动共用）：跑进该伙伴的固定提醒会话（不存在即创建、置顶显示），
  // 助手回复直接落在会话里；同时落一条站内通知兜底（提醒页徽标）
  const taskRunner = async (uidRun: string, task: TaskDef): Promise<void> => {
    const feed = await conversations.ensureTaskFeed(uidRun, task.agentId);
    const agent = await conversations.agent(uidRun, feed.id);
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
    db,
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
    memoryLayers,
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

  // 记忆三层全链（2026-09-07）：启动惰性检查——距上次全链超 20h 且有会话 → 后台跑 L1 refresh → L2 抽取 → L3 综合
  void (async () => {
    for (const user of users.values()) {
      const meta = await memory.meta(user.uid);
      const stale = meta.lastRunTs === undefined || Date.now() - meta.lastRunTs > 20 * 3600 * 1000;
      if (!stale) continue;
      const hasConversations = (await conversations.list(user.uid)).length > 0;
      if (!hasConversations) continue;
      const built = await adapterFor(user.uid);
      if (!built) continue;
      try {
        const result = await memoryLayers.runAll(user.uid, built.adapter, built.model);
        await memory.markRun(user.uid);
        process.stdout.write(
          `[openprism] memory run ${user.username}: l1+${result.l1.chat.added + result.l1.ledger.added + result.l1.tasks.added} l2+${result.l2.chat.added + result.l2.ledger.added + result.l2.tasks.added}\n`,
        );
      } catch (error) {
        process.stdout.write(`[openprism] memory run ${user.username} failed: ${String((error as Error).message)}\n`);
      }
    }
  })();

}

void main();
