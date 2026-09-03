// 批次1·app 层地基：Node 平台缝（nodeFileIO）与用户沙盒目录布局（appPaths / ensureUserSandbox）。

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths, ensureUserSandbox } from "../src/app/store";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-store-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("nodeFileIO", () => {
  it("readAll 对不存在的文件返回空数组（首次创建 = 空日志）", async () => {
    expect(await nodeFileIO.readAll(join(root, "nope.jsonl"))).toEqual([]);
  });

  it("appendLine 自动创建父目录并按行追加", async () => {
    const path = join(root, "users", "u1", "life.jsonl");
    await nodeFileIO.appendLine(path, '{"a":1}');
    await nodeFileIO.appendLine(path, '{"a":2}');
    expect(await nodeFileIO.readAll(path)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("readAll 过滤空白行（外部产物的尾部换行/空行不进日志）", async () => {
    const path = join(root, "blank.jsonl");
    await writeFile(path, 'x\n\n   \ny\n', "utf8");
    expect(await nodeFileIO.readAll(path)).toEqual(["x", "y"]);
  });
});

describe("nodeEnv", () => {
  it("randomUUID 每次返回不重复的 UUID 形态字符串", () => {
    const a = nodeEnv.randomUUID();
    const b = nodeEnv.randomUUID();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("appPaths", () => {
  it("目录布局符合沙盒裁决（users/{uid}/ 完整隔离）", () => {
    const p = appPaths(join(root, "data"));
    expect(p.usersFile).toBe(join(root, "data", "users.jsonl"));
    expect(p.lifeFile("u1")).toBe(join(root, "data", "users", "u1", "life.jsonl"));
    expect(p.modelFile("u1")).toBe(join(root, "data", "users", "u1", "model.json"));
    expect(p.convDir("u1", "c1")).toBe(join(root, "data", "users", "u1", "conversations", "c1"));
  });
});

describe("ensureUserSandbox", () => {
  it("注册即建用户目录与会话目录，且幂等", async () => {
    const paths = appPaths(join(root, "d2"));
    await ensureUserSandbox(paths, "u1");
    const dir = await stat(paths.userDir("u1"));
    expect(dir.isDirectory()).toBe(true);
    await expect(stat(paths.conversationsDir("u1"))).resolves.toBeTruthy();
    await ensureUserSandbox(paths, "u1"); // 重复调用不抛
  });
});
