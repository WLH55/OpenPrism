// 会话池：一个会话 = 一个 Agent 实例（ADR 0008 领域表）。
// conversations 表记 title + 当前伙伴 agentId + 切换史；conversation_events 表存九事件；
// systemPrompt 每步同步重读（人设/记忆/技能目录改动下一步生效，D4.2/4.1）；
// 能力绑定（工具开关 + 技能 + MCP）在装配时生效；save_preference 恒可用（记忆全局唯一，D5）。

import type { Agent, ContentBlock, LlmAdapter, PlatformEnv, SessionEvent, SessionLog, ToolDefinition, UserMessage } from "../harness/index";
import { createAgent, flattenText, hasImageBlocks } from "../harness/index";
import type { DatabaseSync } from "node:sqlite";
import type { Ledger } from "./ledger";
import { AgentStore, type AgentBinding } from "./agents";
import { createLedgerTools } from "./tools";
import { composeAssistantPrompt } from "./persona";
import { createLoadSkillTool, skillCatalogPrompt, type SkillMeta } from "./skills";
import { createSavePreferenceTool, createSearchMemoryTool, type MemoryVectorHit } from "./memory";
import { createTaskTools, TASK_FEED_CID_PREFIX } from "./tasks";
import type { McpRegistry } from "./mcp";
import type { ModelConfig } from "./secretbox";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("model not configured（先在设置页配置 baseURL / API Key / 模型）");
    this.name = "ModelNotConfiguredError";
  }
}

