// 技能（D4b.1/4b.2）：标准 Agent Skill（目录 + SKILL.md），自带自装（批次 2 = 粘贴单文件内容；git URL 导入留后）。
// 渐进式加载：目录层（name + description + when_to_use，description ≤1024 字符硬约束）常驻 system prompt；
// 正文层经 load_skill 工具按需载入——载入 = 工具事件落 Session Log，"模型可见即日志可重建"天然满足。

import { join } from "node:path";
import type { FileIO, ToolDefinition } from "../harness/index";
import type { AppPaths } from "./store";

const DESCRIPTION_LIMIT = 1024;

/** 技能索引的规范路径（conversations 的 systemPrompt 每步同步重取用） */
export function skillIndexFile(pathsLike: { userDir(uid: string): string }, uid: string): string {
  return join(pathsLike.userDir(uid), "skills", "index.jsonl");
}

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
  fileIO: FileIO;
  paths: AppPaths;
  now(): number;
  randomUUID(): string;
}

export class SkillStore {
  constructor(private deps: SkillStoreDeps) {}

  private indexFile(uid: string): string {
    return join(this.deps.paths.userDir(uid), "skills", "index.jsonl");
  }
  private skillFile(uid: string, sid: string): string {
    return join(this.deps.paths.userDir(uid), "skills", sid, "SKILL.md");
  }

  private async loadIndex(uid: string): Promise<SkillMeta[]> {
    const metas: SkillMeta[] = [];
    for (const line of await this.deps.fileIO.readAll(this.indexFile(uid))) {
      try {
        const meta = JSON.parse(line) as SkillMeta;
        if (typeof meta?.id === "string") metas.push(meta);
      } catch {
        // 崩溃半行
      }
    }
    return metas;
  }

  async list(uid: string): Promise<SkillMeta[]> {
    return this.loadIndex(uid);
  }

  async create(uid: string, content: string): Promise<SkillMeta> {
    const parsed = parseSkillFile(content);
    const meta: SkillMeta = {
      id: this.deps.randomUUID(),
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    };
    await this.deps.fileIO.appendLine(this.indexFile(uid), JSON.stringify(meta));
    // 正文原样落盘（不走 JSONL 语义）
    const { mkdir, writeFile } = await import("node:fs/promises");
    const file = this.skillFile(uid, meta.id);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
    return meta;
  }

  async body(uid: string, sid: string): Promise<string> {
    // markdown 正文含空行，须原样读（FileIO.readAll 的 JSONL 语义会滤掉空行）
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(this.skillFile(uid, sid), "utf8");
    } catch {
      throw new Error(`skill "${sid}" 不存在`);
    }
  }

  async remove(uid: string, sid: string): Promise<void> {
    const metas = await this.loadIndex(uid);
    if (!metas.some((m) => m.id === sid)) throw new Error(`skill "${sid}" 不存在`);
    const kept = metas.filter((m) => m.id !== sid);
    const { writeFile, rm } = await import("node:fs/promises");
    const index = this.indexFile(uid);
    await writeFile(index, kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    const dir = join(this.deps.paths.userDir(uid), "skills", sid);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
