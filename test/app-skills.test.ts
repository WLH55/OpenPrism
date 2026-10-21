// 批次2·skills：标准 Agent Skill（frontmatter 解析）——安装、目录层文本、load_skill 工具（skills 表）。

import { describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import {
  createLoadSkillTool,
  createReadSkillFileTool,
  parseSkillFile,
  SkillStore,
  skillCatalogPrompt,
  type SkillFilesIO,
} from "../src/app/skills";
import { testDb } from "./helpers-db";

const SKILL_MD = `---
name: 健身复盘
description: 当用户聊到健身、力量训练、跑步时，用这套复盘框架追问组数/重量/感受
when_to_use: 健身与训练话题
---

# 健身复盘框架

1. 问清今天练了什么部位、几组几次
2. 问主观疲劳度（1-10）
3. 给出下次的加重要建议（+2.5kg 或保持）`;

describe("parseSkillFile", () => {
  it("解析 frontmatter 平面键 + 正文；when_to_use 可选", () => {
    const parsed = parseSkillFile(SKILL_MD);
    expect(parsed.name).toBe("健身复盘");
    expect(parsed.description).toContain("复盘框架");
    expect(parsed.whenToUse).toBe("健身与训练话题");
    expect(parsed.body).toContain("# 健身复盘框架");
  });

  it("description 超过 1024 字符拒绝装进目录层（4b.2 硬约束）", () => {
    const long = `---\nname: x\ndescription: ${"长".repeat(1025)}\n---\n正文`;
    expect(() => parseSkillFile(long)).toThrow();
  });

  it("缺 name 或 description 拒绝", () => {
    expect(() => parseSkillFile("---\nname: x\n---\n正文")).toThrow();
    expect(() => parseSkillFile("没有 frontmatter 的裸文档")).toThrow();
  });
});

describe("SkillStore", () => {
  it("create/list/body/remove 往返；body 返回完整原文（含空行）", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-1" });
    const meta = await store.create("u1", SKILL_MD);
    expect(meta.name).toBe("健身复盘");
    expect((await store.list("u1")).map((s) => s.id)).toEqual(["sk-1"]);
    expect(await store.body("u1", "sk-1")).toBe(SKILL_MD);
    await store.remove("u1", "sk-1");
    expect(await store.list("u1")).toHaveLength(0);
    await expect(store.body("u1", "sk-1")).rejects.toThrow();
  });

  it("listSync：绑定技能的同步目录层（systemPrompt 每步热读）", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-2" });
    const meta = await store.create("u1", SKILL_MD);
    expect(store.listSync("u1", [meta.id]).map((s) => s.name)).toEqual(["健身复盘"]);
    expect(store.listSync("u1", [])).toEqual([]);
    expect(store.listSync("u1", ["nope"])).toEqual([]);
  });
});