/** 图片发给了不支持图片识别的模型（多模态开关未勾选）：发送拦截、切换拦截、装配拦截共用 */
export class ModelNotMultimodalError extends Error {
  constructor(detail = "当前模型不支持图片识别") {
    super(`${detail}——在「模型接入」里勾选该模型的「支持图片识别（多模态）」，或换一个支持图片的模型`);
    this.name = "ModelNotMultimodalError";
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
  /** 向量召回预查（2026-09-18）；缺省/返回 null = 语义召回不可用，注入退纯词法 */
  memoryVector?: MemoryVectorLike;
  /** 定时任务工具（create_task，D6.4 双入口之二）；缺省不装配 */
  tasks?: TaskStoreLike;
  /** 一轮对话完成（agent.whenIdle 后）的回调——记忆提取去抖登记用；缺省不触发 */
  onTurnDone?(uid: string): void;
}

export interface TaskStoreLike {
  create(uid: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface MemoryStoreLike {
  /** 条目化召回注入块（纯函数：输入=库内条目+query+向量命中） */
  recallBlockSync(uid: string, query?: string, vectorHits?: MemoryVectorHit[]): string;
}

/** 向量召回面（main 装配 memory-vector 服务；测试注入确定性实现） */
export interface MemoryVectorLike {
  /** null = 语义召回不可用（未配置/超时/失败），调用方退纯词法 */
  recallHits(uid: string, query: string, options?: { scope?: "situational" | "all"; limit?: number }): Promise<MemoryVectorHit[] | null>;
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

export interface ConversationEntry {
  id: string;
  title: string;
  pinned: boolean;
  createdTs: number;
}

const DEFAULT_TITLE = "新对话";
const TITLE_MAX_RUNES = 24;

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
  switches: { ts: number; agentId: string | null }[];
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
  /** 本回合注入用的向量命中（send() 预查写入，systemPrompt 闭包同步读；key = uid:cid） */
  private turnVectorHits = new Map<string, MemoryVectorHit[]>();

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
    const cid = `${TASK_FEED_CID_PREFIX}${agentId ?? "default"}`;
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

  /** 会话归属（2026-09-23 越权修复）：conversation_events 不带 uid，归属在 conversations 表；查无此行 = undefined */
  ownerOf(cid: string): string | undefined {
    const row = this.db.prepare("SELECT uid FROM conversations WHERE cid = ?").get(cid) as unknown as { uid: string } | undefined;
    return row?.uid;
  }

  /**
   * 读会话事件（2026-09-23 分段加载）：不带参数 = 全量升序（桌面端与既有行为一致）；
   * limit = 取最近 limit 条；before 与 limit 连用 = 取 seq < before 的最近 limit 条（向上翻页游标）。片段一律升序返回。
   */
  readEvents(cid: string, options?: { before?: number; limit?: number }): SessionEvent[] {
    const parse = (rows: { event_json: string }[]) => rows.map((row) => JSON.parse(row.event_json) as SessionEvent);
    if (options === undefined || (options.before === undefined && options.limit === undefined)) {
      const rows = this.db.prepare("SELECT event_json FROM conversation_events WHERE cid = ? ORDER BY seq").all(cid) as unknown as { event_json: string }[];
      return parse(rows);
    }
    const cap = options.limit ?? 50;
    const rows = (
      options.before === undefined
        ? this.db.prepare("SELECT event_json FROM conversation_events WHERE cid = ? ORDER BY seq DESC LIMIT ?").all(cid, cap)
        : this.db.prepare("SELECT event_json FROM conversation_events WHERE cid = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(cid, options.before, cap)
    ) as unknown as { event_json: string }[];
    return parse(rows.reverse());
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

  /** 切换伙伴（D4.2）：只换 system prompt 与装配，历史不丢；切换历史供 UI 画分割线。
   * agentId = null 切回默认助手（2026-09-28 微信桥增补：会话唯一固定的场景不能靠新建绕过）。 */
  async switchAgent(uid: string, cid: string, agentId: string | null): Promise<void> {
    const agents = await this.deps.agents.list(uid);
    const target = agentId !== null ? agents.find((a) => a.id === agentId) : undefined;
    if (agentId !== null && !target) throw new Error(`agent "${agentId}" 不存在`);
    // 会话没绑模型时，伙伴默认模型决定实际模型：历史里有图而目标模型不支持图片 → 拦住切换
    // （目标 = 默认助手时按全局激活模型判）
    const meta = await this.metaFor(uid, cid);
    if (meta.modelProviderId === undefined && this.conversationHasImages(cid)) {
      const effective = target?.identity.modelProviderId ?? null;
      const config = await this.deps.modelConfigFor(uid, effective);
      if (config && !config.multimodal) {
        throw new ModelNotMultimodalError(`${target?.name ?? "默认助手"} 的默认模型不支持图片识别，这个会话里有图片`);
      }
    }
    meta.agentId = agentId ?? undefined;
    meta.switches.push({ ts: this.deps.now(), agentId });
    this.db
      .prepare("UPDATE conversations SET agent_id = ?, switches_json = ? WHERE cid = ? AND uid = ?")
      .run(agentId, JSON.stringify(meta.switches), cid, uid);
  }

  /** 会话绑定模型（2026-09-07）：null = 跟随全局激活；切换即弃池，下一回合按新模型重新装配（日志全量在库，装配无损） */
  async switchModel(uid: string, cid: string, providerId: string | null): Promise<void> {
    const exists = this.db.prepare("SELECT 1 AS ok FROM conversations WHERE cid = ? AND uid = ?").get(cid, uid);
    if (!exists) throw new Error(`conversation "${cid}" 不存在`);
    // 历史里有图片时，切到不支持图片识别的模型会在此后的每回合失败：就地拦住并说明
    if (this.conversationHasImages(cid)) {
      const config = await this.deps.modelConfigFor(uid, providerId);
      if (config && !config.multimodal) {
        throw new ModelNotMultimodalError("这个会话里有图片，切过去的模型不支持图片识别");
      }
    }
    this.db.prepare("UPDATE conversations SET model_provider_id = ? WHERE cid = ? AND uid = ?").run(providerId, cid, uid);
    this.pool.delete(`${uid}:${cid}`);
  }

  /** 会话历史里是否出现过图片（切模型/切伙伴的前置检查；SQL 先粗筛再逐条确认） */
  private conversationHasImages(cid: string): boolean {
    const rows = this.db
      .prepare("SELECT event_json FROM conversation_events WHERE cid = ? AND type = 'user/message' AND event_json LIKE '%\"image\"%'")
      .all(cid) as unknown as { event_json: string }[];
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as { message?: UserMessage };
      if (Array.isArray(event.message?.content) && hasImageBlocks(event.message)) return true;
    }
    return false;
  }

  /** 弃池某伙伴绑定的全部会话（改伙伴默认模型后热更用：下一回合按新模型重装配） */
  evictAgentConversations(uid: string, agentId: string): void {
    const rows = this.db.prepare("SELECT cid FROM conversations WHERE uid = ? AND agent_id = ?").all(uid, agentId) as unknown as { cid: string }[];
    for (const row of rows) this.pool.delete(`${uid}:${row.cid}`);
  }

  /**
   * 弃池有效模型解析为该提供方的全部会话（改提供方设置——窗口/多模态开关——后下一回合重装配）。
   * 有效模型三级链与会话装配一致：会话绑定 → 伙伴默认 → 全局激活。
   */
  evictProviderConversations(uid: string, providerId: string): void {
    const rows = this.db
      .prepare("SELECT cid, agent_id, model_provider_id FROM conversations WHERE uid = ?")
      .all(uid) as unknown as { cid: string; agent_id: string | null; model_provider_id: string | null }[];
    const agentRows = this.db.prepare("SELECT id, model_provider_id FROM agents WHERE uid = ?").all(uid) as unknown as {
      id: string;
      model_provider_id: string | null;
    }[];
    const agentProvider = new Map(agentRows.map((row) => [row.id, row.model_provider_id]));
    const global = this.db.prepare("SELECT provider_id FROM model_active WHERE uid = ?").get(uid) as
      | { provider_id: string }
      | undefined;
    for (const row of rows) {
      const effective = row.model_provider_id ?? (row.agent_id ? (agentProvider.get(row.agent_id) ?? null) : null) ?? global?.provider_id ?? null;
      if (effective === providerId) this.pool.delete(`${uid}:${row.cid}`);
    }
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
      const event = JSON.parse(eventRows[0]!.event_json) as { message?: UserMessage };
      userText = event.message ? flattenText(event.message) : "";
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

  /** 模型绑定三级链：会话绑定 → 伙伴默认 → 全局激活（null = 跟随全局） */
  private effectiveProviderId(uid: string, meta: ConversationMeta): string | null {
    const agentProviderId = meta.agentId ? this.syncCurrentAgent(uid, meta).identity?.modelProviderId : undefined;
    return meta.modelProviderId ?? agentProviderId ?? null;
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
    const providerId = this.effectiveProviderId(uid, metaOf());
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
    const memoryStore = this.deps.memory as unknown as import("./memory").MemoryStore;
    tools.push(createSavePreferenceTool({ store: memoryStore, uid, now }));
    tools.push(
      createSearchMemoryTool({
        store: memoryStore,
        uid,
        ...(this.deps.memoryVector
          ? { vectorRecall: (vectorUid: string, query: string) => this.deps.memoryVector!.recallHits(vectorUid, query, { scope: "all", limit: 20 }) }
          : {}),
      }),
    );
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
      systemPrompt: () => this.composePromptWithMeta(uid, conversationId, metaOf()),
      // 兜底拦截：装配期这个模型不支持图片，而请求里带了图片（历史消息/切换伙伴默认模型后的重放）→
      // 就地失败并说明原因，不把图片发给不认识的端点去猜
      onRequest: (request) => {
        if (!config.multimodal && request.messages.some((message) => hasImageBlocks(message))) {
          throw new ModelNotMultimodalError();
        }
        return request;
      },
      tools,
      maxStepsPerTurn: 24,
    });
  }

  /** 情境召回的 query = 会话最近一条用户消息（首轮空 → 仅常驻块）；同步读（systemPrompt 闭包是同步的） */
  private lastUserTextSync(cid: string): string {
    const row = this.db
      .prepare("SELECT event_json FROM conversation_events WHERE cid = ? AND type = 'user/message' ORDER BY seq DESC LIMIT 1")
      .get(cid) as { event_json: string } | undefined;
    if (!row) return "";
    try {
      const event = JSON.parse(row.event_json) as { message?: UserMessage };
      return (event.message ? flattenText(event.message) : "").slice(0, 500);
    } catch {
      return "";
    }
  }

  private composePromptWithMeta(uid: string, cid: string, meta: ConversationMeta): string {
    const current = this.syncCurrentAgent(uid, meta);
    const vectorHits = this.turnVectorHits.get(`${uid}:${cid}`);
    const memoryBlock = (this.deps.memory as unknown as { recallBlockSync(uid: string, query?: string, vectorHits?: MemoryVectorHit[]): string }).recallBlockSync(
      uid,
      this.lastUserTextSync(cid),
      vectorHits,
    );
    const catalog = skillCatalogPrompt(this.syncBoundSkills(uid, current.binding));
    const merged = [memoryBlock, catalog].filter((block) => block !== "").join("\n\n");
    return composeAssistantPrompt({
      persona: current.persona,
      ...(current.identity ? { identity: { name: current.name, description: current.identity.description, language: current.identity.language } } : {}),
      ...(merged !== "" ? { memoryBlock: merged } : {}),
      taskFeed: cid.startsWith(TASK_FEED_CID_PREFIX),
      now: this.deps.now,
      tzOffsetMinutes: this.deps.tzOffsetMinutes?.() ?? -new Date().getTimezoneOffset(),
    });
  }

  /**
   * 发送一条用户消息（文本 + 附件块）：附件里的图片要求当前有效模型是多模态，否则就地拒绝（不消耗回合）。
   * 归属校验（2026-09-27 越权补齐）：会话不属于该用户时按不存在拒绝，一个字节都不写。
   * 向量预查（2026-09-18）：systemPrompt 闭包是同步的，语义命中必须在回合开始前算好；
   * query = 本回合用户消息（此刻尚未落库，lastUserTextSync 读到的还是上一条）。
   */
  async send(uid: string, cid: string, text: string, attachments: ContentBlock[] = []): Promise<void> {
    if (this.ownerOf(cid) !== uid) throw new Error(`conversation "${cid}" 不存在`);
    if (attachments.some((block) => block.type === "image")) {
      const config = await this.deps.modelConfigFor(uid, this.effectiveProviderId(uid, this.dbMetaSync(uid, cid)));
      if (!config) throw new ModelNotConfiguredError();
      if (!config.multimodal) throw new ModelNotMultimodalError();
    }
    const agent = await this.agent(uid, cid);
    const content: ContentBlock[] = [...(text !== "" ? [{ type: "text" as const, text }] : []), ...attachments];
    const query = flattenText({ role: "user", content });
    // null（未配置/超时/失败/纯图片消息）→ 清掉旧命中，本回合退纯词法
    const hits =
      this.deps.memoryVector && query.trim() !== ""
        ? await this.deps.memoryVector.recallHits(uid, query, { scope: "situational" })
        : null;
    if (hits === null) this.turnVectorHits.delete(`${uid}:${cid}`);
    else this.turnVectorHits.set(`${uid}:${cid}`, hits);
    agent.followup(content);
    // 记忆提取去抖登记（立即发、90s 后才跑——给回合收尾留时间；未落盘的消息由水位线 diff 下轮兜底）
    this.deps.onTurnDone?.(uid);
  }

  /**
   * 手动中止当前回合（2026-09-27 打断）：harness abort 语义——停止模型调用与工具执行，
   * 已收到的部分输出以 interrupted 消息落日志，回合以 aborted 收尾；Inbox 一并清空
   * （前端等待队列在客户端，服务端 Inbox 不承载用户排队语义）。
   */
  async stop(uid: string, cid: string): Promise<void> {
    if (this.ownerOf(cid) !== uid) throw new Error(`conversation "${cid}" 不存在`);
    const agent = await this.agent(uid, cid);
    agent.cancel();
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
        const event = JSON.parse(row.event_json) as { message?: UserMessage };
        const text = event.message ? flattenText(event.message) : "";
        if (text.trim() !== "") texts.push({ text, role: event.message?.role ?? "user" });
      } catch {
        // 坏行
      }
    }
    return texts;
  }
}
