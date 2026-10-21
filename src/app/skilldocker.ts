// Docker 交互唯一注入面（spec: 2026-10-21_11-23_技能系统Docker沙箱化）。
// 真实现 NodeDockerClient 走 docker CLI（app 层允许平台依赖；harness 零感知）；
// 测试注入捕获型 DockerRunner 断言 argv，不真跑 docker（铁律 5）。
// 契约：exec/runScript 的超时由 runner 内部强制（kill 子进程后拒绝）。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pack } from "tar-stream";

export const SKILL_BASE_IMAGE = "openprism-skill-base:1";

export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunnerOpts {
  input?: Buffer;
  timeoutMs?: number;
}

export interface DockerRunnerResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type DockerRunner = (cmd: string, args: string[], opts?: DockerRunnerOpts) => Promise<DockerRunnerResult>;

/** 单流捕获上限（安装期命令输出防爆） */
const RUNNER_CAPTURE_MAX = 256 * 1024;

function collectTo(chunks: Buffer[], chunk: Buffer): void {
  const used = chunks.reduce((sum, c) => sum + c.length, 0);
  if (used < RUNNER_CAPTURE_MAX) chunks.push(chunk.subarray(0, RUNNER_CAPTURE_MAX - used));
}

export const realDockerRunner: DockerRunner = (cmd, args, opts) =>
  new Promise<DockerRunnerResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => collectTo(out, chunk));
    child.stderr.on("data", (chunk: Buffer) => collectTo(err, chunk));
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : undefined;
    if (timer && typeof timer.unref === "function") timer.unref();
    child.stdin.end(opts?.input);
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (killed) {
        reject(new Error(`docker ${args[0] ?? ""} 超时（${opts?.timeoutMs}ms）已终止`));
        return;
      }
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });

export interface ScriptRunOptions {
  command: string;
  timeoutMs: number;
  /** 宿主机运行目录（挂载为容器 /home/skill/run；产物写其 output 子目录） */
  runDir: string;
  env?: Record<string, string>;
}

export interface DockerClient {
  /** 基础镜像不在时抛可读错误（含构建指引） */
  ensureBaseImage(): Promise<void>;
  /** 起临时安装容器（d + sleep infinity），返回容器 id */
  startTempContainer(): Promise<string>;
  /** 把技能包文件注入容器 /home/skill（tar 经 stdin） */
  copyIn(container: string, files: Map<string, Buffer>): Promise<void>;
  /** 安装容器内执行命令；退出码原样透传 */
  exec(container: string, command: string, opts?: { timeoutMs?: number }): Promise<DockerExecResult>;
  /** 安装容器状态固化为技能镜像 */
  commit(container: string, tag: string): Promise<void>;
  /** 清理容器（尽力而为：容器已不在视为成功） */
  removeContainer(container: string): Promise<void>;
  /** 从技能镜像起短命容器跑脚本（--rm，挂载运行目录） */
  runScript(imageTag: string, opts: ScriptRunOptions): Promise<DockerExecResult>;
  imageExists(tag: string): Promise<boolean>;
  /** 删镜像（尽力而为） */
  removeImage(tag: string): Promise<void>;
}

function cliError(op: string, args: string[], result: DockerRunnerResult): Error {
  return new Error(`docker ${op} 失败（退出码 ${result.code}）：${result.stderr.toString().slice(0, 500) || args.join(" ")}`);
}

/** tar-stream 把文件表打成 tar 字节（copyIn 的 stdin 载荷；与解包同库，零手写格式） */
function tarOf(files: Map<string, Buffer>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const packer = pack();
    const chunks: Buffer[] = [];
    packer.on("data", (chunk: unknown) => chunks.push(chunk as Buffer));
    packer.on("error", (error: Error) => reject(error));
    packer.on("end", () => resolve(Buffer.concat(chunks)));
    for (const [name, data] of files) packer.entry({ name, mode: 0o755 }, data);
    packer.finalize();
  });
}

export class NodeDockerClient implements DockerClient {
  constructor(private runner: DockerRunner = realDockerRunner) {}

  async ensureBaseImage(): Promise<void> {
    try {
      const result = await this.runner("docker", ["image", "inspect", SKILL_BASE_IMAGE]);
      if (result.code !== 0) throw new Error();
    } catch {
      throw new Error(
        `基础镜像 ${SKILL_BASE_IMAGE} 不存在：请在服务器上执行 docker build -t ${SKILL_BASE_IMAGE} -f deploy/skill-base.Dockerfile deploy/（见 docs/deployment.md 技能沙箱一节）`,
      );
    }
  }

  async startTempContainer(): Promise<string> {
    const name = `openprism-skill-install-${randomUUID().slice(0, 8)}`;
    const result = await this.runner("docker", [
      "run",
      "-d",
      "--name",
      name,
      SKILL_BASE_IMAGE,
      "sleep",
      "infinity",
    ]);
    if (result.code !== 0) throw cliError("run", ["run", name], result);
    const id = result.stdout.toString().trim().split("\n")[0] ?? "";
    if (id === "") throw new Error("docker run -d 未返回容器 id");
    return id;
  }

  async copyIn(container: string, files: Map<string, Buffer>): Promise<void> {
    const input = await tarOf(files);
    const result = await this.runner("docker", ["exec", "-i", container, "tar", "-x", "-C", "/home/skill"], { input });
    if (result.code !== 0) throw cliError("exec tar", ["copyIn", container], result);
  }

  async exec(container: string, command: string, opts?: { timeoutMs?: number }): Promise<DockerExecResult> {
    const result = await this.runner("docker", ["exec", container, "bash", "-lc", command], {
      timeoutMs: opts?.timeoutMs,
    });
    return { exitCode: result.code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  async commit(container: string, tag: string): Promise<void> {
    const result = await this.runner("docker", ["commit", container, tag]);
    if (result.code !== 0) throw cliError("commit", ["commit", tag], result);
  }

  async removeContainer(container: string): Promise<void> {
    try {
      await this.runner("docker", ["rm", "-f", container]);
    } catch {
      // 容器已被守护进程回收属正常清理路径
    }
  }

  async runScript(imageTag: string, opts: ScriptRunOptions): Promise<DockerExecResult> {
    const envArgs = Object.entries({ SKILL_OUTPUT_DIR: "/home/skill/run/output", ...(opts.env ?? {}) }).flatMap(
      ([key, value]) => ["-e", `${key}=${value}`],
    );
    const result = await this.runner(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${opts.runDir}:/home/skill/run`,
        ...envArgs,
        "-w",
        "/home/skill",
        imageTag,
        "bash",
        "-c",
        opts.command,
      ],
      { timeoutMs: opts.timeoutMs },
    );
    return { exitCode: result.code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  async imageExists(tag: string): Promise<boolean> {
    try {
      const result = await this.runner("docker", ["image", "inspect", tag]);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async removeImage(tag: string): Promise<void> {
    try {
      await this.runner("docker", ["rmi", tag]);
    } catch {
      // 镜像不存在时的清理视为成功
    }
  }
}
