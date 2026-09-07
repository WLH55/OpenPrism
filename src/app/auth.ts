// 登录注册（D2b/ADR 0007/ADR 0008）：scrypt 慢哈希 + 常量时间比较；
// 用户表与会话令牌存 SQLite（users/sessions 表）。会话作废保留行（revoked），审计语义不丢。

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
}

/** 用户表全量载入（注册表只有几行，非用户数据；注册/登录后写穿 SQL） */
export async function loadUsers(db: DatabaseSync): Promise<Map<string, UserRecord>> {
  const map = new Map<string, UserRecord>();
  const rows = db.prepare("SELECT uid, username, salt, pwd_hash, created_ts FROM users").all() as unknown as {
    uid: string;
    username: string;
    salt: string;
    pwd_hash: string;
    created_ts: number;
  }[];
  for (const row of rows) {
    map.set(row.username, {
      uid: row.uid,
      username: row.username,
      password: { salt: row.salt, hash: row.pwd_hash },
      createdTs: row.created_ts,
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
