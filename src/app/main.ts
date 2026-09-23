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
import { MemoryExtractor, migrateLegacyMemory, nightlyDue } from "./memory-extract";
import { createMemoryVector } from "./memory-vector";
import { Scheduler, TaskStore, taskTriggerMessage, type TaskDef, type TaskRunTrigger } from "./tasks";
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
  const memory = new MemoryStore({ db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const tasks = new TaskStore({ db, now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  // 旧 L2/槽数据一次性迁移（幂等）；水位线初始化 = 现状（历史不重喂，见 Spec §6.4）
  migrateLegacyMemory(db, { now: () => Date.now(), randomUUID: () => nodeEnv.randomUUID() });
  const notifications = new NotificationStore({ db, now: () => Date.now() });

  // 向量召回服务（2026-09-18）：embedding 提供方 = memory_meta.embedding_provider_id 现读（改绑定即时生效）
  const embeddingFor = async (uid: string) => {
    const providerId = memory.metaRow(uid).embeddingProviderId;
    if (!providerId) return null;
    const config = await readModelProviderConfig(db, uid, providerId);
    if (!config || !config.keyEnc) return null;
    return {
      adapter: createOpenAICompatAdapter(nodeEnv, { baseURL: config.baseURL, apiKey: open(masterKey, config.keyEnc) }),
      model: config.model,
      providerId,
    };
  };
  const memoryVector = createMemoryVector({
    db,
    now: () => Date.now(),
    embeddingFor,
    log: (line) => process.stdout.write(`${line}\n`),
  });

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
      memoryVector,
      tasks,
      onTurnDone: (uidTurn) => memoryExtractor.notify(uidTurn),
    },
    db,
  );

  // 任务执行体（调度/手动共用）：跑进该伙伴的固定提醒会话（不存在即创建、置顶显示），
  // 助手回复直接落在会话里；同时落一条站内通知兜底（提醒页徽标）。
  // 投给模型的是触发上下文（自动触发说明 + 任务内容 + 重复规则 + 计划/触发时刻），不是光秃秃一句指令——
  // 否则模型把到点指令当成用户刚说的话，回头反问"每天还是今天一次、几点提醒"。
  const taskRunner = async (uidRun: string, task: TaskDef, run: TaskRunTrigger): Promise<void> => {
    const feed = await conversations.ensureTaskFeed(uidRun, task.agentId);
    const agent = await conversations.agent(uidRun, feed.id);
    agent.followup(taskTriggerMessage(task, run, Date.now()));
    await agent.whenIdle();
    const events = agent.sessionLog.readAll();
    const last = [...events].reverse().find((e) => e.type === "assistant/message");
    const text =
      last && last.type === "assistant/message"
        ? last.message.content.filter((b) => b.type === "text").map((b) => (b as { text?: string }).text ?? "").join("")
        : "（任务已执行，无文本输出）";
    await notifications.push(uidRun, { kind: "task_message", taskId: task.id, text: text.slice(0, 500) });
  };

  // 记忆提取 adapter：现读用户 BYOK 配置
  const adapterFor = async (uid: string) => {
    const config = await modelConfigFor(uid);
    if (!config || !config.keyEnc) return null;
    return {
      adapter: createOpenAICompatAdapter(nodeEnv, { baseURL: config.baseURL, apiKey: open(masterKey, config.keyEnc) }),
      model: config.model,
    };
  };

  // 记忆提取管线（条目化，2026-09-10）：三 surface 水位线/指纹检测 + 决策制蒸馏 + 整理；
  // 2026-09-18 增：语义候选（旧条目超限时按向量检索）+ 新条目向量写入
  const memoryExtractor = new MemoryExtractor({
    db,
    now: () => Date.now(),
    memory,
    adapterFor,
    vectorCandidates: async (uid, query, limit) => {
      const hits = await memoryVector.recallHits(uid, query, { scope: "all", limit });
      if (hits === null) return null;
      return memory.getItemsByIds(uid, hits.map((h) => h.id));
    },
    embedNewItems: (uid, items) => memoryVector.embedNewItems(uid, items),
  });

  // embedding 提供方连接测试（设置页"测试"按钮对 kind=embedding 的提供方）
  const embeddingTester = async (uid: string, providerId: string): Promise<void> => {
    const config = await readModelProviderConfig(db, uid, providerId);
    if (!config || !config.keyEnc) throw new Error("embedding 提供方未配置 API Key");
    const adapter = createOpenAICompatAdapter(nodeEnv, { baseURL: config.baseURL, apiKey: open(masterKey, config.keyEnc) });
    if (!adapter.embed) throw new Error("该提供方不支持 embedding 调用");
    await adapter.embed({ model: config.model, input: "connection test" });
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
    embeddingTester,
    embedNewItems: (uid, items) => memoryVector.embedNewItems(uid, items),
    agents,
    skills,
    mcps,
    memory,
    memoryExtractor,
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
  // 记忆提取调度（2026-09-10，WeKnora 化）：10s 扫描到期用户（去抖 90s 登记的）→ 逐个串行提取；
  // 在飞超时自动判死（进程崩溃后重启即恢复），无需专门恢复逻辑
  const EXTRACT_CHECK_MS = 10 * 1000;
  const extractTimer = setInterval(() => {
    void (async () => {
      for (const uid of memoryExtractor.dueUids([...users.values()].map((u) => u.uid), Date.now())) {
        const summary = await memoryExtractor.runDue(uid);
        if (summary.segments > 0 || summary.skipped === "model_error") {
          process.stdout.write(
            `[openprism] memory extract ${uid}: +${summary.added} ~${summary.updated} -${summary.deleted} (segments ${summary.segments}${summary.skipped ? `, ${summary.skipped}` : ""})\n`,
          );
        }
      }
    })().catch((error) => process.stdout.write(`[openprism] memory extract failed: ${String((error as Error).message)}\n`));
  }, EXTRACT_CHECK_MS);
  // 每晚整理维护（2026-09-08 引入、2026-09-10 改为只整理）：本地 2–5 点窗口 + 距上次 ≥20h → 合并冗余/过期归档/陈旧降级
  const NIGHTLY_CHECK_MS = 10 * 60 * 1000;
  const nightlyTimer = setInterval(() => {
    void runConsolidateForAll("nightly");
  }, NIGHTLY_CHECK_MS);
  process.on("SIGINT", () => {
    scheduler.stop();
    clearInterval(extractTimer);
    clearInterval(nightlyTimer);
    server.close(() => process.exit(0));
  });

  await new Promise<void>((resolveListen) => server.listen(port, "0.0.0.0", resolveListen));
  process.stdout.write(`[openprism] listening on http://127.0.0.1:${port} (data: ${dataRoot}${existsSync(staticDir) ? ", static: web/dist" : ""})\n`);

  // 启动补跑：距上次整理超 20h 且有条目 → 后台跑一次 consolidate（不限钟点，作白天补跑）
  void runConsolidateForAll("startup");

  async function runConsolidateForAll(reason: "startup" | "nightly"): Promise<void> {
    for (const user of users.values()) {
      const meta = memory.metaRow(user.uid);
      const stale = meta.consolidatedTs === undefined || Date.now() - meta.consolidatedTs > 20 * 3600 * 1000;
      if (!stale) continue;
      // 夜间档还要求在 2–5 点窗口内（启动档不限钟点，作白天补跑）
      if (reason === "nightly" && !nightlyDue(meta.consolidatedTs, Date.now())) continue;
      if (memory.countByStatus(user.uid).total === 0) continue;
      const built = await adapterFor(user.uid);
      if (!built) continue;
      try {
        const result = await memoryExtractor.consolidate(user.uid, built.adapter, built.model);
        process.stdout.write(
          `[openprism] memory consolidate (${reason}) ${user.username}: reviewed ${result.reviewed}, expired ${result.expired}, demoted ${result.demoted}, merged ${result.merged}\n`,
        );
      } catch (error) {
        process.stdout.write(`[openprism] memory consolidate (${reason}) ${user.username} failed: ${String((error as Error).message)}\n`);
      }
      // 向量回填（2026-09-18）：整理后顺带补缺失向量（每轮限速 200 条；未配置 embedding 时内部直返 0）
      try {
        const filled = await memoryVector.backfill(user.uid);
        if (filled > 0) process.stdout.write(`[openprism] memory embeddings backfill (${reason}) ${user.username}: +${filled}\n`);
      } catch (error) {
        process.stdout.write(`[openprism] memory embeddings backfill (${reason}) ${user.username} failed: ${String((error as Error).message)}\n`);
      }
    }
  }

}

void main();
