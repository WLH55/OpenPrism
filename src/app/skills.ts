// 技能（D4b.1/4b.2，ADR 0008 领域表）：skills 表 = 目录层（name/description/when_to_use）+ body_md 正文。
// 渐进式加载：目录层常驻 system prompt；正文层经 load_skill 工具按需载入——载入 = 工具事件落会话日志，
// "模型可见即日志可重建"天然满足。

import type { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "../harness/index";
import { parseSkillFile } from "./skillpkg";
import type { SkillFilesIO } from "./skillpkg";

// SKILL.md 解析与身份校验统一在 skillpkg（四类来源安装与粘贴安装同口径）；SkillFilesIO 同源
export { parseSkillFile, type ParsedSkill, type SkillFilesIO } from "./skillpkg";

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** 安装态（2026-10-21 Docker 沙箱化）；粘贴安装的存量行恒为 ready */
  status?: "ready" | "installing" | "failed";
  enabled?: boolean;
  version?: string;
  /** 技能镜像 tag；空 = 纯提示词技能（无脚本执行面） */
  imageTag?: string;
  pkgSha?: string;
  installError?: string;
}

/** 目录层/工具面统一可见性裁决：ready 且启用（缺省字段按 ready/启用处理，粘贴安装兼容） */
export function skillVisible(meta: SkillMeta): boolean {
  return (meta.status ?? "ready") === "ready" && (meta.enabled ?? true);
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
  status: string;
  version: string | null;
  enabled: number;
  image_tag: string | null;
  pkg_sha: string | null;
  install_error: string | null;
}

const SKILL_COLUMNS = "id, name, description, when_to_use, status, version, enabled, image_tag, pkg_sha, install_error";

function rowToMeta(row: SkillRow): SkillMeta {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ...(row.when_to_use !== null ? { whenToUse: row.when_to_use } : {}),
    status: row.status as "ready" | "installing" | "failed",
    enabled: row.enabled === 1,
    ...(row.version !== null ? { version: row.version } : {}),
    ...(row.image_tag !== null ? { imageTag: row.image_tag } : {}),
    ...(row.pkg_sha !== null ? { pkgSha: row.pkg_sha } : {}),
    ...(row.install_error !== null && row.install_error !== "" ? { installError: row.install_error } : {}),
  };
}

export class SkillStore {
  constructor(private deps: SkillStoreDeps) {}

