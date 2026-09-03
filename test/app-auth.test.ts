// 批次1·auth：scrypt 慢哈希 + timingSafe 校验 + 用户注册表 JSONL + 会话令牌（时钟注入，无真实计时断言）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendUser,
  hashPassword,
  loadUsers,
  SessionStore,
  verifyPassword,
  type UserRecord,
} from "../src/app/auth";
import { nodeFileIO } from "../src/app/env";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-auth-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("密码哈希", () => {
  it("同口令不同盐产生不同哈希；同盐可复现", async () => {
    const a = await hashPassword("s3cret!");
    const b = await hashPassword("s3cret!");
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
    const c = await hashPassword("s3cret!", a.salt);
    expect(c.hash).toBe(a.hash);
  });

  it("verifyPassword 正确口令为真、错误口令为假", async () => {
    const record = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", record)).toBe(true);
    expect(await verifyPassword("hunter3", record)).toBe(false);
  });

  it("哈希为 64 字节 hex、盐为 16 字节 hex（scrypt N=16384,r=8,p=1）", async () => {
    const record = await hashPassword("x");
    expect(record.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("用户注册表", () => {
  it("appendUser/loadUsers 往返，键为用户名，密码可验", async () => {
    const usersFile = join(root, "users.jsonl");
    const u1: UserRecord = { uid: "uuid-1", username: "lathan", password: await hashPassword("p1"), createdTs: 1000 };
    const u2: UserRecord = { uid: "uuid-2", username: "mike", password: await hashPassword("p2"), createdTs: 2000 };
    await appendUser(nodeFileIO, usersFile, u1);
    await appendUser(nodeFileIO, usersFile, u2);
    const map = await loadUsers(nodeFileIO, usersFile);
    expect([...map.keys()]).toEqual(["lathan", "mike"]);
    expect(map.get("lathan")?.uid).toBe("uuid-1");
    expect(await verifyPassword("p1", map.get("lathan")!.password)).toBe(true);
  });

  it("坏行跳过（崩溃半行容错），不影响其余记录", async () => {
    const usersFile = join(root, "bad.jsonl");
    await nodeFileIO.appendLine(usersFile, "{broken json");
    const u: UserRecord = { uid: "u", username: "ok", password: await hashPassword("p"), createdTs: 1 };
    await appendUser(nodeFileIO, usersFile, u);
    const map = await loadUsers(nodeFileIO, usersFile);
    expect(map.size).toBe(1);
    expect(map.get("ok")?.uid).toBe("u");
  });
});

describe("SessionStore", () => {
  it("issue/verify 往返；令牌 48hex 且互异", () => {
    const s = new SessionStore(() => 0);
    const t1 = s.issue("u1");
    const t2 = s.issue("u1");
    expect(t1).toMatch(/^[0-9a-f]{48}$/);
    expect(t1).not.toBe(t2);
    expect(s.verify(t1)).toBe("u1");
  });

  it("到期与撤销返回 null；undefined 令牌返回 null（时钟注入）", () => {
    let now = 0;
    const s = new SessionStore(() => now, 1000);
    const t = s.issue("u1");
    now = 999;
    expect(s.verify(t)).toBe("u1");
    now = 1000;
    expect(s.verify(t)).toBeNull();
    const t2 = s.issue("u2");
    s.revoke(t2);
    expect(s.verify(t2)).toBeNull();
    expect(s.verify(undefined)).toBeNull();
  });
});
