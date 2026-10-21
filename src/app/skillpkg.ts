// 技能包来源与解析（spec: 2026-10-21_11-23_技能系统Docker沙箱化）。
// 四类来源：GitHub 仓库/tree/blob、skills.sh、归档直链（zip/tar.gz）、单个 SKILL.md 直链。
// 下载走注入的 env.fetch；解包用 fflate / tar-stream（第三方库，零手写格式 parser）。

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, unzipSync } from "fflate";
import { extract } from "tar-stream";
import type { PlatformEnv } from "../harness/index";

/**
 * 技能包文件访问面（磁盘实现在本文件；skills.ts 的工具消费它，测试注入 fake）。
 * 目录布局：{skillsRoot}/{uid}/{sid}/pkg/{相对路径}。
 */
export interface SkillFilesIO {
  /** 技能包内捆绑文件相对路径列表（不含 SKILL.md 本体）；无文件技能返回空数组 */
  list(uid: string, sid: string): string[];
  /** 读单个捆绑文件的文本内容；不存在就地抛错 */
  read(uid: string, sid: string, path: string): string;
}

export class DiskSkillFiles implements SkillFilesIO {
  constructor(private root: string) {}

  list(uid: string, sid: string): string[] {
    const dir = join(this.root, uid, sid, "pkg");
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(current, entry.name), rel);
        else if (entry.isFile() && rel !== "SKILL.md") out.push(rel);
      }
    };
    walk(dir, "");
    return out.sort();
  }

  read(uid: string, sid: string, path: string): string {
    return readFileSync(join(this.root, uid, sid, "pkg", path), "utf8");
  }
}

/** 安装器写包文件（SKILL.md 与捆绑文件一并落盘） */
export function writePackageFiles(root: string, uid: string, sid: string, files: Map<string, Buffer>): void {
  const dir = join(root, uid, sid, "pkg");
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, data] of files) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, data);
  }
}

/** 卸载时删包文件（目录不存在时静默） */
export function removePackageFiles(root: string, uid: string, sid: string): void {
  rmSync(join(root, uid, sid), { recursive: true, force: true });
}

/** 安装流水线回读包文件（二进制安全；含 SKILL.md）——copyIn 与验证门的数据源 */
export function readPackageFiles(root: string, uid: string, sid: string): Map<string, Buffer> {
  const dir = join(root, uid, sid, "pkg");
  const files = new Map<string, Buffer>();
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return files;
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) files.set(rel, readFileSync(join(current, entry.name)));
    }
  };
  walk(dir, "");
  return files;
}

export type SkillSourceKind = "github" | "skills-sh" | "archive-url" | "md-url";

export interface SkillSource {
  kind: SkillSourceKind;
  /** 原始 URL（规范化：去尾斜杠、去 .git 后缀；保持可序列化存储供重试） */
  url: string;
  /** github 专属：ref 后的子目录（blob 指向 SKILL.md 时取父目录） */
  subdir?: string;
}

const SUPPORTED_HINT = "支持四类来源：GitHub 仓库/tree/blob 指向 SKILL.md 的链接、skills.sh 技能页链接、zip/tar.gz 归档直链、单个 SKILL.md 直链";

/** GitHub URL 里的 owner/repo/ref/subdir 拆解（parseSkillSource 与 fetchSkillPackage 共用） */
export function githubParts(url: string): { owner: string; repo: string; ref: string; subdir: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter((s) => s !== "");
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/, "");
  if (owner === "" || repo === "") throw new Error(`GitHub 链接需要 owner/repo 形态：${url}`);
  if (segments.length <= 2) return { owner, repo, ref: "HEAD", subdir: "" };
  const rest = segments.slice(2);
  const kind = rest[0]!;
  if (kind === "tree") {
    const ref = rest[1] ?? "";
    if (ref === "") throw new Error(`GitHub tree 链接缺 ref：${url}`);
    return { owner, repo, ref, subdir: rest.slice(2).join("/") };
  }
  if (kind === "blob") {
    const ref = rest[1] ?? "";
    const path = rest.slice(2).join("/");
    if (ref === "" || path === "") throw new Error(`GitHub blob 链接缺 ref 或文件路径：${url}`);
    if (!path.endsWith("SKILL.md")) {
      throw new Error(`GitHub blob 链接需指向 SKILL.md（收到 ${path}）；子目录请改用 tree 链接`);
    }
    return { owner, repo, ref, subdir: path.split("/").slice(0, -1).join("/") };
  }
  throw new Error(`GitHub 链接只认仓库根 / tree 子目录 / blob SKILL.md 三种形态（收到 /${rest.join("/")}）`);
}

