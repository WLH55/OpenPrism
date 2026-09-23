// 技能（D4b.1/4b.2，ADR 0008 领域表）：skills 表 = 目录层（name/description/when_to_use）+ body_md 正文。
// 渐进式加载：目录层常驻 system prompt；正文层经 load_skill 工具按需载入——载入 = 工具事件落会话日志，
// "模型可见即日志可重建"天然满足。

import type { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "../harness/index";

const DESCRIPTION_LIMIT = 1024;

export interface ParsedSkill {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
}

/** frontmatter 只解析平面 `key: value`（零依赖；标准技能的 name/description/when_to_use 都是平面键） */
export function parseSkillFile(content: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error("SKILL.md 需要 YAML frontmatter（--- 包裹的头部）");
  const front: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) front[kv[1]!] = kv[2]!.trim();
  }
  if (!front.name) throw new Error("frontmatter 缺 name");
  if (!front.description) throw new Error("frontmatter 缺 description");
  if (front.description.length > DESCRIPTION_LIMIT) {
    throw new Error(`description ${front.description.length} 字符超过 ${DESCRIPTION_LIMIT} 上限，装不进目录层`);
  }
  return {
    name: front.name,
    description: front.description,
    ...(front.when_to_use !== undefined ? { whenToUse: front.when_to_use } : {}),
    body: match[2] ?? "",
  };
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
}

export interface SkillStoreDeps {
  db: DatabaseSync;
  now(): number;
  randomUUID(): string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  when_to_use: string | null;
}

function rowToMeta(row: SkillRow): SkillMeta {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ...(row.when_to_use !== null ? { whenToUse: row.when_to_use } : {}),
  };
}

export class SkillStore {
  constructor(private deps: SkillStoreDeps) {}

  async list(uid: string): Promise<SkillMeta[]> {
    const rows = this.deps.db
      .prepare("SELECT id, name, description, when_to_use FROM skills WHERE uid = ? ORDER BY created_ts, id")
      .all(uid) as unknown as SkillRow[];
    return rows.map(rowToMeta);
  }

  /** 同步取绑定技能的目录层（systemPrompt 每步重取；ids 为空数组返回空） */
  listSync(uid: string, ids: string[]): SkillMeta[] {
    if (ids.length === 0) return [];
    const all = this.deps.db
      .prepare("SELECT id, name, description, when_to_use FROM skills WHERE uid = ? ORDER BY created_ts, id")
      .all(uid) as unknown as SkillRow[];
    return all.map(rowToMeta).filter((meta) => ids.includes(meta.id));
  }

  async create(uid: string, content: string): Promise<SkillMeta> {
    const parsed = parseSkillFile(content);
    const meta: SkillMeta = {
      id: this.deps.randomUUID(),
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    };
    this.deps.db
      .prepare("INSERT INTO skills (id, uid, name, description, when_to_use, body_md, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(meta.id, uid, meta.name, meta.description, parsed.whenToUse ?? null, content, this.deps.now());
    return meta;
  }

  async body(uid: string, sid: string): Promise<string> {
    const row = this.deps.db.prepare("SELECT body_md FROM skills WHERE id = ? AND uid = ?").get(sid, uid) as
      | { body_md: string }
      | undefined;
    if (!row) throw new Error(`skill "${sid}" 不存在`);
    return row.body_md;
  }

  async remove(uid: string, sid: string): Promise<void> {
    const result = this.deps.db.prepare("DELETE FROM skills WHERE id = ? AND uid = ?").run(sid, uid);
    if (result.changes === 0) throw new Error(`skill "${sid}" 不存在`);
  }
}

/** 目录层文本（常驻 system prompt）：只含触发信息，不含正文 */
export function skillCatalogPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (s) => `- ${s.name}：${s.description}${s.whenToUse ? `（何时用：${s.whenToUse}）` : ""}`,
  );
  return `已安装技能（需要其完整内容时调用 load_skill 工具按 name 载入）：\n${lines.join("\n")}`;
}

export function createLoadSkillTool(deps: { store: SkillStore; uid: string }): ToolDefinition {
  return {
    name: "load_skill",
    description: "载入某个已安装技能的完整内容（目录只给了摘要，正文用这个工具拿）。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "技能名（目录层里的 name）" } },
    },
    output: {
      schema: {
        type: "object",
        required: ["body"],
        properties: { body: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: ((value as { body: string }).body ?? "").slice(0, 500) }],
    },
    async execute(args) {
      const name = String((args as { name?: string })?.name ?? "");
      const metas = await deps.store.list(deps.uid);
      const hit = metas.find((m) => m.name === name);
      if (!hit) throw new Error(`技能 "${name}" 未安装`);
      return { body: await deps.store.body(deps.uid, hit.id) };
    },
    isConcurrencySafe: () => false,
  };
}
