// 会话池：一个会话 = 一个 Agent 实例（ADR 0008 领域表）。
// conversations 表记 title + 当前伙伴 agentId + 切换史；conversation_events 表存九事件；
// systemPrompt 每步同步重读（人设/记忆/技能目录改动下一步生效，D4.2/4.1）；
// 能力绑定（工具开关 + 技能 + MCP）在装配时生效；save_preference 恒可用（记忆全局唯一，D5）。

import type { Agent, LlmAdapter, PlatformEnv, SessionLog, ToolDefinition } from "../harness/index";
import { createAgent } from "../harness/index";
import type { DatabaseSync } from "node:sqlite";
import type { Ledger } from "./ledger";
import { AgentStore, type AgentBinding } from "./agents";
import { createLedgerTools } from "./tools";
import { composeAssistantPrompt } from "./persona";
import { createLoadSkillTool, skillCatalogPrompt, type SkillMeta } from "./skills";
import { createSavePreferenceTool } from "./memory";
import { createTaskTools } from "./tasks";
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
  /** 会话日志缝：key = 聊天 cid 或 `task:<taskId>`；生产 = SqliteSessionLog，测试可注入内存实现 */
  sessionLog(key: string): Promise<SessionLog>;
  ledgerFor(uid: string): Promise<Ledger>;
  /** providerId 缺省/null = 跟随用户全局激活模型 */
  modelConfigFor(uid: string, providerId?: string | null): Promise<ModelConfig | null>;
  /** 测试注 mock；生产 = openai-compat + 主密钥解 keyEnc（providerId 非空时现读该供应商行） */
  adapterFactory(uid: string, providerId: string | null, config: ModelConfig): LlmAdapter;
  now(): number;
  /** 用户当地时区（分钟，UTC+local）；缺省按服务器本地时区 */
  tzOffsetMinutes?(): number;
  agents: AgentStore;
  skills: SkillStoreLike;
  mcps: McpRegistry;
  memory: MemoryStoreLike;
  /** 定时任务工具（create_task，D6.4 双入口之二）；缺省不装配 */
  tasks?: TaskStoreLike;
}

export interface TaskStoreLike {
  create(uid: string, input: Record<string, unknown>): Promise<unknown>;
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
  pinned: boolean;
  createdTs: number;
}

const DEFAULT_TITLE = "新对话";
const TITLE_MAX_RUNES = 24;
/** 任务提醒固定会话的 cid 前缀：每个伙伴一个（默认助手 = feed:default），存在即复用 */
const TASK_FEED_PREFIX = "feed:";

const TITLE_PROMPT = `根据用户的提问生成一个简短的会话标题。
要求：
- 4-10 个词
- 只提取提问的意图，不要回答内容
- 只输出标题本身，不要任何解释或引号
- 使用与用户提问相同的语言`;

function firstRunes(text: string, n: number): string {
  return [...text.trim()].slice(0, n).join("");
}