export function parseSkillSource(input: string): SkillSource {
  const trimmed = input.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(`来源需要完整 http(s) 链接（收到「${trimmed}」）。${SUPPORTED_HINT}；形如 owner/slug 的简写请补全为完整链接`);
  }
  const parsed = new URL(trimmed);
  const host = parsed.host.replace(/^www\./, "");
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const segments = pathname.replace(/^\/+/, "").split("/").filter((s) => s !== "");

  if (host === "github.com") {
    if (segments.length < 2) throw new Error(`GitHub 链接需要 owner/repo 形态：${trimmed}`);
    const rest = segments.slice(2);
    if (rest.length > 0 && rest[0] !== "tree" && rest[0] !== "blob") {
      throw new Error(`GitHub 链接只认仓库根 / tree 子目录 / blob SKILL.md 三种形态（收到 /${rest.join("/")}）。${SUPPORTED_HINT}`);
    }
    if (rest[0] === "blob" && !rest.slice(2).join("/").endsWith("SKILL.md")) {
      throw new Error(`GitHub blob 链接需指向 SKILL.md（收到 /${rest.slice(2).join("/")}）；子目录请改用 tree 链接`);
    }
    const parts = githubParts(trimmed);
    return { kind: "github", url: trimmed, ...(parts.subdir !== "" ? { subdir: parts.subdir } : {}) };
  }

  if (host === "skills.sh") {
    if (segments.length !== 3) throw new Error(`skills.sh 链接需 owner/repo/slug 三段（收到 ${pathname}）`);
    return { kind: "skills-sh", url: trimmed };
  }

  if (/\.(zip|tar\.gz|tgz|tar)$/.test(pathname)) return { kind: "archive-url", url: trimmed };
  if (/\.md$/.test(pathname)) return { kind: "md-url", url: trimmed };

  throw new Error(`无法识别的来源：${trimmed}。${SUPPORTED_HINT}`);
}

// ---------------------------------------------------------------------------
// 解包（zip 走 fflate；tar.gz 走 tar-stream + fflate gunzip）

export interface ArchiveLimits {
  /** 单条目解压后字节上限 */
  maxFileBytes: number;
  /** 全部条目解压后总量上限（zip bomb 防护） */
  maxTotalBytes: number;
  /** 条目数上限 */
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
};

function entrySafePath(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return !name.split("/").includes("..");
}

/** 平台垃圾条目（__MACOSX、.DS_Store）跳过 */
function isJunkEntry(name: string): boolean {
  return name.split("/").some((segment) => segment === "__MACOSX" || segment === ".DS_Store");
}

export async function unpackSkillArchive(
  bytes: Buffer,
  fileName: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let total = 0;
  let entries = 0;
  const take = (name: string, data: Buffer): void => {
    if (name.endsWith("/") || isJunkEntry(name)) return;
    if (!entrySafePath(name)) throw new Error(`归档条目路径不安全：${name}`);
    entries += 1;
    if (entries > limits.maxEntries) throw new Error(`归档条目数超过 ${limits.maxEntries} 上限`);
    if (data.length > limits.maxFileBytes) {
      throw new Error(`条目 ${name} 解压后 ${data.length} 字节，超过单文件 ${limits.maxFileBytes} 字节上限`);
    }
    total += data.length;
    if (total > limits.maxTotalBytes) throw new Error(`归档解压总量超过 ${limits.maxTotalBytes} 字节上限`);
    files.set(name, data);
  };

  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) {
    const unzipped = unzipSync(new Uint8Array(bytes));
    for (const [name, data] of Object.entries(unzipped)) take(name, Buffer.from(data));
    return files;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar")) {
    const tarBytes = lower.endsWith(".tar") ? bytes : Buffer.from(gunzipSync(new Uint8Array(bytes)));
    const ex = extract();
    const finished = new Promise<void>((resolve, reject) => {
      ex.on("finish", () => resolve());
      ex.on("error", (error: Error) => reject(error));
    });
    ex.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => chunks.push(chunk as Buffer));
      stream.on("end", () => {
        take(header.name, Buffer.concat(chunks));
        next();
      });
    });
    ex.end(tarBytes);
    await finished;
    return files;
  }
  throw new Error(`不支持的归档格式：${fileName}（支持 zip / tar.gz / tar）`);
}

