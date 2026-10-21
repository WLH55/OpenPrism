// 安装流水线（spec 2026-10-21_11-23 §4.3 步骤 9）：临时容器 + 安装智能体 + 验证门 + commit。
// docker 与模型适配器全部注入 fake（铁律 5，零网络零 docker）；文件根用仓库内 .cache（gitignored）。

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createMockLlmAdapter, type LlmAdapter } from "../src/harness/index";
import { SkillStore } from "../src/app/skills";
import { SkillInstaller } from "../src/app/skillinstall";
import type { DockerClient } from "../src/app/skilldocker";
import type { PlatformEnv } from "../src/harness/index";
import { testDb } from "./helpers-db";

const SKILL_MD = `---
name: 压缩图片
description: 按需压缩图片
version: 1.2.0
---

# 压缩图片

用 scripts/compress.py 处理（依赖 requests）。`;

function zipOf(entries: Record<string, string>): Buffer {
  const mapped: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) mapped[name] = strToU8(content);
  return Buffer.from(zipSync(mapped));
}

const GOOD_REPORT = JSON.stringify({ commands: ["ffmpeg"], blockers: [], notes: [] });

interface FakeDockerOpts {
  /** exec 命令分发器：返回退出码与 stdout；缺省成功 */
  execFor?: (command: string) => { code: number; stdout: string };
  /** copyIn 卡点（并发顺序测试用） */
  copyInGate?: () => Promise<void>;
}

function fakeDocker(opts: FakeDockerOpts = {}): {
  docker: DockerClient;
  execLog: string[];
  ops: string[];
  copyInFiles: Map<string, Buffer>[];
} {
  const execLog: string[] = [];
  const ops: string[] = [];
  const copyInFiles: Map<string, Buffer>[] = [];
  const docker: DockerClient = {
    ensureBaseImage: async () => {
      ops.push("ensureBaseImage");
    },
    startTempContainer: async () => {
      ops.push("run");
      return `c-${ops.length}`;
    },
    copyIn: async (_container, files) => {
      ops.push("copyIn");
      copyInFiles.push(files);
      if (opts.copyInGate !== undefined) await opts.copyInGate();
    },
    exec: async (_container, command) => {
      execLog.push(command);
      const result = opts.execFor ? opts.execFor(command) : { code: 0, stdout: "" };
      return { exitCode: result.code, stdout: result.stdout, stderr: "" };
    },
    commit: async (_container, tag) => {
      ops.push(`commit:${tag}`);
    },
    removeContainer: async () => {
      ops.push("rm");
    },
    runScript: async () => {
      throw new Error("安装流水线不应调 runScript");
    },
    imageExists: async () => true,
    removeImage: async (tag) => {
      ops.push(`rmi:${tag}`);
    },
  };
  return { docker, execLog, ops, copyInFiles };
}

