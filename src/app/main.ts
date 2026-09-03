// 进程入口（批次 1）：OP_DATA（默认 ./data）+ OP_PORT（默认 8787）。
// 装配：nodeEnv/nodeFileIO → 主密钥 → 用户表 → 会话池（adapter 每次调用现读配置，改设置即时生效）→ HTTP。

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { nodeEnv, nodeFileIO } from "./env";
import { appPaths } from "./store";
import { loadUsers, SessionStore } from "./auth";
import { loadOrCreateMasterKey, open, readModelConfig, type ModelConfig } from "./secretbox";
import { Ledger } from "./ledger";
import { ConversationStore } from "./conversations";
import { createAppServer } from "./server";
import { createOpenAICompatAdapter, type LlmAdapter } from "../harness/index";

async function main(): Promise<void> {
  const dataRoot = resolve(process.env.OP_DATA ?? "./data");
  const port = Number(process.env.OP_PORT ?? 8787);
  await mkdir(dataRoot, { recursive: true });

  const paths = appPaths(dataRoot);
  const masterKey = await loadOrCreateMasterKey(dataRoot);
  const users = await loadUsers(nodeFileIO, paths.usersFile);
  const sessions = new SessionStore(() => Date.now());

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

  const conversations = new ConversationStore({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    ledgerFor,
    modelConfigFor,
    adapterFactory,
    now: () => Date.now(),
  });

  const staticDir = resolve("web/dist");
  const server = createAppServer({
    env: nodeEnv,
    fileIO: nodeFileIO,
    paths,
    masterKey,
    users,
    sessions,
    conversations,
    ledgerFor,
    ...(existsSync(staticDir) ? { staticDir } : {}),
  });

  await new Promise<void>((resolveListen) => server.listen(port, "0.0.0.0", resolveListen));
  process.stdout.write(`[openprism] listening on http://127.0.0.1:${port} (data: ${dataRoot}${existsSync(staticDir) ? ", static: web/dist" : ""})\n`);

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

void main();
