// 智能体三段配置之「身份/灵魂 + 能力绑定」（D4/4.1，ADR 0008 领域表）：
// agents 表 = 身份（名字/描述/形象 emoji+色盘+头像/回复语言/默认模型）+ persona_md（= 灵魂 SOUL）+ bindings_json（工具开关 + 技能/MCP 绑定）。
// 2026-09-07 五步向导改版（对齐 DeepTutor）：身份字段入库，名字显式优先（H1 推导仅作创建兜底）。
// snapshotSync 供 conversations 的 systemPrompt 每步同步取用（node:sqlite 同步 API，语义不破）。

import type { DatabaseSync } from "node:sqlite";
import { extractAgentName } from "./persona";
import { validateFace } from "./avatar";

/** 伙伴身份（向导第①步 + 心智的默认模型） */
export interface AgentIdentity {
  description: string;
  emoji: string;
  color: string;
  avatar?: string; // data:image/* data URL
  language: string; // ''=自动跟随 | 'zh' | 'en'
  modelProviderId?: string; // 伙伴默认模型；缺省 = 跟随会话/全局
}

const LANGUAGES = ["", "zh", "en"];

/** 身份字段校验（store 层守门，路由与测试共用）；非法即抛错 */
export function validateIdentityPatch(patch: Partial<AgentIdentity & { name?: string }>): void {
  if (patch.name !== undefined && String(patch.name).length > 64) throw new Error("name 超过 64 字上限");
  if (patch.description !== undefined && String(patch.description).length > 500) throw new Error("description 超过 500 字上限");
  if (patch.name !== undefined && String(patch.name).trim() === "") throw new Error("name 不能为空");
  if (patch.language !== undefined && !LANGUAGES.includes(patch.language)) throw new Error("language 只能是 '' | zh | en");
  validateFace(patch);
}

export interface AgentEntry {
  id: string;
  name: string;
  createdTs: number;
}

export interface AgentBinding {
  /** 启用的内置工具名（缺省/空 = 全部四工具） */
  tools?: string[];
  skills: string[];
  mcps: string[];
}

export interface AgentStoreDeps {
  db: DatabaseSync;
  now(): number;
  randomUUID(): string;
}

interface AgentRow {
  id: string;
  name: string;
  persona_md: string;
  bindings_json: string;
  description: string;
  emoji: string;
  color: string;
  avatar: string | null;
  language: string;
  model_provider_id: string | null;
  created_ts: number;
}

const DEFAULT_BINDING: AgentBinding = { skills: [], mcps: [] };

function toIdentity(row: AgentRow): AgentIdentity {
  return {
    description: row.description ?? "",
    emoji: row.emoji ?? "",
    color: row.color ?? "",
    ...(row.avatar ? { avatar: row.avatar } : {}),
    language: row.language ?? "",
    ...(row.model_provider_id ? { modelProviderId: row.model_provider_id } : {}),
  };
}

const IDENTITY_COLS = "id, uid, name, persona_md, bindings_json, description, emoji, color, avatar, language, model_provider_id, created_ts";

export class AgentStore {
  constructor(private deps: AgentStoreDeps) {}

  private getRow(uid: string, aid: string): AgentRow | undefined {
    return this.deps.db
      .prepare(`SELECT ${IDENTITY_COLS} FROM agents WHERE id = ? AND uid = ?`)
      .get(aid, uid) as unknown as AgentRow | undefined;
  }

  private static toBinding(json: string): AgentBinding {
    try {
      const parsed = JSON.parse(json) as AgentBinding;
      if (Array.isArray(parsed?.skills) && Array.isArray(parsed?.mcps)) return parsed;
    } catch {
      // 坏行防御
    }
    return DEFAULT_BINDING;
  }

