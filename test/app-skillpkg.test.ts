// 技能包来源与解析（spec: 2026-10-21_11-23 技能系统 Docker 沙箱化 §4.3 步骤 2-4）
// 四类来源分类、解包与根定位、下载 URL 转换。零网络：fetch 全部注入 fake。

import { describe, expect, it } from "vitest";
import { gzipSync, strToU8, zipSync } from "fflate";
import { pack } from "tar-stream";
import {
  fetchSkillPackage,
  locateSkillRoot,
  parseSkillSource,
  prepareSkillFiles,
  unpackSkillArchive,
  validateSkillIdentity,
  type SkillSource,
} from "../src/app/skillpkg";
import type { PlatformEnv } from "../src/harness/index";

const SKILL_MD = `---
name: 压缩图片
description: 把用户给的图片按目标大小压缩
---

# 压缩图片

用 scripts/compress.py 处理。`;

/** 用 fflate 构造真实 zip 字节（测试数据本身是真实归档格式，零手写编码） */
function zipOf(entries: Record<string, string>): Buffer {
  const mapped: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) mapped[name] = strToU8(content);
  return Buffer.from(zipSync(mapped));
}

/** 用 tar-stream 构造真实 tar.gz 字节 */
async function tgzOf(entries: Record<string, string>): Promise<Buffer> {
  const packer = pack();
  const chunks: Buffer[] = [];
  packer.on("data", (chunk: unknown) => chunks.push(chunk as Buffer));
  for (const [name, content] of Object.entries(entries)) packer.entry({ name }, content);
  packer.finalize();
  await new Promise<void>((resolve) => packer.on("end", () => resolve()));
  return Buffer.from(gzipSync(Buffer.concat(chunks)));
}

describe("parseSkillSource：四类来源分类", () => {
  it("GitHub 仓库根 URL", () => {
    expect(parseSkillSource("https://github.com/anthropics/skills")).toEqual({
      kind: "github",
      url: "https://github.com/anthropics/skills",
      subdir: undefined,
    });
  });

  it("GitHub tree 子目录（ref 后的路径为 subdir）", () => {
    const source = parseSkillSource("https://github.com/anthropics/skills/tree/main/document-skills/pdf");
    expect(source.kind).toBe("github");
    if (source.kind !== "github") return;
    expect(source.subdir).toBe("document-skills/pdf");
  });

  it("GitHub blob 指向 SKILL.md 时取父目录", () => {
    const source = parseSkillSource("https://github.com/o/r/blob/main/x/y/SKILL.md");
    expect(source.kind).toBe("github");
    if (source.kind !== "github") return;
    expect(source.subdir).toBe("x/y");
  });

  it("GitHub blob 指向其他文件时拒绝并建议改写", () => {
    expect(() => parseSkillSource("https://github.com/o/r/blob/main/README.md")).toThrow(/SKILL\.md|tree/);
  });

  it("skills.sh URL", () => {
    expect(parseSkillSource("https://skills.sh/vercel/mcp/add-issue")).toMatchObject({
      kind: "skills-sh",
      url: "https://skills.sh/vercel/mcp/add-issue",
    });
  });

  it("zip / tar.gz 归档直链", () => {
    expect(parseSkillSource("https://example.com/pkg.zip")).toMatchObject({ kind: "archive-url" });
    expect(parseSkillSource("https://example.com/pkg.tar.gz")).toMatchObject({ kind: "archive-url" });
  });

  it("单个 SKILL.md 直链", () => {
    expect(parseSkillSource("https://example.com/SKILL.md")).toEqual({
      kind: "md-url",
      url: "https://example.com/SKILL.md",
      subdir: undefined,
    });
  });

  it("非 URL 与模糊 owner/slug 输入拒绝并给改写建议", () => {
    expect(() => parseSkillSource("这不是链接")).toThrow(/http/);
    expect(() => parseSkillSource("anthropics/skills")).toThrow(/@|http/);
  });

  it("不在四类内的平台拒绝并列出支持范围", () => {
    expect(() => parseSkillSource("https://clawhub.ai/some/skill")).toThrow(/GitHub|skills\.sh|zip|SKILL\.md/);
  });
});