// ---------------------------------------------------------------------------
// 根定位：SKILL.md 所在目录即技能根（GitHub zipball 常有 repo-main/ 包裹层）

export interface SkillRoot {
  root: string;
  skillMd: string;
}

export function locateSkillRoot(files: Map<string, Buffer>): SkillRoot {
  const hits: string[] = [];
  for (const name of files.keys()) {
    if (name.split("/").pop() !== "SKILL.md") continue;
    hits.push(name.split("/").slice(0, -1).join("/"));
  }
  if (hits.length === 0) {
    throw new Error("包里没有 SKILL.md：技能包需要根目录（或任一子目录树下）存在 SKILL.md");
  }
  if (hits.length > 1) {
    throw new Error(`包里有多个 SKILL.md 根（${hits.join("、")}）：整仓库安装请改用 tree 子目录链接指定单个技能`);
  }
  const root = hits[0]!;
  return { root, skillMd: root === "" ? "SKILL.md" : `${root}/SKILL.md` };
}

// ---------------------------------------------------------------------------
// frontmatter 身份约束（市面规范口径，WeKnora 同款数值）

const RESERVED_NAMES = new Set(["anthropic", "claude"]);
const NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const XML_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/;

export function validateSkillIdentity(name: string, description: string): { name: string; description: string } {
  const namePoints = [...name].length;
  if (namePoints === 0) throw new Error("frontmatter 缺 name");
  if (namePoints > 64) throw new Error(`name ${namePoints} 码点超过 64 上限`);
  if (!NAME_PATTERN.test(name)) throw new Error(`name 只允许字母/数字/连字符/下划线（收到「${name}」）`);
  if (RESERVED_NAMES.has(name.toLowerCase())) throw new Error(`name 保留词禁用：${name}`);
  if (XML_TAG_PATTERN.test(name)) throw new Error("name 禁止 XML 标签");
  const descPoints = [...description].length;
  if (descPoints === 0) throw new Error("frontmatter 缺 description");
  if (descPoints > 1024) throw new Error(`description ${descPoints} 码点超过 1024 上限`);
  if (XML_TAG_PATTERN.test(description)) throw new Error("description 禁止 XML 标签");
  return { name, description };
}

// ---------------------------------------------------------------------------
// SKILL.md 解析（平面 key: value frontmatter；校验身份后返回正文与可选字段）

export interface ParsedSkill {
  name: string;
  description: string;
  whenToUse?: string;
  version?: string;
  body: string;
}

export function parseSkillFile(content: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error("SKILL.md 需要 YAML frontmatter（--- 包裹的头部）");
  const front: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) front[kv[1]!] = kv[2]!.trim();
  }
  const identity = validateSkillIdentity(front.name ?? "", front.description ?? "");
  return {
    name: identity.name,
    description: identity.description,
    ...(front.when_to_use !== undefined ? { whenToUse: front.when_to_use } : {}),
    ...(front.version !== undefined ? { version: front.version } : {}),
    body: match[2] ?? "",
  };
}

// ---------------------------------------------------------------------------
// 下载：四类来源 → 统一拿到归档/单文件字节

export const PACKAGE_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

export interface FetchPackageOpts {
  timeoutMs?: number;
}

function urlFileName(url: string, fallback: string): string {
  const segment = new URL(url).pathname.split("/").filter((s) => s !== "").pop();
  return segment !== undefined && segment !== "" ? segment : fallback;
}

