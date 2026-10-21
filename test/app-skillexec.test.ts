// skill_exec 工具（spec 2026-10-21_11-23 §4.3 步骤 8）：并发闸门、超时、输出截断、
// exit_code 透传、产物扫描入库。docker 注入 fake（铁律 5）；运行目录用仓库内 .cache（gitignored）。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { createSkillExecTool, sniffArtifactType, MAX_CONCURRENT_SKILL_RUNS } from "../src/app/skillexec";
import type { DockerClient, DockerExecResult } from "../src/app/skilldocker";
import { SkillStore } from "../src/app/skills";
import { testDb } from "./helpers-db";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const PKG_MD = `---
name: 压缩图片
description: 按需压缩图片
---

# 压缩图片`;

interface FakeDockerCall {
  imageTag: string;
  command: string;
  timeoutMs: number;
  runDir: string;
}

/** fake docker：记录调用；runScript 把预设产物写进 runDir/output（模拟容器挂载目录产出） */
function fakeDocker(behavior: {
  result?: Partial<DockerExecResult>;
  artifacts?: Record<string, Buffer>;
  error?: Error;
  gate?: () => Promise<void>;
}): { docker: DockerClient; calls: FakeDockerCall[] } {
  const calls: FakeDockerCall[] = [];
  const docker: DockerClient = {
    ensureBaseImage: async () => undefined,
    startTempContainer: async () => "c-install",
    copyIn: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    commit: async () => undefined,
    removeContainer: async () => undefined,
    runScript: async (imageTag, opts) => {
      calls.push({ imageTag, command: opts.command, timeoutMs: opts.timeoutMs, runDir: opts.runDir });
      if (behavior.gate !== undefined) await behavior.gate();
      if (behavior.error !== undefined) throw behavior.error;
      mkdirSync(join(opts.runDir, "output"), { recursive: true });
      for (const [name, bytes] of Object.entries(behavior.artifacts ?? {})) {
        const target = join(opts.runDir, "output", name);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, bytes);
      }
      return { exitCode: 0, stdout: "", stderr: "", ...(behavior.result ?? {}) };
    },
    imageExists: async () => true,
    removeImage: async () => undefined,
  };
  return { docker, calls };
}

function blobsRecorder(): { blobs: { save(ref: string, mediaType: string, bytes: Buffer): void }; saved: Map<string, { mediaType: string; bytes: Buffer }> } {
  const saved = new Map<string, { mediaType: string; bytes: Buffer }>();
  return {
    blobs: {
      save: (ref, mediaType, bytes) => {
        saved.set(ref, { mediaType, bytes });
      },
    },
    saved,
  };
}

/** 仓库内运行目录根（.cache 已 gitignored；每个用例独立子目录） */
function runsRoot(): string {
  return mkdtempSync(join(process.cwd(), ".cache", "skillruns-"));
}

async function readySkill(runs: string, withImage = true): Promise<{ store: SkillStore; sid: string }> {
  const store = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => runs });
  const meta = await store.createFromPackage("u1", { name: "压缩图片", description: "d", pkgSha: "sha1", bodyMd: PKG_MD });
  if (withImage) store.markReady("u1", meta.id, { imageTag: `openprism-skill/${runs}:sha1` });
  return { store, sid: meta.id };
}