describe("unpackSkillArchive：解包与防护", () => {
  const LIMITS = { maxFileBytes: 200, maxTotalBytes: 400, maxEntries: 3 };

  it("zip 解包：扁平与嵌套路径往返", async () => {
    const bytes = zipOf({ "SKILL.md": SKILL_MD, "scripts/run.py": "print(1)" });
    const files = await unpackSkillArchive(bytes, "pkg.zip", LIMITS);
    expect([...files.keys()].sort()).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(files.get("scripts/run.py")!.toString()).toBe("print(1)");
  });

  it("tar.gz 解包", async () => {
    const bytes = await tgzOf({ "pkg/SKILL.md": SKILL_MD, "pkg/refs/a.md": "参考" });
    const files = await unpackSkillArchive(bytes, "pkg.tar.gz", LIMITS);
    expect(files.get("pkg/SKILL.md")!.toString()).toContain("压缩图片");
    expect(files.get("pkg/refs/a.md")!.toString()).toBe("参考");
  });

  it("路径逃逸条目拒绝（../ 与绝对路径与反斜杠）", async () => {
    await expect(unpackSkillArchive(zipOf({ "../evil.txt": "x" }), "p.zip", LIMITS)).rejects.toThrow(/不安全/);
    await expect(unpackSkillArchive(zipOf({ "/etc/passwd": "x" }), "p.zip", LIMITS)).rejects.toThrow(/不安全/);
    await expect(unpackSkillArchive(zipOf({ "a\\b.txt": "x" }), "p.zip", LIMITS)).rejects.toThrow(/不安全/);
  });

  it("单文件 / 总量 / 条目数上限触发", async () => {
    await expect(unpackSkillArchive(zipOf({ big: "x".repeat(201) }), "p.zip", LIMITS)).rejects.toThrow(/单文件/);
    await expect(
      unpackSkillArchive(zipOf({ a: "x".repeat(150), b: "x".repeat(150), c: "x".repeat(150) }), "p.zip", LIMITS),
    ).rejects.toThrow(/总/);
    await expect(
      unpackSkillArchive(zipOf({ a: "1", b: "2", c: "3", d: "4" }), "p.zip", LIMITS),
    ).rejects.toThrow(/条目/);
  });

  it("目录条目与 __MACOSX/.DS_Store 元数据跳过", async () => {
    const bytes = zipOf({ "pkg/SKILL.md": SKILL_MD, "__MACOSX/junk": "x", "pkg/.DS_Store": "y" });
    const files = await unpackSkillArchive(bytes, "p.zip", { ...LIMITS, maxEntries: 5 });
    expect([...files.keys()]).toEqual(["pkg/SKILL.md"]);
  });
});

describe("locateSkillRoot：根定位", () => {
  it("根直下与包裹目录两层都能定位", () => {
    const flat = new Map([["SKILL.md", Buffer.from(SKILL_MD)]]);
    expect(locateSkillRoot(flat)).toEqual({ root: "", skillMd: "SKILL.md" });
    const wrapped = new Map([
      ["repo-main/SKILL.md", Buffer.from(SKILL_MD)],
      ["repo-main/scripts/a.py", Buffer.from("x")],
    ]);
    expect(locateSkillRoot(wrapped)).toEqual({ root: "repo-main", skillMd: "repo-main/SKILL.md" });
  });

  it("无 SKILL.md 抛错；多根（monorepo zipball）抛错并建议 tree 链接", () => {
    expect(() => locateSkillRoot(new Map([["a.txt", Buffer.from("x")]]))).toThrow(/SKILL\.md/);
    const mono = new Map([
      ["repo/skills/a/SKILL.md", Buffer.from("a")],
      ["repo/skills/b/SKILL.md", Buffer.from("b")],
    ]);
    expect(() => locateSkillRoot(mono)).toThrow(/tree|子目录/);
  });

  it("深嵌套单根可定位（GitHub 子目录 zipball 多层包裹）", () => {
    const deep = new Map([["r/x/y/SKILL.md", Buffer.from("s")]]);
    expect(locateSkillRoot(deep).root).toBe("r/x/y");
  });
});

describe("validateSkillIdentity：frontmatter 身份约束（市面规范口径）", () => {
  it("合法身份通过（含 CJK 名字）", () => {
    expect(validateSkillIdentity("压缩图片", "按需压缩图片")).toEqual({ name: "压缩图片", description: "按需压缩图片" });
  });

  it("name 超 64 码点拒绝；非法字符（空格/点/斜杠）拒绝；保留词 anthropic/claude 拒绝", () => {
    expect(() => validateSkillIdentity("a".repeat(65), "d")).toThrow(/64/);
    expect(() => validateSkillIdentity("a b", "d")).toThrow(/name/);
    expect(() => validateSkillIdentity("a/b", "d")).toThrow(/name/);
    expect(() => validateSkillIdentity("anthropic", "d")).toThrow(/保留/);
    expect(() => validateSkillIdentity("claude", "d")).toThrow(/保留/);
  });

  it("description 超 1024 码点拒绝；含 XML 标签拒绝", () => {
    expect(() => validateSkillIdentity("ok", "长".repeat(1025))).toThrow(/1024/);
    expect(() => validateSkillIdentity("ok", "见 <script>alert(1)</script>")).toThrow(/XML/);
  });
});

// ---------------------------------------------------------------------------
// fetchSkillPackage：URL 转换 + 下载（fake env.fetch，零网络）

