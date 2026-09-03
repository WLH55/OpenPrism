// 会话池：一个会话 = 一个 Agent 实例。批次 2 起按「当前伙伴」装配：
// meta.json 记 agentId + 切换史；systemPrompt 每步同步重读（人设/记忆/技能目录改动下一步生效，D4.2/4.1）；
// 能力绑定（工具开关 + 技能 + MCP）在装配时生效；save_preference 恒可用（记忆全局唯一，D5）。

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, FileIO, LlmAdapter, PlatformEnv, ToolDefinition } from "../harness/index";
import { createAgent } from "../harness/index";
import { JsonlSessionLog } from "../harness/index";
import type { AppPaths } from "./store";
import type { Ledger } from "./ledger";
import { AgentStore, agentIndexFile, agentPersonaFile, type AgentBinding } from "./agents";
import { createLedgerTools } from "./tools";
import { composeAssistantPrompt, defaultAssistantPrompt, extractAgentName } from "./persona";
import { createLoadSkillTool, skillCatalogPrompt, skillIndexFile, type SkillMeta } from "./skills";
import { createSavePreferenceTool, syncInjectionBlock } from "./memory";
import type { McpRegistry } from "./mcp";
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
  /** 用户当地时区（分钟，UTC+local）；缺省按服务器本地时区 */
  tzOffsetMinutes?(): number;
  agents: AgentStore;
  skills: SkillStoreLike;
  mcps: McpRegistry;
  memory: MemoryStoreLike;
}

/** 测试替身面（避免循环依赖具体类） */
export interface SkillStoreLike {
  list(uid: string): Promise<SkillMetaLike[]>;
  body(uid: string, sid: string): Promise<string>;
}
export interface SkillMetaLike {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
}
export interface MemoryStoreLike {
  writeSlot(uid: string, slot: string, markdown: string): Promise<void>;
  appendPreference(uid: string, line: string, ts: number): Promise<void>;
}

export interface ConversationEntry {
  id: string;
  title: string;
  createdTs: number;
}

export interface ConversationMeta {
  agentId?: string;
  switches: { ts: number; agentId: string }[];
}

const INDEX_FILE = "index.jsonl";

export class ConversationStore {
  private pool = new Map<string, Agent>();
  private assembling = new Map<string, Promise<Agent>>();

  constructor(private deps: ConversationDeps) {}

  private indexFile(uid: string): string {
    return join(this.deps.paths.conversationsDir(uid), INDEX_FILE);
  }
  private metaFile(uid: string, cid: string): string {
    return join(this.deps.paths.convDir(uid, cid), "meta.json");
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
    const entry: ConversationEntry = { id: this.deps.env.randomUUID(), title, createdTs: this.deps.now() };
    await this.deps.fileIO.appendLine(this.indexFile(uid), JSON.stringify(entry));
    return entry;
  }

  async metaFor(uid: string, cid: string): Promise<ConversationMeta> {
    try {
      const meta = JSON.parse(await readFile(this.metaFile(uid, cid), "utf8")) as ConversationMeta;
      return { ...meta, switches: Array.isArray(meta.switches) ? meta.switches : [] };
    } catch {
      return { switches: [] };
    }
  }

  private readMetaSync(uid: string, cid: string): ConversationMeta {
    try {
      const meta = JSON.parse(readFileSync(this.metaFile(uid, cid), "utf8")) as ConversationMeta;
      return { ...meta, switches: Array.isArray(meta.switches) ? meta.switches : [] };
    } catch {
      return { switches: [] };
    }
  }

  /** 切换伙伴（D4.2）：只换 system prompt 与装配，历史不丢；切换历史供 UI 画分割线 */
  async switchAgent(uid: string, cid: string, agentId: string): Promise<void> {
    const agents = await this.deps.agents.list(uid);
    if (!agents.some((a) => a.id === agentId)) throw new Error(`agent "${agentId}" 不存在`);
    const meta = await this.metaFor(uid, cid);
    meta.agentId = agentId;
    meta.switches.push({ ts: this.deps.now(), agentId });
    const file = this.metaFile(uid, cid);
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(meta), "utf8");
    await rename(tmp, file);
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