export async function fetchSkillPackage(
  env: PlatformEnv,
  source: SkillSource,
  opts: FetchPackageOpts = {},
): Promise<{ fileName: string; bytes: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? PACKAGE_FETCH_TIMEOUT_MS;
  let url: string;
  let fileName: string;
  if (source.kind === "github") {
    const parts = githubParts(source.url);
    url = `https://codeload.github.com/${parts.owner}/${parts.repo}/zip/${encodeURIComponent(parts.ref)}`;
    fileName = `${parts.repo}@${parts.ref}.zip`;
  } else if (source.kind === "skills-sh") {
    // skills.sh 的 API 需要 Vercel OIDC token（匿名不可用）——slug 只用于后续根匹配，
    // 字节一律从 GitHub 匿名 zipball 拿（skills.sh 页面本身就是 owner/repo/slug 三段）
    const segments = new URL(source.url).pathname.replace(/^\/+|\/+$/g, "").split("/").filter((s) => s !== "");
    const owner = segments[0] ?? "";
    const repo = segments[1] ?? "";
    if (owner === "" || repo === "") throw new Error(`skills.sh 链接需 owner/repo/slug 三段：${source.url}`);
    url = `https://codeload.github.com/${owner}/${repo}/zip/HEAD`;
    fileName = `${repo}@HEAD.zip`;
  } else if (source.kind === "archive-url") {
    url = source.url;
    fileName = urlFileName(url, "package.zip");
  } else {
    url = source.url;
    fileName = urlFileName(url, "SKILL.md");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`下载技能包超时（${timeoutMs}ms）：${url}`)),
      { once: true },
    );
  });
  try {
    const response = await Promise.race([
      env.fetch(url, { signal: controller.signal, headers: { "User-Agent": "openprism-skill-installer" } }),
      timeoutPromise,
    ]);
    if (!response.ok) throw new Error(`下载技能包失败：HTTP ${response.status}（${url}）`);
    if (response.arrayBuffer === undefined) throw new Error("env.fetch 缺 arrayBuffer 能力，无法下载二进制技能包");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`下载到空文件：${url}`);
    return { fileName, bytes };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 根选择与重定基：subdir 精确定位 / slugHint 匹配 / 单根直取，产出 SKILL.md 在根的文件集

export interface PreparedSkill {
  name: string;
  description: string;
  whenToUse?: string;
  version?: string;
  /** 重定基后的包文件（SKILL.md 位于根） */
  files: Map<string, Buffer>;
}

interface SkillRootCandidate {
  dir: string;
  skillMd: string;
  name?: string;
}

function readRoots(files: Map<string, Buffer>): SkillRootCandidate[] {
  const roots: SkillRootCandidate[] = [];
  for (const path of files.keys()) {
    if (path.split("/").pop() !== "SKILL.md") continue;
    const dir = path.split("/").slice(0, -1).join("/");
    let name: string | undefined;
    try {
      name = parseSkillFile(files.get(path)!.toString()).name;
    } catch {
      name = undefined;
    }
    roots.push({ dir, skillMd: path, name });
  }
  return roots;
}

export function prepareSkillFiles(files: Map<string, Buffer>, hint?: { subdir?: string; slugHint?: string }): PreparedSkill {
  const roots = readRoots(files);
  if (roots.length === 0) {
    throw new Error("包里没有 SKILL.md：技能包需要根目录（或任一子目录树下）存在 SKILL.md");
  }

  let picked: SkillRootCandidate | undefined;
  const subdir = hint?.subdir?.trim() ?? "";
  if (subdir !== "") {
    const hits = roots.filter((r) => r.dir === subdir || r.dir.endsWith(`/${subdir}`));
    if (hits.length > 1) throw new Error(`子目录 ${subdir} 匹配到多个 SKILL.md 根，无法唯一确定`);
    picked = hits[0];
    if (picked === undefined) throw new Error(`包里没有子目录 ${subdir} 下的 SKILL.md（GitHub 链接与仓库内容不符）`);
  } else if (roots.length === 1) {
    picked = roots[0];
  } else {
    const slug = hint?.slugHint?.trim() ?? "";
    const hits = slug === "" ? [] : roots.filter((r) => r.dir.split("/").pop() === slug || r.name === slug);
    if (hits.length === 1) picked = hits[0];
    if (picked === undefined) {
      const extra = slug !== "" ? `（slug「${slug}」未匹配到任何根）` : "";
      throw new Error(
        `包里有多个 SKILL.md 根（${roots.map((r) => r.dir).join("、")}）：整仓库安装请改用 GitHub tree 子目录链接指定单个技能${extra}`,
      );
    }
  }

  const prefix = picked.dir === "" ? "" : `${picked.dir}/`;
  const rebased = new Map<string, Buffer>();
  for (const [path, data] of files) {
    if (path.startsWith(prefix)) rebased.set(path.slice(prefix.length), data);
  }
  const parsed = parseSkillFile(rebased.get("SKILL.md")!.toString());
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    ...(parsed.version !== undefined ? { version: parsed.version } : {}),
    files: rebased,
  };
}
