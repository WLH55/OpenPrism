// 批次1·auth：scrypt 慢哈希 + timingSafe 校验 + users/sessions 表（ADR 0008）；时钟注入，无真实计时断言。

import { describe, expect, it } from "vitest";
import {
  appendUser,
  hashPassword,
  loadUsers,
  readUserFace,
  SessionStore,
  updateUserFace,
  verifyPassword,
  type UserRecord,
} from "../src/app/auth";
import { testDb } from "./helpers-db";

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

describe("用户注册表（users 表）", () => {
  it("appendUser/loadUsers 往返，键为用户名，密码可验", async () => {
    const db = testDb();
    const u1: UserRecord = { uid: "uuid-1", username: "lathan", password: await hashPassword("p1"), createdTs: 1000 };
    const u2: UserRecord = { uid: "uuid-2", username: "mike", password: await hashPassword("p2"), createdTs: 2000 };
    appendUser(db, u1);
    appendUser(db, u2);
    const map = await loadUsers(db);
    expect([...map.keys()]).toEqual(["lathan", "mike"]);
    expect(map.get("lathan")?.uid).toBe("uuid-1");
    expect(await verifyPassword("p1", map.get("lathan")!.password)).toBe(true);
  });
});

describe("用户形象（users 表）", () => {
  it("默认空形象 → 保存 emoji/色盘/头像 → 读回一致；空串清空头像", async () => {
    const db = testDb();
    appendUser(db, { uid: "u-1", username: "lathan", password: await hashPassword("p1"), createdTs: 1000 });
    expect(readUserFace(db, "u-1")).toEqual({ avatar: "", emoji: "", color: "" });
    const saved = updateUserFace(db, "u-1", { emoji: "🦊", color: "#b0501e", avatar: "data:image/png;base64,AAAA" });
    expect(saved).toEqual({ avatar: "data:image/png;base64,AAAA", emoji: "🦊", color: "#b0501e" });
    expect(readUserFace(db, "u-1")).toEqual(saved);
    expect(updateUserFace(db, "u-1", { avatar: "" }).avatar).toBe("");
    expect(updateUserFace(db, "u-1", { emoji: "🐳" }).avatar).toBe(""); // 未提的字段不动
  });

  it("非法形象就地抛错：外链头像、坏色盘、超长 emoji、用户不存在", async () => {
    const db = testDb();
    appendUser(db, { uid: "u-2", username: "mike", password: await hashPassword("p2"), createdTs: 2000 });
    expect(() => updateUserFace(db, "u-2", { avatar: "http://evil/a.png" })).toThrow(/data:image/);
    expect(() => updateUserFace(db, "u-2", { color: "red" })).toThrow(/#rrggbb/);
    expect(() => updateUserFace(db, "u-2", { emoji: "🦊".repeat(9) })).toThrow(/emoji 超过/);
    expect(() => updateUserFace(db, "nope", { emoji: "🦊" })).toThrow(/不存在/);
  });

  it("loadUsers 带出形象：重启后头像与 emoji 仍在", async () => {
    const db = testDb();
    appendUser(db, { uid: "u-3", username: "sara", password: await hashPassword("p3"), createdTs: 3000 });
    updateUserFace(db, "u-3", { emoji: "🌙", color: "#3d6b8a" });
    const map = await loadUsers(db);
    expect(map.get("sara")).toMatchObject({ emoji: "🌙", color: "#3d6b8a", avatar: "" });
  });
});

describe("SessionStore（sessions 表）", () => {
  it("issue/verify 往返；令牌 48hex 且互异", () => {
    const s = new SessionStore(testDb(), () => 0);
    const t1 = s.issue("u1");
    const t2 = s.issue("u1");
    expect(t1).toMatch(/^[0-9a-f]{48}$/);
    expect(t1).not.toBe(t2);
    expect(s.verify(t1)).toBe("u1");
  });

  it("到期与撤销返回 null；undefined 令牌返回 null（时钟注入）", () => {
    const db = testDb();
    let now = 0;
    const s = new SessionStore(db, () => now, 1000);
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

  it("持久化（重启不掉线）：同库新实例恢复签发；撤销的仍撤销", () => {
    const db = testDb();
    let now = 0;
    const s1 = new SessionStore(db, () => now, 1000);
    const keep = s1.issue("u1");
    const gone = s1.issue("u2");
    s1.revoke(gone);
    now = 500; // 时间前进但仍在 TTL 内
    const s2 = new SessionStore(db, () => now, 1000);
    expect(s2.verify(keep)).toBe("u1");
    expect(s2.verify(gone)).toBeNull();
  });

  it("issue 顺手清理过期令牌", () => {
    const db = testDb();
    let now = 0;
    const s = new SessionStore(db, () => now, 1000);
    const t = s.issue("u1");
    now = 2000;
    s.issue("u2"); // 触发清理
    const count = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as unknown as { n: number };
    expect(count.n).toBe(1); // 只剩 u2 的新令牌
    expect(s.verify(t)).toBeNull();
  });
});