function fakeEnv(handler: (url: string) => { ok: boolean; status: number; bytes?: Buffer }): PlatformEnv {
  return {
    async fetch(url: string) {
      const result = handler(url);
      const bytes = result.bytes ?? Buffer.alloc(0);
      return {
        ok: result.ok,
        status: result.status,
        headers: { get: () => "application/zip" },
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    now: () => 1,
    randomUUID: () => "uuid-i",
  } as unknown as PlatformEnv;
}

function makeInstaller(overrides?: {
  docker?: DockerClient;
  env?: PlatformEnv;
  adapter?: LlmAdapter;
}): { installer: SkillInstaller; store: SkillStore; filesRoot: string } {
  const filesRoot = mkdtempSync(join(process.cwd(), ".cache", "skillfiles-"));
  const db = testDb();
  const store = new SkillStore({ db, now: () => 1, randomUUID: () => `sid-${Math.random().toString(36).slice(2, 8)}` });
  const { adapter } = createMockLlmAdapter([
    { kind: "tool-calls", calls: [{ name: "shell", arguments: { command: "pip install requests" } }] },
    { kind: "text", text: "依赖已装，报告已写。" },
    { kind: "text", text: "已修复缺的依赖。" },
  ]);
  const installer = new SkillInstaller({
    env: overrides?.env ?? fakeEnv(() => ({ ok: true, status: 200 })),
    store,
    docker: overrides?.docker ?? fakeDocker().docker,
    filesRoot,
    randomUUID: () => `run-${Math.random().toString(36).slice(2, 8)}`,
    adapterFor: async () => ({ adapter: overrides?.adapter ?? (adapter as LlmAdapter), model: "installer-model" }),
  });
  return { installer, store, filesRoot };
}

const ZIP_BYTES = zipOf({
  "SKILL.md": SKILL_MD,
  "scripts/compress.py": "import requests\nprint('压缩')",
  "requirements.txt": "requests\n",
});

describe("SkillInstaller 安装流水线", () => {
  it("成功路径：容器内安装 → 验证门 → commit → ready；事件推进到 done", async () => {
    const { docker, execLog, ops, copyInFiles } = fakeDocker({
      execFor: (command) => {
        if (command.includes("install-report.json")) return { code: 0, stdout: GOOD_REPORT };
        return { code: 0, stdout: "" };
      },
    });
    const { installer, store, filesRoot } = makeInstaller({ docker });
    try {
      const meta = await installer.installFromZip("u1", "pkg.zip", ZIP_BYTES);
      const final = await installer.settled("u1", meta.id);
      expect(final.phase).toBe("done");
      const row = (await store.list("u1")).find((s) => s.id === meta.id)!;
      expect(row.status).toBe("ready");
      const sha8 = createHash("sha256").update(ZIP_BYTES).digest("hex").slice(0, 8);
      expect(row.imageTag).toBe(`openprism-skill/${meta.id}:${sha8}`);
      expect(row.version).toBe("1.2.0");
      // 容器生命周期：起容器 → 注入文件 → agent 装依赖 + 验证门命令 → commit → 清理
      expect(ops[0]).toBe("ensureBaseImage");
      expect(ops).toEqual(
        expect.arrayContaining(["run", "copyIn", `commit:${row.imageTag}`, "rm"]),
      );
      expect(copyInFiles[0]!.get("SKILL.md")!.toString()).toContain("压缩图片");
      expect(copyInFiles[0]!.get("scripts/compress.py")!.toString()).toContain("requests");
      expect(execLog.join("\n")).toContain("pip install requests");
      expect(execLog.join("\n")).toContain("install-report.json");
      expect(execLog.join("\n")).toContain("command -v ffmpeg");
      expect(execLog.join("\n")).toContain("py_compile");
      expect(execLog.join("\n")).toContain("importlib.metadata");
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it("验证门可修复失败 → repair 轮 → 通过 ready；事件含 verify 与 repair 相位", async () => {
    let ffmpegOk = false;
    const { docker } = fakeDocker({
      execFor: (command) => {
        if (command.includes("install-report.json")) return { code: 0, stdout: GOOD_REPORT };
        if (command.includes("apt-get install")) {
          ffmpegOk = true; // repair 轮的安装命令落地后，重验即可通过
          return { code: 0, stdout: "" };
        }
        if (command.includes("command -v ffmpeg")) return { code: ffmpegOk ? 0 : 1, stdout: "" };
        return { code: 0, stdout: "" };
      },
    });
    const { adapter } = createMockLlmAdapter([
      { kind: "tool-calls", calls: [{ name: "shell", arguments: { command: "pip install requests" } }] },
      { kind: "text", text: "依赖已装，报告已写。" },
      { kind: "tool-calls", calls: [{ name: "shell", arguments: { command: "apt-get install -y ffmpeg" } }] },
      { kind: "text", text: "已补装 ffmpeg。" },
    ]);
    const { installer, store, filesRoot } = makeInstaller({ docker, adapter: adapter as LlmAdapter });
    try {
      const meta = await installer.installFromZip("u1", "pkg.zip", ZIP_BYTES);
      const events: string[] = [];
      for await (const progress of installer.progressStream("u1", meta.id)) {
        events.push(progress.phase);
        if (progress.phase === "done" || progress.phase === "failed") break;
      }
      expect(events).toContain("verify");
      expect(events).toContain("repair");
      expect(events[events.length - 1]).toBe("done");
      expect((await store.list("u1")).find((s) => s.id === meta.id)!.status).toBe("ready");
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it("blockers 非空 → 不可修复失败；重装场景旧 image_tag 保留（Served 语义）", async () => {
    let report = GOOD_REPORT;
    const { docker } = fakeDocker({
      execFor: (command) => {
        if (command.includes("install-report.json")) return { code: 0, stdout: report };
        return { code: 0, stdout: "" };
      },
    });
    const { installer, store, filesRoot } = makeInstaller({ docker });
    try {
      const first = await installer.installFromZip("u1", "pkg.zip", ZIP_BYTES);
      await installer.settled("u1", first.id);
      const oldTag = (await store.list("u1")).find((s) => s.id === first.id)!.imageTag;
      expect(oldTag).toMatch(/^openprism-skill\//);

      report = JSON.stringify({ commands: [], blockers: ["装不上 libraw"], notes: [] });
      const second = await installer.installFromZip("u1", "pkg2.zip", ZIP_BYTES);
      const final = await installer.settled("u1", second.id);
      expect(final.phase).toBe("failed");
      expect(final.error).toContain("libraw");
      const row = (await store.list("u1")).find((s) => s.id === second.id)!;
      expect(row.status).toBe("failed");
      expect(row.installError).toContain("libraw");
      // Served：重装失败不动旧镜像 tag
      expect(row.imageTag).toBe(oldTag);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it("onBootRecover 把 installing 行标为失败（服务重启中断）", async () => {
    const { installer, store, filesRoot } = makeInstaller();
    try {
      const meta = await store.createFromPackage("u1", { name: "中断技能", description: "d", pkgSha: "p", bodyMd: SKILL_MD });
      installer.onBootRecover();
      const row = (await store.list("u1")).find((s) => s.id === meta.id)!;
      expect(row.status).toBe("failed");
      expect(row.installError).toContain("重启");
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it("全局安装并发 1：第二个安装等第一个完成后才起容器", async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { docker, ops } = fakeDocker({
      copyInGate: () => gate,
      execFor: (command) => (command.includes("install-report.json") ? { code: 0, stdout: GOOD_REPORT } : { code: 0, stdout: "" }),
    });
    const { installer, filesRoot } = makeInstaller({ docker });
    try {
      const first = await installer.installFromZip("u1", "a.zip", ZIP_BYTES);
      const second = await installer.installFromZip("u1", "b.zip", zipOf({ "SKILL.md": "---\nname: 另一技能\ndescription: d\n---\n正文" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 第一个卡在 copyIn，第二个不得起容器
      expect(ops.filter((op) => op === "run")).toHaveLength(1);
      releaseFirst!();
      const [finalA, finalB] = await Promise.all([installer.settled("u1", first.id), installer.settled("u1", second.id)]);
      expect(finalA.phase).toBe("done");
      expect(finalB.phase).toBe("done");
      expect(ops.filter((op) => op === "run")).toHaveLength(2);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it("installFromUrl：github 源 → codeload 下载 → 完整流水线 ready", async () => {
    const env = fakeEnv((url) => {
      expect(url).toBe("https://codeload.github.com/anthropics/skills/zip/HEAD");
      return { ok: true, status: 200, bytes: ZIP_BYTES };
    });
    const { docker } = fakeDocker({
      execFor: (command) => (command.includes("install-report.json") ? { code: 0, stdout: GOOD_REPORT } : { code: 0, stdout: "" }),
    });
    const { installer, store, filesRoot } = makeInstaller({ docker, env });
    try {
      const meta = await installer.installFromUrl("u1", "https://github.com/anthropics/skills");
      const final = await installer.settled("u1", meta.id);
      expect(final.phase).toBe("done");
      expect((await store.list("u1")).find((s) => s.id === meta.id)!.status).toBe("ready");
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it("installFromUrl：单 SKILL.md 直链可装（验收 B2）——非归档分支直达流水线", async () => {
    const MD_ONLY = "---\nname: 单文件技能\ndescription: d\n---\n\n正文";
    const env = fakeEnv(() => ({ ok: true, status: 200, bytes: Buffer.from(MD_ONLY) }));
    const { docker, copyInFiles } = fakeDocker({
      execFor: (command) => (command.includes("install-report.json") ? { code: 0, stdout: GOOD_REPORT } : { code: 0, stdout: "" }),
    });
    const { installer, store, filesRoot } = makeInstaller({ docker, env });
    try {
      const meta = await installer.installFromUrl("u1", "https://example.com/SKILL.md");
      const final = await installer.settled("u1", meta.id);
      expect(final.phase).toBe("done");
      const row = (await store.list("u1")).find((s) => s.id === meta.id)!;
      expect(row.name).toBe("单文件技能");
      expect(row.status).toBe("ready");
      expect([...copyInFiles[0]!.keys()]).toEqual(["SKILL.md"]);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });
});
