// 批次1·app 层地基：Node 平台缝（nodeFileIO/nodeEnv）与数据布局（appPaths + openDb 表结构，ADR 0008）。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv, nodeFileIO } from "../src/app/env";
import { appPaths } from "../src/app/store";
import { openDb, SCHEMA_VERSION } from "../src/app/db";

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
  it("布局收缩为 SQLite 单库 + 主密钥（ADR 0008）", () => {
    const p = appPaths(join(root, "data"));
    expect(p.dataRoot).toBe(join(root, "data"));
    expect(p.dbFile).toBe(join(root, "data", "openprism.db"));
    expect(p.secretKeyFile).toBe(join(root, "data", "secret.key"));
  });
});

describe("openDb", () => {
  it("幂等建表；schema_version 写入 meta；重复 open 不抛", () => {
    const db = openDb(join(root, "d3", "openprism.db"));
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));
    const reopened = openDb(join(root, "d3", "openprism.db"));
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[];
    const names = tables.map((t) => t.name);
    db.close(); // Windows：句柄不释放 afterAll 的 rm 会 EBUSY
    reopened.close();
    for (const expected of [
      "users", "sessions", "ledger_entries", "conversations", "conversation_events",
      "agents", "skills", "mcps", "tasks", "task_runs", "notifications",
      "memory_meta", "archives", "meta",
    ]) {
      expect(names).toContain(expected);
    }
    // 遗留七表已删（2026-10-01，schema v2）：新库不再建
    for (const legacy of ["l1_entities", "l1_changes", "l2_entries", "l2_meta", "l3_meta", "memory_slots", "model_config"]) {
      expect(names).not.toContain(legacy);
    }
  });

  it("CHECK 约束生效（账本 kind 词表）", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .prepare("INSERT INTO ledger_entries (uid, seq, kind, ts, source, time, category) VALUES ('u1', 0, 'nope', 1, 'ui', 1, 'x')")
        .run(),
    ).toThrow();
  });
});
