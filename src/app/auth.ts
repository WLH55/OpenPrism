// 登录注册（D2b/ADR 0007/ADR 0008）：scrypt 慢哈希 + 常量时间比较；
// 用户表与会话令牌存 SQLite（users/sessions 表）。会话作废保留行（revoked），审计语义不丢。
// 用户形象（头像/emoji/色盘）同在 users 表，个人资料页读写，校验与伙伴身份共用 avatar.ts。

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateFace } from "./avatar";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function scryptDerive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, salt?: string): Promise<PasswordRecord> {
  const saltHex = salt ?? randomBytes(SALT_LENGTH).toString("hex");
  const key = await scryptDerive(password, Buffer.from(saltHex, "hex"));
  return { salt: saltHex, hash: key.toString("hex") };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const key = await scryptDerive(password, Buffer.from(record.salt, "hex"));
  const expected = Buffer.from(record.hash, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface PasswordRecord {
  salt: string; // hex(16B)
  hash: string; // hex(64B)
}

export interface UserRecord {
  uid: string;
  username: string;
  password: PasswordRecord;
  createdTs: number;
  /** 头像图片 data URL（缺省 = 用 emoji 或用户名首字） */
  avatar?: string;
  emoji?: string;
  color?: string;
  /** 用户档案时区（分钟，UTC+local；2026-09-29）：缺省 = 未上报，装配层退服务器本机 */
  tzOffsetMinutes?: number;
}

/** 时区值校验（±840 分钟 = UTC-14~+14 极值；整数分钟）——profile 写入口与装配兜底共用 */
export function validateTzOffsetMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 840) {
    throw new Error("tzOffsetMinutes 需为不超过 ±840 的整数（分钟）");
  }
  return value;
}

/** 现读用户档案时区（未上报 = undefined，调用方决定兜底） */
export function readUserTz(db: DatabaseSync, uid: string): number | undefined {
  const row = db.prepare("SELECT tz_offset_minutes FROM users WHERE uid = ?").get(uid) as { tz_offset_minutes: number | null } | undefined;
  if (!row) throw new Error(`user "${uid}" 不存在`);
  return row.tz_offset_minutes ?? undefined;
}

/** 用户档案时区落库（校验后写；浏览器自动上报与个人资料页修改共用） */
export function updateUserTz(db: DatabaseSync, uid: string, tz: number): number {
  const valid = validateTzOffsetMinutes(tz);
  const hit = db.prepare("UPDATE users SET tz_offset_minutes = ? WHERE uid = ?").run(valid, uid);
  if (hit.changes === 0) throw new Error(`user "${uid}" 不存在`);
  return valid;
}

/** 用户形象视图（/api/auth/me 与个人资料页共用） */
export interface FaceRecord {
  emoji: string;
  color: string;
  avatar: string;
}

export function faceOf(row: { emoji?: string | null; color?: string | null; avatar?: string | null }): FaceRecord {
  return { emoji: row.emoji ?? "", color: row.color ?? "", avatar: row.avatar ?? "" };
}

/** 现读用户形象（个人资料页首次加载用；用户不存在即抛错） */
export function readUserFace(db: DatabaseSync, uid: string): FaceRecord {
  const row = db.prepare("SELECT avatar, emoji, color FROM users WHERE uid = ?").get(uid) as
    | { avatar: string | null; emoji: string; color: string }
    | undefined;
  if (!row) throw new Error(`user "${uid}" 不存在`);
  return faceOf(row);
}

/** 形象补丁落库（undefined = 不动，"" = 清空）；返回落库后的形象 */
export function updateUserFace(db: DatabaseSync, uid: string, patch: { avatar?: string; emoji?: string; color?: string }): FaceRecord {
  validateFace(patch);
  const row = db.prepare("SELECT avatar, emoji, color FROM users WHERE uid = ?").get(uid) as
    | { avatar: string | null; emoji: string; color: string }
    | undefined;
  if (!row) throw new Error(`user "${uid}" 不存在`);
  const next = {
    avatar: patch.avatar !== undefined ? (patch.avatar === "" ? null : patch.avatar) : row.avatar,
    emoji: patch.emoji !== undefined ? patch.emoji : row.emoji,
    color: patch.color !== undefined ? patch.color : row.color,
  };
  db.prepare("UPDATE users SET avatar = ?, emoji = ?, color = ? WHERE uid = ?").run(next.avatar, next.emoji, next.color, uid);
  return faceOf(next);
}

/** 用户表全量载入（注册表只有几行，非用户数据；注册/登录后写穿 SQL） */
export async function loadUsers(db: DatabaseSync): Promise<Map<string, UserRecord>> {
  const map = new Map<string, UserRecord>();
  const rows = db.prepare("SELECT uid, username, salt, pwd_hash, created_ts, avatar, emoji, color, tz_offset_minutes FROM users").all() as unknown as {
    uid: string;
    username: string;
    salt: string;
    pwd_hash: string;
    created_ts: number;
    avatar: string | null;
    emoji: string;
    color: string;
    tz_offset_minutes: number | null;
  }[];
  for (const row of rows) {
    map.set(row.username, {
      uid: row.uid,
      username: row.username,
      password: { salt: row.salt, hash: row.pwd_hash },
      createdTs: row.created_ts,
      ...faceOf(row),
      ...(row.tz_offset_minutes !== null ? { tzOffsetMinutes: row.tz_offset_minutes } : {}),
    });
  }
  return map;
}

export function appendUser(db: DatabaseSync, user: UserRecord): void {
  db.prepare("INSERT INTO users (uid, username, salt, pwd_hash, created_ts) VALUES (?, ?, ?, ?, ?)").run(
    user.uid,
    user.username,
    user.password.salt,
    user.password.hash,
    user.createdTs,
  );
}

export class SessionStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private ttlMs: number = 30 * 24 * 60 * 60 * 1000,
  ) {}

  issue(uid: string): string {
    const token = randomBytes(24).toString("hex"); // 48 hex 字符
    const expiresAt = this.now() + this.ttlMs;
    this.db.prepare("INSERT INTO sessions (token, uid, expires_at, revoked) VALUES (?, ?, ?, 0)").run(token, uid, expiresAt);
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now()); // 过期令牌顺手清理
    return token;
  }

  verify(token: string | undefined): string | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT uid FROM sessions WHERE token = ? AND revoked = 0 AND expires_at > ?")
      .get(token, this.now()) as unknown as { uid: string } | undefined;
    return row ? row.uid : null;
  }

  revoke(token: string): void {
    this.db.prepare("UPDATE sessions SET revoked = 1 WHERE token = ? AND revoked = 0").run(token);
  }
}
