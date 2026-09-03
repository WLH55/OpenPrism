// 会话池（批次 1）：一个会话 = 一个 Agent 实例（JsonlSessionLog + 四工具 + 默认助手人设 + 用户 BYOK adapter）。
// 批次 1 单默认助手；多智能体三段配置（人设卡/能力绑定/记忆注入）在批次 2 替换 systemPrompt 与 tools 装配。

import { join } from "node:path";
import type { Agent, FileIO, LlmAdapter, PlatformEnv } from "../harness/index";
import { createAgent } from "../harness/index";
import { JsonlSessionLog } from "../harness/index";
import type { AppPaths } from "./store";
import type { Ledger } from "./ledger";
import { createLedgerTools } from "./tools";
import { defaultAssistantPrompt } from "./persona";
import type { ModelConfig } from "./secretbox";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("model not configured（先在设置页配置 baseURL / API Key / 模型）");
    this.name = "ModelNotConfiguredError";
  }
}

export interface ConversationDeps {
  env: PlatformEnv;
  fileIO: FileIO;
  paths: AppPaths;
  ledgerFor(uid: string): Promise<Ledger>;
  modelConfigFor(uid: string): Promise<ModelConfig | null>;
  /** 测试注 mock；生产 = openai-compat + 主密钥解 keyEnc */
  adapterFactory(uid: string, config: ModelConfig): LlmAdapter;
  now(): number;
}

export interface ConversationEntry {
  id: string;
  title: string;
  createdTs: number;
}

const INDEX_FILE = "index.jsonl";

export class ConversationStore {
  private pool = new Map<string, Agent>();
  private assembling = new Map<string, Promise<Agent>>();

  constructor(private deps: ConversationDeps) {}

  private indexFile(uid: string): string {
    return join(this.deps.paths.conversationsDir(uid), INDEX_FILE);
  }

  async list(uid: string): Promise<ConversationEntry[]> {
    const entries: ConversationEntry[] = [];
    for (const line of await this.deps.fileIO.readAll(this.indexFile(uid))) {
      try {
        const entry = JSON.parse(line) as ConversationEntry;
        if (typeof entry?.id === "string") entries.push(entry);
      } catch {
        // 崩溃半行
      }
    }
    return entries;
  }

  async create(uid: string, title = "新对话"): Promise<ConversationEntry> {
    const entry: ConversationEntry = {
      id: this.deps.env.randomUUID(),
      title,
      createdTs: this.deps.now(),
    };
    await this.deps.fileIO.appendLine(this.indexFile(uid), JSON.stringify(entry));
    return entry;
  }

  /** 池化装配：同 (uid, cid) 恒同一 Agent 实例；并发调用共享同一次装配 */
  async agent(uid: string, cid: string): Promise<Agent> {
    const key = `${uid}:${cid}`;
    const cached = this.pool.get(key);
    if (cached) return cached;
    const pending = this.assembling.get(key);
    if (pending) return pending;
    const assembling = this.assemble(uid, cid).finally(() => this.assembling.delete(key));
    this.assembling.set(key, assembling);
    const agent = await assembling;
    this.pool.set(key, agent);
    return agent;
  }

  private async assemble(uid: string, cid: string): Promise<Agent> {
    const { env, fileIO, paths, now } = this.deps;
    const config = await this.deps.modelConfigFor(uid);
    if (!config) throw new ModelNotConfiguredError();
    const sessionLog = await JsonlSessionLog.open(fileIO, join(paths.convDir(uid, cid), "session.jsonl"), now);
    const ledger = await this.deps.ledgerFor(uid);
    return createAgent({
      env,
      sessionLog,
      adapter: this.deps.adapterFactory(uid, config),
      model: { provider: "byok", model: config.model },
      systemPrompt: () => defaultAssistantPrompt({ now }),
      tools: createLedgerTools({
        ledger,
        now,
        actor: () => ({ conversationId: cid, agentName: "助手" }),
      }),
      maxStepsPerTurn: 24,
    });
  }

  async send(uid: string, cid: string, text: string): Promise<void> {
    const agent = await this.agent(uid, cid);
    agent.followup(text);
  }
}