function fakeEnv(
  handler: (url: string) => Promise<{ ok: boolean; status: number; bytes?: Buffer }>,
): PlatformEnv {
  return {
    async fetch(url: string) {
      const result = await handler(url);
      const bytes = result.bytes ?? Buffer.alloc(0);
      return {
        ok: result.ok,
        status: result.status,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/octet-stream" : null) },
        json: async () => {
          throw new Error("测试不期望 JSON");
        },
        text: async () => bytes.toString(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    now: () => 1,
    randomUUID: () => "uuid-1",
  } as unknown as PlatformEnv;
}

describe("fetchSkillPackage：URL 转换与下载", () => {
  it("GitHub 仓库根 → codeload zipball HEAD", async () => {
    const seen: string[] = [];
    const env = fakeEnv(async (url) => {
      seen.push(url);
      return { ok: true, status: 200, bytes: zipOf({ "SKILL.md": SKILL_MD }) };
    });
    const result = await fetchSkillPackage(env, parseSkillSource("https://github.com/anthropics/skills"));
    expect(seen).toEqual(["https://codeload.github.com/anthropics/skills/zip/HEAD"]);
    expect(result.fileName).toBe("skills@HEAD.zip");
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("GitHub tree ref → zipball 指定 ref；skills.sh → GitHub 仓库 zipball HEAD", async () => {
    const seen: string[] = [];
    const env = fakeEnv(async (url) => {
      seen.push(url);
      return { ok: true, status: 200, bytes: Buffer.alloc(1) };
    });
    await fetchSkillPackage(env, parseSkillSource("https://github.com/o/r/tree/v2/x"));
    await fetchSkillPackage(env, parseSkillSource("https://skills.sh/vercel-labs/skills/find-skills"));
    expect(seen).toEqual([
      "https://codeload.github.com/o/r/zip/v2",
      "https://codeload.github.com/vercel-labs/skills/zip/HEAD",
    ]);
  });

  it("归档与 md 直链原样下载", async () => {
    const seen: string[] = [];
    const env = fakeEnv(async (url) => {
      seen.push(url);
      return { ok: true, status: 200, bytes: Buffer.from("data") };
    });
    await fetchSkillPackage(env, parseSkillSource("https://example.com/pkg.zip"));
    await fetchSkillPackage(env, parseSkillSource("https://example.com/SKILL.md"));
    expect(seen).toEqual(["https://example.com/pkg.zip", "https://example.com/SKILL.md"]);
  });

  it("非 2xx 抛错并带状态码", async () => {
    const env = fakeEnv(async () => ({ ok: false, status: 404 }));
    await expect(fetchSkillPackage(env, parseSkillSource("https://example.com/pkg.zip"))).rejects.toThrow(/404/);
  });

  it("超时（注入小 timeoutMs，fetch 永不返回）抛错", async () => {
    const hung = fakeEnv(() => new Promise(() => undefined));
    await expect(
      fetchSkillPackage(hung, parseSkillSource("https://example.com/pkg.zip"), { timeoutMs: 30 }),
    ).rejects.toThrow(/超时/);
  });
});

// ---------------------------------------------------------------------------
// prepareSkillFiles：subdir 过滤 + slug 匹配 + 根重定基

describe("prepareSkillFiles", () => {
  it("github subdir：剥包裹层取指定子目录并重定基到根", async () => {
    const bytes = zipOf({
      "repo-main/a/SKILL.md": SKILL_MD,
      "repo-main/a/scripts/x.py": "print(1)",
      "repo-main/b/SKILL.md": "---\nname: other\ndescription: d\n---\n正文",
      "repo-main/README.md": "无关",
    });
    const files = await unpackSkillArchive(bytes, "r.zip");
    const prepared = prepareSkillFiles(files, { subdir: "a" });
    expect([...prepared.files.keys()].sort()).toEqual(["SKILL.md", "scripts/x.py"]);
    expect(prepared.name).toBe("压缩图片");
  });

  it("skills.sh slugHint：多根仓库按目录名或 frontmatter name 匹配", () => {
    const files = new Map<string, Buffer>([
      ["repo/pdf-tools/SKILL.md", Buffer.from(SKILL_MD)],
      ["repo/other/SKILL.md", Buffer.from("---\nname: 备胎\ndescription: d\n---\n正文")],
    ]);
    expect(prepareSkillFiles(files, { slugHint: "pdf-tools" }).name).toBe("压缩图片");
    expect(prepareSkillFiles(files, { slugHint: "压缩图片" }).name).toBe("压缩图片");
  });

  it("无 hint 多根抛错建议 tree 链接；hint 匹配不到抛错", () => {
    const files = new Map<string, Buffer>([
      ["repo/a/SKILL.md", Buffer.from(SKILL_MD)],
      ["repo/b/SKILL.md", Buffer.from("---\nname: 备胎\ndescription: d\n---\n正文")],
    ]);
    expect(() => prepareSkillFiles(files)).toThrow(/tree|子目录/);
    expect(() => prepareSkillFiles(files, { slugHint: "nope" })).toThrow(/tree|子目录|slug/);
  });

  it("frontmatter version 透出（缺省 undefined）", () => {
    const withVersion = new Map<string, Buffer>([
      ["SKILL.md", Buffer.from("---\nname: v技能\ndescription: d\nversion: 1.2.0\n---\n正文")],
    ]);
    expect(prepareSkillFiles(withVersion).version).toBe("1.2.0");
    expect(prepareSkillFiles(new Map([["SKILL.md", Buffer.from(SKILL_MD)]])).version).toBeUndefined();
  });
});
