// DockerClient 接口与 NodeDockerClient CLI 拼装（spec 2026-10-21_11-23 §4.3 步骤 7）。
// 不真跑 docker：注入捕获型 runner 断言 argv 与 stdin 字节；tar 输入用 tar-stream 解回验证。

import { describe, expect, it } from "vitest";
import { extract } from "tar-stream";
import { NodeDockerClient, realDockerRunner, SKILL_BASE_IMAGE, type DockerRunner } from "../src/app/skilldocker";

interface Captured {
  cmd: string;
  args: string[];
  input?: Buffer;
}

function capturingRunner(
  results: Array<{ code?: number; stdout?: string; stderr?: string } | Error>,
): { runner: DockerRunner; calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  const runner: DockerRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    const result = results[Math.min(index, results.length - 1)] ?? {};
    index += 1;
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({
      code: result.code ?? 0,
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? ""),
    });
  };
  return { runner, calls };
}

/** 把 NodeDockerClient.copyIn 的 stdin tar 解回文件表（真实格式往返验证） */
async function untarInput(input: Buffer): Promise<Record<string, string>> {
  const ex = extract();
  const files: Record<string, string> = {};
  const finished = new Promise<void>((resolve, reject) => {
    ex.on("finish", () => resolve());
    ex.on("error", (error: Error) => reject(error));
  });
  ex.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: unknown) => chunks.push(chunk as Buffer));
    stream.on("end", () => {
      files[header.name] = Buffer.concat(chunks).toString();
      next();
    });
  });
  ex.end(input);
  await finished;
  return files;
}

describe("NodeDockerClient：CLI 参数拼装", () => {
  it("startTempContainer：run -d + 基础镜像 + sleep infinity，容器名带前缀", async () => {
    const { runner, calls } = capturingRunner([{ stdout: "container-id\n" }]);
    const client = new NodeDockerClient(runner);
    const id = await client.startTempContainer();
    expect(id).toBe("container-id");
    expect(calls[0]!.args[0]).toBe("run");
    expect(calls[0]!.args).toContain("-d");
    expect(calls[0]!.args).toContain(SKILL_BASE_IMAGE);
    expect(calls[0]!.args.join(" ")).toMatch(/sleep infinity$/);
    expect(calls[0]!.args.join(" ")).toMatch(/--name openprism-skill-install-/);
  });

  it("copyIn：exec -i + tar -x -C /home/skill，stdin 是含全部文件的真实 tar", async () => {
    const { runner, calls } = capturingRunner([{}]);
    const client = new NodeDockerClient(runner);
    await client.copyIn("c1", new Map([["SKILL.md", Buffer.from("# 技能")], ["scripts/a.py", Buffer.from("print(1)")]]));
    const call = calls[0]!;
    expect(call.args).toEqual(["exec", "-i", "c1", "tar", "-x", "-C", "/home/skill"]);
    const files = await untarInput(call.input!);
    expect(files).toEqual({ "SKILL.md": "# 技能", "scripts/a.py": "print(1)" });
  });

  it("exec：bash -lc 包装；超时注入 runner 的 timeoutMs", async () => {
    const { runner, calls } = capturingRunner([{ code: 0, stdout: "ok" }]);
    const client = new NodeDockerClient(runner);
    const result = await client.exec("c1", "python -V", { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(calls[0]!.args).toEqual(["exec", "c1", "bash", "-lc", "python -V"]);
  });

  it("runScript：--rm + 卷挂载 + SKILL_OUTPUT_DIR + 工作目录 + bash -c", async () => {
    const { runner, calls } = capturingRunner([{ code: 0 }]);
    const client = new NodeDockerClient(runner);
    await client.runScript("openprism-skill/s1:abc", {
      command: "python scripts/a.py",
      timeoutMs: 6000,
      runDir: "/runs/r1",
    });
    const args = calls[0]!.args.join(" ");
    expect(args).toContain("run --rm");
    expect(args).toContain("-v /runs/r1:/home/skill/run");
    expect(args).toContain("-e SKILL_OUTPUT_DIR=/home/skill/run/output");
    expect(args).toContain("-w /home/skill");
    expect(args).toContain("openprism-skill/s1:abc");
    expect(args).toMatch(/bash -c python scripts\/a\.py$/);
  });

  it("commit / removeContainer / removeImage / imageExists / ensureBaseImage 参数", async () => {
    const { runner, calls } = capturingRunner([
      { stdout: "sha256:abc\n" },
      {},
      {},
      new Error("No such image"),
      { stdout: `[{"RepoTags":["${SKILL_BASE_IMAGE}"]}]` },
    ]);
    const client = new NodeDockerClient(runner);
    await client.commit("c1", "openprism-skill/s1:abc");
    await client.removeContainer("c1");
    await client.removeImage("openprism-skill/s1:abc");
    expect(await client.imageExists("openprism-skill/nope:t")).toBe(false);
    await client.ensureBaseImage();
    expect(calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "docker commit c1 openprism-skill/s1:abc",
      "docker rm -f c1",
      "docker rmi openprism-skill/s1:abc",
      "docker image inspect openprism-skill/nope:t",
      `docker image inspect ${SKILL_BASE_IMAGE}`,
    ]);
  });

  it("ensureBaseImage 缺基础镜像给可读错误（含构建指引）", async () => {
    const { runner } = capturingRunner([new Error("No such image")]);
    const client = new NodeDockerClient(runner);
    await expect(client.ensureBaseImage()).rejects.toThrow(/skill-base\.Dockerfile|docker build/);
  });

  it("非零退出码原样透传（不抛错）", async () => {
    const { runner } = capturingRunner([{ code: 2, stdout: "", stderr: "boom" }]);
    const client = new NodeDockerClient(runner);
    const result = await client.exec("c1", "false");
    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "boom" });
  });

  it("realDockerRunner 超时 SIGKILL 契约（验收 N1）：长睡眠进程到点被杀并报超时", async () => {
    const started = Date.now();
    await expect(
      realDockerRunner(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 120 }),
    ).rejects.toThrow(/超时/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