  async list(uid: string): Promise<SkillMeta[]> {
    const rows = this.deps.db
      .prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE uid = ? ORDER BY created_ts, id`)
      .all(uid) as unknown as SkillRow[];
    return rows.map(rowToMeta);
  }

  /** 同步取该用户全部 ready 且启用的技能（/技能名 点名裁决与目录层共用口径） */
  visibleSync(uid: string): SkillMeta[] {
    const rows = this.deps.db
      .prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE uid = ? AND status = 'ready' AND enabled = 1 ORDER BY created_ts, id`)
      .all(uid) as unknown as SkillRow[];
    return rows.map(rowToMeta);
  }

  /** 同步取绑定技能的目录层（systemPrompt 每步重取；只透出 ready 且启用的；ids 为空数组返回空） */
  listSync(uid: string, ids: string[]): SkillMeta[] {
    if (ids.length === 0) return [];
    return this.visibleSync(uid).filter((meta) => ids.includes(meta.id));
  }

  async create(uid: string, content: string): Promise<SkillMeta> {
    const parsed = parseSkillFile(content);
    const id = this.deps.randomUUID();
    this.deps.db
      .prepare(
        `INSERT INTO skills (id, uid, name, description, when_to_use, body_md, status, enabled, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', 1, ?)`,
      )
      .run(id, uid, parsed.name, parsed.description, parsed.whenToUse ?? null, content, this.deps.now());
    return { id, name: parsed.name, description: parsed.description, status: "ready", enabled: true, ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}) };
  }

  /**
   * 包安装路径建行（spec 2026-10-21）：status=installing，重装（同名）复用原 id——
   * 绑定关系与旧 image_tag 保留，安装成功才 markReady 切换，失败 markFailed 旧镜像继续服务。
   */
  async createFromPackage(
    uid: string,
    input: { name: string; description: string; whenToUse?: string; version?: string; pkgSha: string; bodyMd: string },
  ): Promise<SkillMeta> {
    const existing = (
      this.deps.db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE uid = ? AND name = ?`).get(uid, input.name) as unknown as
        | SkillRow
        | undefined
    );
    if (existing) {
      this.deps.db
        .prepare(
          `UPDATE skills SET description = ?, when_to_use = ?, version = ?, pkg_sha = ?, body_md = ?,
             status = 'installing', install_error = NULL WHERE id = ?`,
        )
        .run(input.description, input.whenToUse ?? null, input.version ?? null, input.pkgSha, input.bodyMd, existing.id);
      const row = this.deps.db
        .prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ?`)
        .get(existing.id) as unknown as SkillRow;
      return rowToMeta(row);
    }
    const id = this.deps.randomUUID();
    this.deps.db
      .prepare(
        `INSERT INTO skills (id, uid, name, description, when_to_use, body_md, status, enabled, pkg_sha, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'installing', 1, ?, ?)`,
      )
      .run(id, uid, input.name, input.description, input.whenToUse ?? null, input.bodyMd, input.pkgSha, this.deps.now());
    return rowToMeta(
      this.deps.db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ?`).get(id) as unknown as SkillRow,
    );
  }

  /** 安装验证通过：切 ready 并落镜像 tag（旧 tag 由安装器负责 rmi） */
  markReady(uid: string, sid: string, info: { imageTag: string; version?: string }): void {
    const result = this.deps.db
      .prepare("UPDATE skills SET status = 'ready', image_tag = ?, install_error = NULL WHERE id = ? AND uid = ?")
      .run(info.imageTag, sid, uid);
    if (result.changes === 0) throw new Error(`skill "${sid}" 不存在`);
    if (info.version !== undefined) {
      this.deps.db.prepare("UPDATE skills SET version = ? WHERE id = ?").run(info.version, sid);
    }
  }

  markFailed(uid: string, sid: string, error: string): void {
    const result = this.deps.db
      .prepare("UPDATE skills SET status = 'failed', install_error = ? WHERE id = ? AND uid = ?")
      .run(error, sid, uid);
    if (result.changes === 0) throw new Error(`skill "${sid}" 不存在`);
  }

  /** 服务启动时把 installing 行标失败（安装被重启中断）；返回受影响行数 */
  failInstallingAll(reason: string): number {
    const result = this.deps.db
      .prepare("UPDATE skills SET status = 'failed', install_error = ? WHERE status = 'installing'")
      .run(reason);
    return Number(result.changes);
  }

  /** 重试安装：行状态回 installing（image_tag 不动 = 旧镜像继续服务） */
  markInstalling(uid: string, sid: string): void {
    const result = this.deps.db
      .prepare("UPDATE skills SET status = 'installing', install_error = NULL WHERE id = ? AND uid = ?")
      .run(sid, uid);
    if (result.changes === 0) throw new Error(`skill "${sid}" 不存在`);
  }

  setEnabled(uid: string, sid: string, enabled: boolean): void {
    const result = this.deps.db
      .prepare("UPDATE skills SET enabled = ? WHERE id = ? AND uid = ?")
      .run(enabled ? 1 : 0, sid, uid);
    if (result.changes === 0) throw new Error(`skill "${sid}" 不存在`);
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
  return `已安装技能（需要其完整内容时调用 load_skill 工具按 name 载入，捆绑文件用 read_skill_file 读取）：\n${lines.join("\n")}`;
}

/** L3 路径安全：拒绝绝对路径 / 上跳 / 反斜杠 / NUL（与 read_file 的 skill:// 防护同口径）；
 *  read_skill_file 工具与 server /file 路由共用（验收 B1：两侧同校验） */
export function safeRelPath(path: string): string {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`文件路径不安全：${path}`);
  }
  if (path.split("/").includes("..")) throw new Error(`文件路径不安全：${path}`);
  return path;
}

export function createLoadSkillTool(deps: {
  store: SkillStore;
  uid: string;
  files: SkillFilesIO;
  /** 装配期伙伴绑定的技能 id 集：未绑定就绪技能在此拒绝（绑定才可用，2026-10-21） */
  allowedSkillIds: ReadonlySet<string>;
}): ToolDefinition {
  return {
    name: "load_skill",
    description: "载入某个已安装技能的完整内容（目录只给了摘要，正文用这个工具拿）；返回正文与捆绑文件清单。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "技能名（目录层里的 name）" } },
    },
    output: {
      schema: {
        type: "object",
        required: ["body"],
        properties: {
          body: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => [{ type: "text", text: ((value as { body: string }).body ?? "").slice(0, 500) }],
    },
    async execute(args) {
      const name = String((args as { name?: string })?.name ?? "");
      const metas = await deps.store.list(deps.uid);
      const hit = metas.find((m) => m.name === name);
      if (!hit) throw new Error(`技能 "${name}" 未安装`);
      if (!deps.allowedSkillIds.has(hit.id)) throw new Error(`技能 "${name}" 未绑定到当前伙伴：请让用户先在伙伴设置里绑定该技能`);
      if (!skillVisible(hit)) {
        const reason = hit.status === "installing" ? "正在安装" : hit.status === "failed" ? "安装失败" : "已停用";
        throw new Error(`技能 "${name}" 当前不可用（${reason}）`);
      }
      return {
        body: await deps.store.body(deps.uid, hit.id),
        files: [...deps.files.list(deps.uid, hit.id)].sort(),
      };
    },
    isConcurrencySafe: () => false,
  };
}

/** 单文件读取上限（字符）：捆绑文件是给模型读的参考内容，超限就地报错 */
export const SKILL_FILE_MAX_CHARS = 200_000;

export function createReadSkillFileTool(deps: {
  store: SkillStore;
  uid: string;
  files: SkillFilesIO;
  /** 装配期伙伴绑定的技能 id 集：与 load_skill 同一裁决（绑定才可用，2026-10-21） */
  allowedSkillIds: ReadonlySet<string>;
}): ToolDefinition {
  return {
    name: "read_skill_file",
    description:
      "读取已安装技能的捆绑文件内容（load_skill 返回的文件清单里的路径）。路径必须是该技能包内的相对路径。",
    parameters: {
      type: "object",
      required: ["skill_name", "path"],
      properties: {
        skill_name: { type: "string", description: "技能名（目录层里的 name）" },
        path: { type: "string", description: "捆绑文件相对路径（load_skill 返回的 files 列表中的某一项）" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["content"],
        properties: { content: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: ((value as { content: string }).content ?? "").slice(0, 300) }],
    },
    async execute(args) {
      const skillName = String((args as { skill_name?: string })?.skill_name ?? "");
      const path = safeRelPath(String((args as { path?: string })?.path ?? ""));
      const metas = await deps.store.list(deps.uid);
      const hit = metas.find((m) => m.name === skillName);
      if (!hit) throw new Error(`技能 "${skillName}" 未安装`);
      if (!deps.allowedSkillIds.has(hit.id)) throw new Error(`技能 "${skillName}" 未绑定到当前伙伴`);
      if (!skillVisible(hit)) throw new Error(`技能 "${skillName}" 当前不可用`);
      const listed = deps.files.list(deps.uid, hit.id);
      if (!listed.includes(path)) throw new Error(`文件 "${path}" 不在该技能包里（可用文件见 load_skill 返回的 files）`);
      const content = deps.files.read(deps.uid, hit.id, path);
      if (content.length > SKILL_FILE_MAX_CHARS) {
        throw new Error(`文件 "${path}" ${content.length} 字符超过 ${SKILL_FILE_MAX_CHARS} 上限，无法载入上下文`);
      }
      return { content };
    },
    isConcurrencySafe: () => false,
  };
}