  async list(uid: string): Promise<(AgentEntry & { identity: AgentIdentity; binding: AgentBinding })[]> {
    const rows = this.deps.db
      .prepare(`SELECT ${IDENTITY_COLS} FROM agents WHERE uid = ? ORDER BY created_ts, id`)
      .all(uid) as unknown as AgentRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdTs: row.created_ts,
      identity: toIdentity(row),
      binding: AgentStore.toBinding(row.bindings_json),
    }));
  }

  async create(
    uid: string,
    input: { name?: string; persona: string; identity?: Partial<AgentIdentity>; binding?: AgentBinding },
  ): Promise<AgentEntry> {
    validateIdentityPatch(input.identity ?? {});
    const id = this.deps.randomUUID();
    // 名字显式优先；H1 推导只作兜底（向导一定显式给名）
    const name = input.name?.trim() || extractAgentName(input.persona) || "助手";
    const createdTs = this.deps.now();
    const identity = input.identity ?? {};
    this.deps.db
      .prepare(
        `INSERT INTO agents (id, uid, name, persona_md, bindings_json, description, emoji, color, avatar, language, model_provider_id, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        uid,
        name,
        input.persona,
        JSON.stringify(input.binding ?? DEFAULT_BINDING),
        identity.description ?? "",
        identity.emoji ?? "",
        identity.color ?? "",
        identity.avatar ?? null,
        identity.language ?? "",
        identity.modelProviderId ?? null,
        createdTs,
      );
    return { id, name, createdTs };
  }

  async persona(uid: string, aid: string): Promise<string> {
    const row = this.getRow(uid, aid);
    if (!row) throw new Error(`agent "${aid}" 不存在`);
    return row.persona_md;
  }

  /** 同步快照（systemPrompt 每步重取：身份/灵魂/绑定热更，D4.2）；agent 不存在 = null（退默认身份） */
  snapshotSync(uid: string, aid: string): { name: string; persona: string; identity: AgentIdentity; binding: AgentBinding } | null {
    const row = this.getRow(uid, aid);
    if (!row) return null;
    return { name: row.name || "助手", persona: row.persona_md, identity: toIdentity(row), binding: AgentStore.toBinding(row.bindings_json) };
  }

  /** 灵魂编辑：名字不再随 H1 重推导（向导起的名字是显式资产；改名走 updateIdentity） */
  async updatePersona(uid: string, aid: string, markdown: string): Promise<AgentEntry> {
    const row = this.getRow(uid, aid);
    if (!row) throw new Error(`agent "${aid}" 不存在`);
    this.deps.db.prepare("UPDATE agents SET persona_md = ? WHERE id = ? AND uid = ?").run(markdown, aid, uid);
    return { id: aid, name: row.name, createdTs: row.created_ts };
  }

  /** 身份补丁（向导/配置页共用）：字段级校验后落库；undefined 字段不动 */
  async updateIdentity(uid: string, aid: string, patch: Partial<AgentIdentity & { name?: string }>): Promise<AgentEntry> {
    const row = this.getRow(uid, aid);
    if (!row) throw new Error(`agent "${aid}" 不存在`);
    validateIdentityPatch(patch);
    const next = {
      name: patch.name !== undefined ? String(patch.name).trim() : row.name,
      description: patch.description ?? row.description,
      emoji: patch.emoji ?? row.emoji,
      color: patch.color ?? row.color,
      avatar: patch.avatar ?? row.avatar,
      language: patch.language ?? row.language,
      modelProviderId: patch.modelProviderId === undefined ? row.model_provider_id : patch.modelProviderId === "" ? null : patch.modelProviderId,
    };
    this.deps.db
      .prepare(
        "UPDATE agents SET name = ?, description = ?, emoji = ?, color = ?, avatar = ?, language = ?, model_provider_id = ? WHERE id = ? AND uid = ?",
      )
      .run(next.name, next.description, next.emoji, next.color, next.avatar, next.language, next.modelProviderId, aid, uid);
    return { id: aid, name: next.name, createdTs: row.created_ts };
  }

  async updateBinding(uid: string, aid: string, binding: AgentBinding): Promise<void> {
    const row = this.getRow(uid, aid);
    if (!row) throw new Error(`agent "${aid}" 不存在`);
    this.deps.db.prepare("UPDATE agents SET bindings_json = ? WHERE id = ? AND uid = ?").run(JSON.stringify(binding), aid, uid);
  }

  async remove(uid: string, aid: string): Promise<void> {
    const result = this.deps.db.prepare("DELETE FROM agents WHERE id = ? AND uid = ?").run(aid, uid);
    if (result.changes === 0) throw new Error(`agent "${aid}" 不存在`);
  }
}