/** 去思考块、去引号、截长（WeKnora 同款防御） */
function cleanTitle(raw: string): string {
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s"'「『《]+/, "")
    .replace(/[\s"'」』》]+$/, "")
    .trim();
  return firstRunes(stripped, TITLE_MAX_RUNES);
}

export interface ConversationMeta {
  agentId?: string;
  /** 会话级模型绑定；缺省 = 跟随全局激活 */
  modelProviderId?: string;
  switches: { ts: number; agentId: string }[];
}

interface ConversationRow {
  cid: string;
  title: string;
  agent_id: string | null;
  model_provider_id: string | null;
  pinned: number;
  switches_json: string;
  created_ts: number;
}

function rowToEntry(row: ConversationRow): ConversationEntry {
  return { id: row.cid, title: row.title, pinned: row.pinned === 1, createdTs: row.created_ts };
}

export class ConversationStore {
  private pool = new Map<string, Agent>();
  private assembling = new Map<string, Promise<Agent>>();

  constructor(
    private deps: ConversationDeps,
    private db: DatabaseSync,
  ) {}

  async list(uid: string): Promise<ConversationEntry[]> {
    // 置顶（定时提醒会话）在前，其余按创建时间倒序
    const rows = this.db
      .prepare("SELECT cid, title, agent_id, model_provider_id, pinned, switches_json, created_ts FROM conversations WHERE uid = ? ORDER BY pinned DESC, created_ts DESC, cid")
      .all(uid) as unknown as ConversationRow[];
    return rows.map(rowToEntry);
  }

  /**
   * 定时提醒固定会话（2026-09-07）：每个伙伴一个，cid = feed:<agentId|default>。
   * 不存在即创建（置顶 + 绑定该伙伴），存在即复用；绑定该伙伴的所有定时任务提醒都进这一个会话。
   */
  async ensureTaskFeed(uid: string, agentId: string | undefined): Promise<ConversationEntry> {
    const cid = `${TASK_FEED_PREFIX}${agentId ?? "default"}`;
    const found = this.db
      .prepare("SELECT cid, title, agent_id, model_provider_id, pinned, switches_json, created_ts FROM conversations WHERE cid = ? AND uid = ?")
      .get(cid, uid) as unknown as ConversationRow | undefined;
    if (found) return rowToEntry(found);
    let title = "定时提醒";
    if (agentId !== undefined) {
      const agent = (await this.deps.agents.list(uid)).find((a) => a.id === agentId);
      title = `${agent?.name ?? "伙伴"} 的定时提醒`;
    }
    this.db
      .prepare("INSERT OR IGNORE INTO conversations (cid, uid, title, agent_id, pinned, created_ts) VALUES (?, ?, ?, ?, 1, ?)")
      .run(cid, uid, title, agentId ?? null, this.deps.now());
    const created = this.db
      .prepare("SELECT cid, title, agent_id, model_provider_id, pinned, switches_json, created_ts FROM conversations WHERE cid = ? AND uid = ?")
      .get(cid, uid) as unknown as ConversationRow;
    return rowToEntry(created);
  }

  async create(uid: string, title = "新对话"): Promise<ConversationEntry> {
    const entry: ConversationEntry = { id: this.deps.env.randomUUID(), title, pinned: false, createdTs: this.deps.now() };
    this.db
      .prepare("INSERT INTO conversations (cid, uid, title, created_ts) VALUES (?, ?, ?, ?)")
      .run(entry.id, uid, entry.title, entry.createdTs);
    return entry;
  }

  async metaFor(uid: string, cid: string): Promise<ConversationMeta> {
    const row = this.db
      .prepare("SELECT cid, title, agent_id, model_provider_id, switches_json, created_ts FROM conversations WHERE cid = ? AND uid = ?")
      .get(cid, uid) as unknown as ConversationRow | undefined;
    if (!row) return { switches: [] };
    return this.rowToMeta(row);
  }

  private rowToMeta(row: ConversationRow): ConversationMeta {
    let switches: ConversationMeta["switches"] = [];
    try {
      const parsed = JSON.parse(row.switches_json) as ConversationMeta["switches"];
      if (Array.isArray(parsed)) switches = parsed;
    } catch {
      // 坏行防御
    }
    return {
      ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
      ...(row.model_provider_id !== null ? { modelProviderId: row.model_provider_id } : {}),
      switches,
    };
  }

  /** 切换伙伴（D4.2）：只换 system prompt 与装配，历史不丢；切换历史供 UI 画分割线 */
  async switchAgent(uid: string, cid: string, agentId: string): Promise<void> {
    const agents = await this.deps.agents.list(uid);
    if (!agents.some((a) => a.id === agentId)) throw new Error(`agent "${agentId}" 不存在`);
    const meta = await this.metaFor(uid, cid);
    meta.agentId = agentId;
    meta.switches.push({ ts: this.deps.now(), agentId });
    this.db
      .prepare("UPDATE conversations SET agent_id = ?, switches_json = ? WHERE cid = ? AND uid = ?")
      .run(agentId, JSON.stringify(meta.switches), cid, uid);
  }

  /** 会话绑定模型（2026-09-07）：null = 跟随全局激活；切换即弃池，下一回合按新模型重新装配（日志全量在库，装配无损） */
  async switchModel(uid: string, cid: string, providerId: string | null): Promise<void> {
    const exists = this.db.prepare("SELECT 1 AS ok FROM conversations WHERE cid = ? AND uid = ?").get(cid, uid);
    if (!exists) throw new Error(`conversation "${cid}" 不存在`);
    this.db.prepare("UPDATE conversations SET model_provider_id = ? WHERE cid = ? AND uid = ?").run(providerId, cid, uid);
    this.pool.delete(`${uid}:${cid}`);
  }

  /** 弃池某伙伴绑定的全部会话（改伙伴默认模型后热更用：下一回合按新模型重装配） */
  evictAgentConversations(uid: string, agentId: string): void {
    const rows = this.db.prepare("SELECT cid FROM conversations WHERE uid = ? AND agent_id = ?").all(uid, agentId) as unknown as { cid: string }[];
    for (const row of rows) this.pool.delete(`${uid}:${row.cid}`);
  }

  /** 删除会话：行 + 九事件一并删（含任务无涉），弃池；不可恢复 */
  async remove(uid: string, cid: string): Promise<void> {
    const result = this.db.prepare("DELETE FROM conversations WHERE cid = ? AND uid = ?").run(cid, uid);
    if (result.changes === 0) throw new Error(`conversation "${cid}" 不存在`);
    this.db.prepare("DELETE FROM conversation_events WHERE cid = ?").run(cid);
    this.pool.delete(`${uid}:${cid}`);
  }

  /**
   * 自动命名（WeKnora 同款策略）：只处理默认标题的会话；取第一条用户消息，让当前会话模型
   * 生成 4-10 词标题（只提取意图）；模型不可用/失败 → 回退为消息前 24 字截断。失败静默不抛。
   */
  async autoTitle(uid: string, cid: string): Promise<{ title: string } | null> {
    const row = this.db.prepare("SELECT title FROM conversations WHERE cid = ? AND uid = ?").get(cid, uid) as
      | { title: string }
      | undefined;
    if (!row || row.title !== DEFAULT_TITLE) return null; // 不存在 / 已有名字（含手动建会话）跳过
    const eventRows = this.db
      .prepare("SELECT event_json FROM conversation_events WHERE cid = ? AND type = 'user/message' ORDER BY seq LIMIT 1")
      .all(cid) as unknown as { event_json: string }[];
    if (eventRows.length === 0) return null; // 还没有用户消息
    let userText = "";
    try {
      const event = JSON.parse(eventRows[0]!.event_json) as { message?: { content?: { type: string; text?: string }[] } };
      userText = (event.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    } catch {
      return null;
    }
    if (userText.trim() === "") return null;

    const providerId = this.dbMetaSync(uid, cid).modelProviderId ?? null;
    let title = "";
    try {
      const config = await this.deps.modelConfigFor(uid, providerId);
      if (!config) throw new ModelNotConfiguredError();
      const adapter = this.deps.adapterFactory(uid, providerId, config);
      const response = await adapter.complete({
        provider: "title",
        model: config.model,
        system: TITLE_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: userText.slice(0, 2000) }] }],
        maxTokens: 40,
      });
      title = cleanTitle(
        response.message.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text ?? "").join(""),
      );
    } catch {
      // 模型不可用/失败：回退截断（没配 Key 也有可用标题）
    }
    if (title === "") title = firstRunes(userText, TITLE_MAX_RUNES);
    // 防竞态：仅当仍是默认标题时落库（将来手动改名不被覆盖）
    this.db
      .prepare("UPDATE conversations SET title = ? WHERE cid = ? AND uid = ? AND title = ?")
      .run(title, cid, uid, DEFAULT_TITLE);
    return { title };
  }

  /** 池化装配：同 key 恒同一 Agent 实例；并发调用共享同一次装配 */
  private async pooled(key: string, assemble: () => Promise<Agent>): Promise<Agent> {
    const cached = this.pool.get(key);
    if (cached) return cached;
    const pending = this.assembling.get(key);
    if (pending) return pending;
    const creating = assemble().finally(() => this.assembling.delete(key));
    this.assembling.set(key, creating);
    const agent = await creating;
    this.pool.set(key, agent);
    return agent;
  }

  async agent(uid: string, cid: string): Promise<Agent> {
    return this.pooled(`${uid}:${cid}`, () =>
      this.assemble(uid, cid, cid, () => this.dbMetaSync(uid, cid)),
    );
  }

  /** 任务专属持久会话（D6.2）：与聊天回合同权装配；伙伴 = task.agentId（快照），人设正文仍每步热读 */
  async taskAgent(uid: string, taskId: string, agentId: string | undefined): Promise<Agent> {
    const meta: ConversationMeta = { switches: [], ...(agentId !== undefined ? { agentId } : {}) };
    return this.pooled(`${uid}:task:${taskId}`, () =>
      this.assemble(uid, `task:${taskId}`, taskId, () => meta),
    );
  }

  /** 池化装配用的同步 meta（聊天会话）：list/create 走异步，这里同步读单行 */
  private dbMetaSync(uid: string, cid: string): ConversationMeta {
    const row = this.db
      .prepare("SELECT cid, title, agent_id, model_provider_id, switches_json, created_ts FROM conversations WHERE cid = ? AND uid = ?")
      .get(cid, uid) as unknown as ConversationRow | undefined;
    return row ? this.rowToMeta(row) : { switches: [] };
  }

  /** 当前伙伴的同步视图（systemPrompt 每步重取 & 账本 actor 都要同步拿） */
  private syncCurrentAgent(uid: string, meta: ConversationMeta): {
    agentId?: string;
    name: string;
    persona?: string;
    binding: AgentBinding;
    identity?: import("./agents").AgentIdentity;
  } {
    if (!meta.agentId) return { name: "助手", binding: { skills: [], mcps: [] } };
    const snapshot = this.deps.agents.snapshotSync(uid, meta.agentId);
    if (!snapshot) return { name: "助手", binding: { skills: [], mcps: [] } }; // 人设丢失 → 退默认身份
    return { agentId: meta.agentId, name: snapshot.name, persona: snapshot.persona, binding: snapshot.binding, identity: snapshot.identity };
  }

  /** 同步取绑定技能的目录层元数据 */
  private syncBoundSkills(uid: string, binding: AgentBinding): SkillMeta[] {
    const like = this.deps.skills as unknown as { listSync(uid: string, ids: string[]): SkillMeta[] };
    return like.listSync(uid, binding.skills);
  }

  private async assemble(uid: string, sessionKey: string, conversationId: string, metaOf: () => ConversationMeta): Promise<Agent> {
    const { env, now } = this.deps;
    // 模型绑定三级链：会话绑定 → 伙伴默认 → 全局激活；providerId 同时交给
    // adapterFactory（每回合现读该供应商行，改 Key 即时生效）
    const agentProviderId = metaOf().agentId ? this.syncCurrentAgent(uid, metaOf()).identity?.modelProviderId : undefined;
    const providerId = metaOf().modelProviderId ?? agentProviderId ?? null;
    const config = await this.deps.modelConfigFor(uid, providerId);
    if (!config) throw new ModelNotConfiguredError();
    const sessionLog = await this.deps.sessionLog(sessionKey);
    const ledger = await this.deps.ledgerFor(uid);

    // 装配期快照绑定（工具集）；systemPrompt 每步重读（人设/记忆/目录热更）
    const meta = metaOf();
    let binding: AgentBinding = { skills: [], mcps: [] };
    if (meta.agentId) {
      const agents = await this.deps.agents.list(uid);
      binding = agents.find((a) => a.id === meta.agentId)?.binding ?? binding;
    }

    const ledgerTools = createLedgerTools({
      ledger,
      now,
      actor: () => {
        const agentNow = this.syncCurrentAgent(uid, metaOf());
        return { conversationId, agentName: agentNow.name };
      },
    }).filter((tool) => !binding.tools || binding.tools.length === 0 || binding.tools.includes(tool.name));

    const tools: ToolDefinition[] = [...ledgerTools];
    if (binding.skills.length > 0) {
      tools.push(createLoadSkillTool({ store: this.deps.skills as unknown as import("./skills").SkillStore, uid }));
    }
    tools.push(createSavePreferenceTool({ store: this.deps.memory as unknown as import("./memory").MemoryStore, uid, now }));
    if (this.deps.tasks) {
      tools.push(...createTaskTools({ store: this.deps.tasks as unknown as import("./tasks").TaskStore, uid, now }));
    }
    for (const mcpId of binding.mcps) {
      tools.push(...(await this.deps.mcps.toolsFor(uid, mcpId)));
    }

    return createAgent({
      env,
      sessionLog,
      adapter: this.deps.adapterFactory(uid, providerId, config),
      model: {
        provider: "byok",
        model: config.model,
        // 上下文窗口喂给压缩器判压（0.8 阈值）；缺省 = harness 默认 64K
        ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      },
      systemPrompt: () => this.composePromptWithMeta(uid, metaOf()),
      tools,
      maxStepsPerTurn: 24,
    });
  }

  private composePromptWithMeta(uid: string, meta: ConversationMeta): string {
    const current = this.syncCurrentAgent(uid, meta);
    const memoryBlock = (this.deps.memory as unknown as { injectionBlockSync(uid: string): string }).injectionBlockSync(uid);
    const catalog = skillCatalogPrompt(this.syncBoundSkills(uid, current.binding));
    const merged = [memoryBlock, catalog].filter((block) => block !== "").join("\n\n");
    return composeAssistantPrompt({
      persona: current.persona,
      ...(current.identity ? { identity: { name: current.name, description: current.identity.description, language: current.identity.language } } : {}),
      ...(merged !== "" ? { memoryBlock: merged } : {}),
      now: this.deps.now,
      tzOffsetMinutes: this.deps.tzOffsetMinutes?.() ?? -new Date().getTimezoneOffset(),
    });
  }

  async send(uid: string, cid: string, text: string): Promise<void> {
    const agent = await this.agent(uid, cid);
    agent.followup(text);
  }

  /** 凝练原料：该用户全部会话的 user/assistant 文本（SQL 取代逐文件全扫） */
  collectSessionTexts(uid: string): { text: string; role: string }[] {
    const rows = this.db
      .prepare(
        "SELECT ce.event_json FROM conversation_events ce JOIN conversations c ON c.cid = ce.cid WHERE c.uid = ? AND ce.type IN ('user/message','assistant/message') ORDER BY ce.id",
      )
      .all(uid) as unknown as { event_json: string }[];
    const texts: { text: string; role: string }[] = [];
    for (const row of rows) {
      try {
        const event = JSON.parse(row.event_json) as { type: string; message?: { role: string; content: { type: string; text?: string }[] } };
        const text = (event.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
        if (text.trim() !== "") texts.push({ text, role: event.message?.role ?? "user" });
      } catch {
        // 坏行
      }
    }
    return texts;
  }
}