describe("skillCatalogPrompt / load_skill", () => {
  it("目录层文本含 name 与 when_to_use，不含正文（渐进式加载）", () => {
    const text = skillCatalogPrompt([
      { id: "sk-1", name: "健身复盘", description: "健身话题用这套复盘框架追问细节", whenToUse: "健身与训练话题" },
    ]);
    expect(text).toContain("健身复盘");
    expect(text).toContain("健身与训练话题");
    expect(text).not.toContain("加重要建议");
    expect(text).toContain("load_skill");
  });

  it("load_skill：execute 返回正文；未知名抛错；exclusive", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-9" });
    await store.create("u1", SKILL_MD);
    const tool = createLoadSkillTool({ store, uid: "u1", files: filesIOOf({}) });
    const ctx = { signal: new AbortController().signal, env: nodeEnv };
    const value = (await tool.execute({ name: "健身复盘" }, ctx)) as { body: string };
    expect(value.body).toContain("健身复盘框架");
    await expect(tool.execute({ name: "不存在" }, ctx)).rejects.toThrow();
    expect(tool.isConcurrencySafe?.({})).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 安装态扩展（spec 2026-10-21_11-23 §4.3 步骤 5）：status/version/enabled/image_tag/pkg_sha

const PKG_MD = `---
name: 压缩图片
description: 按需压缩图片
---

# 压缩图片

用 scripts/compress.py 处理。`;

describe("SkillStore 安装态扩展", () => {
  it("粘贴创建默认 ready + enabled，无镜像字段", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-a" });
    const meta = await store.create("u1", SKILL_MD);
    expect(meta.status).toBe("ready");
    expect(meta.enabled).toBe(true);
    expect(meta.imageTag).toBeUndefined();
    expect(meta.pkgSha).toBeUndefined();
  });

  it("createFromPackage → installing；markReady 落 imageTag/version；markFailed 落 installError", async () => {
    let seq = 0;
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => `sk-b${seq++}` });
    const meta = await store.createFromPackage("u1", {
      name: "压缩图片",
      description: "按需压缩",
      pkgSha: "abc12345",
      bodyMd: PKG_MD,
    });
    expect(meta.status).toBe("installing");
    store.markReady("u1", meta.id, { imageTag: "openprism-skill/sk-b0:abc12345", version: "1.2.0" });
    const after = (await store.list("u1")).find((s) => s.id === meta.id)!;
    expect(after.status).toBe("ready");
    expect(after.imageTag).toBe("openprism-skill/sk-b0:abc12345");
    expect(after.version).toBe("1.2.0");
    expect(after.enabled).toBe(true);

    const failed = await store.createFromPackage("u2", {
      name: "坏技能",
      description: "d",
      pkgSha: "fff00000",
      bodyMd: PKG_MD,
    });
    store.markFailed("u2", failed.id, "验证门：缺声明依赖 requests");
    const row = (await store.list("u2")).find((s) => s.id === failed.id)!;
    expect(row.status).toBe("failed");
    expect(row.installError).toContain("requests");
  });

  it("同名重装复用同一 id（绑定关系不丢）", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-c" });
    const first = await store.createFromPackage("u1", {
      name: "压缩图片",
      description: "旧",
      pkgSha: "aaaa0000",
      bodyMd: PKG_MD,
    });
    store.markReady("u1", first.id, { imageTag: "openprism-skill/x:aaaa0000" });
    const second = await store.createFromPackage("u1", {
      name: "压缩图片",
      description: "新",
      pkgSha: "bbbb0000",
      bodyMd: PKG_MD,
    });
    expect(second.id).toBe(first.id);
    // 重装中旧镜像仍可服务：image_tag 不动，status=installing
    const row = (await store.list("u1")).find((s) => s.id === first.id)!;
    expect(row.status).toBe("installing");
    expect(row.imageTag).toBe("openprism-skill/x:aaaa0000");
  });

  it("listSync 只透出 ready && enabled（installing/failed/停用都不可见）", async () => {
    let seq = 0;
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => `sk-d${seq++}` });
    const a = await store.createFromPackage("u1", { name: "安装中", description: "d", pkgSha: "p1", bodyMd: PKG_MD });
    const b = await store.createFromPackage("u1", { name: "将停用", description: "d", pkgSha: "p2", bodyMd: PKG_MD });
    store.markReady("u1", b.id, { imageTag: "t2" });
    const c = await store.createFromPackage("u1", { name: "失败者", description: "d", pkgSha: "p3", bodyMd: PKG_MD });
    store.markFailed("u1", c.id, "x");
    const d = await store.createFromPackage("u1", { name: "正常", description: "d", pkgSha: "p4", bodyMd: PKG_MD });
    store.markReady("u1", d.id, { imageTag: "t4" });
    const visible = store.listSync("u1", [a.id, b.id, c.id, d.id]).map((s) => s.name);
    expect(visible).toEqual(["将停用", "正常"]);
    store.setEnabled("u1", b.id, false);
    expect(store.listSync("u1", [a.id, b.id, c.id, d.id]).map((s) => s.name)).toEqual(["正常"]);
  });

  it("load_skill 对非可见技能报不可用（含状态原因）", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-e" });
    const meta = await store.createFromPackage("u1", { name: "压缩图片", description: "d", pkgSha: "p", bodyMd: PKG_MD });
    const tool = createLoadSkillTool({ store, uid: "u1", files: filesIOOf({}) });
    const ctx = { signal: new AbortController().signal, env: nodeEnv };
    await expect(tool.execute({ name: "压缩图片" }, ctx)).rejects.toThrow(/不可用/);
    store.markReady("u1", meta.id, { imageTag: "t" });
    const value = (await tool.execute({ name: "压缩图片" }, ctx)) as { body: string };
    expect(value.body).toContain("压缩图片");
  });
});