describe("sniffArtifactType", () => {
  it("魔数探测 png/jpeg/pdf/zip；文本与二进制兜底", () => {
    expect(sniffArtifactType(PNG_BYTES)).toBe("image/png");
    expect(sniffArtifactType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffArtifactType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffArtifactType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("application/zip");
    expect(sniffArtifactType(Buffer.from("普通文本内容"))).toBe("text/plain");
    expect(sniffArtifactType(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe("application/octet-stream");
  });
});

describe("skill_exec 工具", () => {
  it("正常链路：镜像/命令/超时传 docker；产物扫描、sniff、sha256 入 blobs；exit_code 透传", async () => {
    const root = runsRoot();
    try {
      const { store } = await readySkill("r1");
      const { docker, calls } = fakeDocker({
        result: { exitCode: 0, stdout: "压缩完成", stderr: "" },
        artifacts: { "a.png": PNG_BYTES, "报告.txt": Buffer.from("压缩报告正文") },
      });
      const { blobs, saved } = blobsRecorder();
      const tool = createSkillExecTool({ docker, store, blobs, uid: "u1", runsRoot: root, randomUUID: () => "run-1" });
      const value = (await tool.execute(
        { skill_name: "压缩图片", command: "python scripts/compress.py --quality 80", timeout_sec: 300 },
        { signal: new AbortController().signal, env: nodeEnv },
      )) as {
        exit_code: number;
        stdout: string;
        artifacts: { name: string; mediaType: string; ref: string; size: number }[];
      };
      expect(value.exit_code).toBe(0);
      expect(value.stdout).toBe("压缩完成");
      expect(calls[0]!.imageTag).toBe("openprism-skill/r1:sha1");
      expect(calls[0]!.command).toBe("python scripts/compress.py --quality 80");
      expect(calls[0]!.timeoutMs).toBe(300_000);
      expect(value.artifacts.map((a) => a.name)).toEqual(["a.png", "报告.txt"]);
      const png = value.artifacts.find((a) => a.name === "a.png")!;
      expect(png.mediaType).toBe("image/png");
      expect(png.ref).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
      expect(png.size).toBe(PNG_BYTES.length);
      expect(saved.get(png.ref)!.bytes.equals(PNG_BYTES)).toBe(true);
      // render 产物标记行（验收 B3 的前端下载契约）：sid|ref|name|mediaType|size 五段
      const rendered = tool.output!.render({}, value as unknown) as { type: string; text: string }[];
      const marker = rendered[0]!.text.split("\n").find((line) => line.startsWith("〔artifact〕"))!;
      expect(marker).toBe(`〔artifact〕r1|${png.ref}|a.png|image/png|${PNG_BYTES.length}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("非零 exit_code 原样透传不抛错；stderr 同步返回", async () => {
    const root = runsRoot();
    try {
      const { store } = await readySkill("r2");
      const { docker } = fakeDocker({ result: { exitCode: 2, stdout: "", stderr: "Traceback ..." } });
      const tool = createSkillExecTool({ docker, store, blobs: blobsRecorder().blobs, uid: "u1", runsRoot: root, randomUUID: () => "run-2" });
      const value = (await tool.execute({ skill_name: "压缩图片", command: "false" }, { signal: new AbortController().signal, env: nodeEnv })) as {
        exit_code: number;
        stderr: string;
      };
      expect(value.exit_code).toBe(2);
      expect(value.stderr).toContain("Traceback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无镜像技能（粘贴安装）与不可见技能给可读错误", async () => {
    const root = runsRoot();
    try {
      // 粘贴安装：ready 且无 imageTag
      const pasteStore = new SkillStore({ db: testDb(), now: () => 1, randomUUID: () => "r3" });
      await pasteStore.create("u1", PKG_MD);
      const disabled = await readySkill("r4");
      disabled.store.setEnabled("u1", disabled.sid, false);
      const { docker } = fakeDocker({});
      const ctx = { signal: new AbortController().signal, env: nodeEnv };
      const tool3 = createSkillExecTool({ docker, store: pasteStore, blobs: blobsRecorder().blobs, uid: "u1", runsRoot: root, randomUUID: () => "run-3" });
      await expect(tool3.execute({ skill_name: "压缩图片", command: "x" }, ctx)).rejects.toThrow(/脚本执行环境/);
      const tool4 = createSkillExecTool({ docker, store: disabled.store, blobs: blobsRecorder().blobs, uid: "u1", runsRoot: root, randomUUID: () => "run-4" });
      await expect(tool4.execute({ skill_name: "压缩图片", command: "x" }, ctx)).rejects.toThrow(/不可用/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("超时错误透传；command 超 8192 字符就地拒绝", async () => {
    const root = runsRoot();
    try {
      const { store } = await readySkill("r5");
      const { docker } = fakeDocker({ error: new Error("docker run 超时（600000ms）已终止") });
      const tool = createSkillExecTool({ docker, store, blobs: blobsRecorder().blobs, uid: "u1", runsRoot: root, randomUUID: () => "run-5" });
      const ctx = { signal: new AbortController().signal, env: nodeEnv };
      await expect(tool.execute({ skill_name: "压缩图片", command: "sleep 999" }, ctx)).rejects.toThrow(/超时/);
      await expect(
        tool.execute({ skill_name: "压缩图片", command: "x".repeat(8193) }, ctx),
      ).rejects.toThrow(/8192/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("输出保头保尾截断（注入小上限）", async () => {
    const root = runsRoot();
    try {
      const { store } = await readySkill("r6");
      const long = `头部标记\n${"中".repeat(5000)}\n尾部标记`;
      const { docker } = fakeDocker({ result: { exitCode: 0, stdout: long, stderr: "" } });
      const tool = createSkillExecTool({
        docker,
        store,
        blobs: blobsRecorder().blobs,
        uid: "u1",
        runsRoot: root,
        randomUUID: () => "run-6",
        limits: { stdoutMax: 200, stderrMax: 100, totalMax: 400 },
      });
      const value = (await tool.execute({ skill_name: "压缩图片", command: "x" }, { signal: new AbortController().signal, env: nodeEnv })) as {
        stdout: string;
      };
      expect(value.stdout).toContain("头部标记");
      expect(value.stdout).toContain("尾部标记");
      expect(value.stdout).toContain("截断");
      expect(value.stdout.length).toBeLessThan(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("并发闸门：同时最多 3 个在跑，第 4 个排队等释放", async () => {
    const root = runsRoot();
    try {
      const { store } = await readySkill("r7");
      const calls: FakeDockerCall[] = [];
      let active = 0;
      let peak = 0;
      let gateEntries = 0;
      const pending: (() => void)[] = [];
      const docker: DockerClient = {
        ...fakeDocker({}).docker,
        runScript: async (imageTag, opts) => {
          calls.push({ imageTag, command: opts.command, timeoutMs: opts.timeoutMs, runDir: opts.runDir });
          active += 1;
          peak = Math.max(peak, active);
          gateEntries += 1;
          // 前 3 个（并发位占满）阻塞等待手动放行；第 4 个进入即有位空闲，自动走
          if (gateEntries <= MAX_CONCURRENT_SKILL_RUNS) {
            await new Promise<void>((resolve) => pending.push(resolve));
          }
          active -= 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      const tool = createSkillExecTool({ docker, store, blobs: blobsRecorder().blobs, uid: "u1", runsRoot: root, randomUUID: () => "run-7" });
      const ctx = { signal: new AbortController().signal, env: nodeEnv };
      const runs = Array.from({ length: MAX_CONCURRENT_SKILL_RUNS + 1 }, (_, i) =>
        tool.execute({ skill_name: "压缩图片", command: `job-${i}` }, ctx).catch(() => undefined),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.length).toBe(MAX_CONCURRENT_SKILL_RUNS);
      expect(peak).toBe(MAX_CONCURRENT_SKILL_RUNS);
      pending.splice(0).forEach((release) => release());
      await Promise.all(runs);
      expect(calls.length).toBe(MAX_CONCURRENT_SKILL_RUNS + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
