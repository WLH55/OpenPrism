// skill_exec 工具（spec: 2026-10-21_11-23_技能系统Docker沙箱化）。
// 每次执行 docker run --rm 独立容器；产物写 $SKILL_OUTPUT_DIR（挂载的 runDir/output），
// 扫描后 sha256 入 conversation_blobs，模型拿到产物元信息（铁律 2：工具事件落日志可重建）。

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../harness/index";
import type { DockerClient } from "./skilldocker";
import { skillVisible, type SkillStore } from "./skills";

export const MAX_CONCURRENT_SKILL_RUNS = 3;
export const COMMAND_MAX_CHARS = 8192;
const TIMEOUT_DEFAULT_SEC = 120;
const TIMEOUT_MAX_SEC = 600;

export interface SkillOutputLimits {
  stdoutMax: number;
  stderrMax: number;
  totalMax: number;
}

export const DEFAULT_OUTPUT_LIMITS: SkillOutputLimits = { stdoutMax: 16384, stderrMax: 8192, totalMax: 65536 };

/** 产物 mediaType 魔数探测（png/jpeg/gif/webp/pdf/zip；文本嗅探；二进制兜底） */
export function sniffArtifactType(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && bytes.subarray(0, 4).toString("latin1").startsWith("GIF8")) return "image/gif";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.length > 4 && bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) return "application/zip";
  // 文本嗅探：无 NUL、控制字符占比极低即按文本
  const sample = bytes.subarray(0, 4096);
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) controls += 1;
  }
  if (sample.length > 0 && controls / sample.length < 0.01) return "text/plain";
  return "application/octet-stream";
}

/** 保头保尾截断：头 60% + 省略标记 + 尾 30% */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.6);
  const tailLen = Math.floor(max * 0.3);
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n…［输出截断：中间省略 ${omitted} 字符］…\n${text.slice(text.length - tailLen)}`;
}

/** 全局执行闸门（模块级单例：多用户多伙伴共享 3 个并发容器位，超限 FIFO 排队） */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next !== undefined) next();
  }
}

const globalRunsGate = new Semaphore(MAX_CONCURRENT_SKILL_RUNS);

export interface BlobWriter {
  save(ref: string, mediaType: string, bytes: Buffer): void;
}

export interface SkillExecArtifact {
  /** 产物归属的技能行 id（前端下载路由 /api/skills/:sid/artifacts/:ref 用） */
  skillId: string;
  name: string;
  size: number;
  mediaType: string;
  /** sha256 内容寻址 ref（conversation_blobs 主键） */
  ref: string;
}

function scanArtifacts(skillId: string, outputDir: string): SkillExecArtifact[] {
  if (!statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: { rel: string; bytes: Buffer }[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(current, entry.name));
        if (bytes.length > 0) out.push({ rel, bytes });
      }
    }
  };
  walk(outputDir, "");
  return out
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ rel, bytes }) => ({
      skillId,
      name: rel,
      size: bytes.length,
      mediaType: sniffArtifactType(bytes),
      ref: createHash("sha256").update(bytes).digest("hex"),
    }));
}

export function createSkillExecTool(deps: {
  docker: DockerClient;
  store: SkillStore;
  blobs: BlobWriter;
  uid: string;
  runsRoot: string;
  randomUUID(): string;
  limits?: SkillOutputLimits;
}): ToolDefinition {
  const limits = deps.limits ?? DEFAULT_OUTPUT_LIMITS;
  return {
    name: "skill_exec",
    description:
      "在技能的沙箱容器里执行命令（脚本已随技能安装：Python 依赖在 .venv、Node 依赖在 node_modules、工作目录 /home/skill 是技能根）。" +
      "产物文件必须写到 $SKILL_OUTPUT_DIR 指向的目录；执行结束返回 exit_code（非零不算失败，看输出判断）、stdout/stderr（超限保头保尾截断）与产物清单（文件已入库，用户可在网页端下载）。",
    parameters: {
      type: "object",
      required: ["skill_name", "command"],
      properties: {
        skill_name: { type: "string", description: "技能名（目录层里的 name）" },
        command: { type: "string", description: "Bash 命令（≤8192 字符）；按 SKILL.md 的说明组织参数" },
        timeout_sec: { type: "number", description: `超时秒数（默认 ${TIMEOUT_DEFAULT_SEC}，上限 ${TIMEOUT_MAX_SEC}）` },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["exit_code", "stdout", "stderr", "artifacts"],
        properties: {
          exit_code: { type: "number" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              required: ["skillId", "name", "size", "mediaType", "ref"],
              properties: {
                skillId: { type: "string" },
                name: { type: "string" },
                size: { type: "number" },
                mediaType: { type: "string" },
                ref: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as { exit_code?: number; stdout?: string; artifacts?: SkillExecArtifact[] };
        const lines = [`exit_code=${result.exit_code ?? "?"}`];
        // 产物标记行：前端回执解析成下载链接（与 Chat.tsx 的解析约定成对维护）
        for (const artifact of result.artifacts ?? []) {
          lines.push(`〔artifact〕${artifact.skillId}|${artifact.ref}|${artifact.name}|${artifact.mediaType}|${artifact.size}`);
        }
        if ((result.stdout ?? "") !== "") lines.push((result.stdout ?? "").slice(0, 300));
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const skillName = String((args as { skill_name?: string })?.skill_name ?? "");
      const command = String((args as { command?: string })?.command ?? "");
      const timeoutSec = Math.min(Math.max(Number((args as { timeout_sec?: number })?.timeout_sec ?? TIMEOUT_DEFAULT_SEC), 1), TIMEOUT_MAX_SEC);
      if (command.length > COMMAND_MAX_CHARS) {
        throw new Error(`command ${command.length} 字符超过 ${COMMAND_MAX_CHARS} 上限`);
      }
      const metas = await deps.store.list(deps.uid);
      const hit = metas.find((m) => m.name === skillName);
      if (!hit) throw new Error(`技能 "${skillName}" 未安装`);
      if (!skillVisible(hit)) throw new Error(`技能 "${skillName}" 当前不可用`);
      if (hit.imageTag === undefined || hit.imageTag === "") {
        throw new Error(`技能 "${skillName}" 无脚本执行环境（纯提示词技能，没有安装沙箱镜像）`);
      }

      const runId = deps.randomUUID();
      const runDir = join(deps.runsRoot, runId);
      await globalRunsGate.acquire();
      try {
        mkdirSync(runDir, { recursive: true });
        const result = await deps.docker.runScript(hit.imageTag, {
          command,
          timeoutMs: timeoutSec * 1000,
          runDir,
        });
        // 产物入库（真实文件从挂载目录读回）与输出限幅
        const artifacts = scanArtifacts(hit.id, join(runDir, "output"));
        for (const artifact of artifacts) {
          deps.blobs.save(artifact.ref, artifact.mediaType, readFileSync(join(runDir, "output", artifact.name)));
        }
        const stdout = truncateMiddle(result.stdout, limits.stdoutMax);
        const stderr = truncateMiddle(result.stderr, limits.stderrMax);
        const totalUsed = stdout.length + stderr.length;
        return {
          exit_code: result.exitCode,
          ...(totalUsed > limits.totalMax
            ? {
                stdout: truncateMiddle(stdout, Math.floor(limits.totalMax * 0.75)),
                stderr: truncateMiddle(stderr, Math.floor(limits.totalMax * 0.2)),
              }
            : { stdout, stderr }),
          artifacts,
        };
      } finally {
        rmSync(runDir, { recursive: true, force: true });
        globalRunsGate.release();
      }
    },
    isConcurrencySafe: () => false,
  };
}