// ---------------------------------------------------------------------------
// L3 捆绑文件（spec 2026-10-21_11-23 §4.3 步骤 6）：load_skill 返回文件树 + read_skill_file

function filesIOOf(map: Record<string, Record<string, string>>): SkillFilesIO {
  return {
    list: (_uid, sid) => Object.keys(map[sid] ?? {}),
    read: (_uid, sid, path) => {
      const files = map[sid] ?? {};
      if (!(path in files)) throw new Error(`文件 "${path}" 不在该技能包里`);
      return files[path]!;
    },
  };
}

describe("L3 捆绑文件读取", () => {
  const FILES: Record<string, string> = {
    "scripts/compress.py": "print('压缩')",
    "references/formats.md": "# 支持格式",
  };

  async function readySkillWithFiles(): Promise<{ store: SkillStore; sid: string }> {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-f" });
    const meta = await store.createFromPackage("u1", { name: "压缩图片", description: "d", pkgSha: "p", bodyMd: PKG_MD });
    store.markReady("u1", meta.id, { imageTag: "t" });
    return { store, sid: meta.id };
  }

  it("load_skill 返回正文 + 捆绑文件树", async () => {
    const { store, sid } = await readySkillWithFiles();
    const tool = createLoadSkillTool({ store, uid: "u1", files: filesIOOf({ [sid]: FILES }) });
    const value = (await tool.execute({ name: "压缩图片" }, { signal: new AbortController().signal, env: nodeEnv })) as {
      body: string;
      files: string[];
    };
    expect(value.body).toContain("压缩图片");
    expect(value.files).toEqual(["references/formats.md", "scripts/compress.py"]);
  });

  it("粘贴技能无文件时 files 为空数组", async () => {
    const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "sk-g" });
    await store.create("u1", SKILL_MD);
    const tool = createLoadSkillTool({ store, uid: "u1", files: filesIOOf({}) });
    const value = (await tool.execute({ name: "健身复盘" }, { signal: new AbortController().signal, env: nodeEnv })) as {
      files: string[];
    };
    expect(value.files).toEqual([]);
  });

  it("read_skill_file：读捆绑文件；未安装/不可见/路径逃逸/不在包内分别报错", async () => {
    const { store, sid } = await readySkillWithFiles();
    const tool = createReadSkillFileTool({ store, uid: "u1", files: filesIOOf({ [sid]: FILES }) });
    const ctx = { signal: new AbortController().signal, env: nodeEnv };
    const value = (await tool.execute({ skill_name: "压缩图片", path: "scripts/compress.py" }, ctx)) as {
      content: string;
    };
    expect(value.content).toContain("压缩");
    await expect(tool.execute({ skill_name: "不存在", path: "x" }, ctx)).rejects.toThrow(/未安装/);
    await expect(tool.execute({ skill_name: "压缩图片", path: "../escape" }, ctx)).rejects.toThrow(/路径/);
    await expect(tool.execute({ skill_name: "压缩图片", path: "/etc/passwd" }, ctx)).rejects.toThrow(/路径/);
    await expect(tool.execute({ skill_name: "压缩图片", path: "nope.txt" }, ctx)).rejects.toThrow(/不在/);
    expect(tool.isConcurrencySafe?.({})).toBeFalsy();
  });
});