  /** 当前伙伴的同步视图（systemPrompt 每步重取 & 账本 actor 都要同步拿） */
  private syncCurrentAgent(uid: string, cid: string): { agentId?: string; name: string; persona?: string; binding: AgentBinding } {
    const meta = this.readMetaSync(uid, cid);
    if (!meta.agentId) return { name: "助手", binding: { skills: [], mcps: [] } };
    let persona: string | undefined;
    try {
      persona = readFileSync(agentPersonaFile(this.deps.paths, uid, meta.agentId), "utf8");
    } catch {
      // 人设文件丢失 → 退默认身份
    }
    let name = "助手";
    let binding: AgentBinding = { skills: [], mcps: [] };
    try {
      for (const line of readFileSync(agentIndexFile(this.deps.paths, uid), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { id: string; name: string; binding: AgentBinding };
          if (entry.id === meta.agentId) {
            name = entry.name || extractAgentName(persona ?? "") || "助手";
            if (entry.binding) binding = entry.binding;
            break;
          }
        } catch {
          // 坏行
        }
      }
    } catch {
      // 索引不存在
    }
    return { agentId: meta.agentId, name, persona, binding };
  }

  /** 同步取绑定技能的目录层元数据 */
  private syncBoundSkills(uid: string, binding: AgentBinding): SkillMeta[] {
    if (binding.skills.length === 0) return [];
    const metas: SkillMeta[] = [];
    try {
      for (const line of readFileSync(skillIndexFile(this.deps.paths, uid), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const meta = JSON.parse(line) as SkillMeta;
          if (binding.skills.includes(meta.id)) metas.push(meta);
        } catch {
          // 坏行
        }
      }
    } catch {
      // 索引不存在
    }
    return metas;
  }

  /** systemPrompt 闭包（同步）：人设 + 记忆注入 + 技能目录，每步重读盘（改动下一步生效） */
  private composePrompt(uid: string, cid: string): string {
    const current = this.syncCurrentAgent(uid, cid);
    const memoryBlock = syncInjectionBlock(this.deps.paths, uid);
    const catalog = skillCatalogPrompt(this.syncBoundSkills(uid, current.binding));
    const merged = [memoryBlock, catalog].filter((block) => block !== "").join("\n\n");
    return composeAssistantPrompt({
      persona: current.persona,
      ...(merged !== "" ? { memoryBlock: merged } : {}),
      now: this.deps.now,
      tzOffsetMinutes: this.deps.tzOffsetMinutes?.() ?? -new Date().getTimezoneOffset(),
    });
  }

  private async assemble(uid: string, cid: string): Promise<Agent> {
    const { env, fileIO, paths, now } = this.deps;
    const config = await this.deps.modelConfigFor(uid);
    if (!config) throw new ModelNotConfiguredError();
    const sessionLog = await JsonlSessionLog.open(fileIO, join(paths.convDir(uid, cid), "session.jsonl"), now);
    const ledger = await this.deps.ledgerFor(uid);

    // 装配期快照绑定（工具集）；systemPrompt 每步重读（人设/记忆/目录热更）
    const meta = await this.metaFor(uid, cid);
    let binding: AgentBinding = { skills: [], mcps: [] };
    if (meta.agentId) {
      const agents = await this.deps.agents.list(uid);
      binding = agents.find((a) => a.id === meta.agentId)?.binding ?? binding;
    }

    const ledgerTools = createLedgerTools({
      ledger,
      now,
      actor: () => {
        const agentNow = this.syncCurrentAgent(uid, cid);
        return { conversationId: cid, agentName: agentNow.name };
      },
    }).filter((tool) => !binding.tools || binding.tools.length === 0 || binding.tools.includes(tool.name));

    const tools: ToolDefinition[] = [...ledgerTools];
    if (binding.skills.length > 0) {
      tools.push(createLoadSkillTool({ store: this.deps.skills as unknown as import("./skills").SkillStore, uid }));
    }
    tools.push(createSavePreferenceTool({ store: this.deps.memory as unknown as import("./memory").MemoryStore, uid, now }));
    for (const mcpId of binding.mcps) {
      tools.push(...(await this.deps.mcps.toolsFor(uid, mcpId)));
    }

    return createAgent({
      env,
      sessionLog,
      adapter: this.deps.adapterFactory(uid, config),
      model: { provider: "byok", model: config.model },
      systemPrompt: () => this.composePrompt(uid, cid),
      tools,
      maxStepsPerTurn: 24,
    });
  }

  async send(uid: string, cid: string, text: string): Promise<void> {
    const agent = await this.agent(uid, cid);
    agent.followup(text);
  }
}
