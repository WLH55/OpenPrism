// 登录注册（D2b/ADR 0007）：scrypt 慢哈希 + 常量时间比较；用户注册表 = 追加式 JSONL；
// 会话令牌 = 内存 Map + 注入时钟（自部署单进程语义；重启即全员下线，可接受）。

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FileIO } from "../harness/index";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export interface PasswordRecord {
  salt: string; // hex(16B)
  hash: string; // hex(64B)
}

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

export interface UserRecord {
  uid: string;
  username: string;
  password: PasswordRecord;
  createdTs: number;
}

export async function loadUsers(fileIO: FileIO, usersFile: string): Promise<Map<string, UserRecord>> {
  const map = new Map<string, UserRecord>();
  for (const line of await fileIO.readAll(usersFile)) {
    try {
      const user = JSON.parse(line) as UserRecord;
      if (typeof user?.username === "string") map.set(user.username, user);
    } catch {
      // 崩溃半行：跳过坏行，其余记录照常加载
    }
  }
  return map;
}

export async function appendUser(fileIO: FileIO, usersFile: string, user: UserRecord): Promise<void> {
  await fileIO.appendLine(usersFile, JSON.stringify(user));
}

export interface SessionPersist {
  fileIO: FileIO;
  file: string;
}

interface SessionEventRow {
  op: "issue" | "revoke";
  token: string;
  uid?: string;
  expiresAt?: number;
}

export class SessionStore {
  private sessions = new Map<string, { uid: string; expiresAt: number }>();

  constructor(
    private now: () => number,
    private ttlMs: number = 30 * 24 * 60 * 60 * 1000,
    private persist?: SessionPersist,
  ) {}

  /** 重放事件行恢复（批次4：重启不掉线）；坏行跳过 */
  static async load(persist: SessionPersist, now: () => number, ttlMs?: number): Promise<SessionStore> {
    const store = new SessionStore(now, ttlMs, persist);
    for (const line of await persist.fileIO.readAll(persist.file)) {
      try {
        const row = JSON.parse(line) as SessionEventRow;
        if (row?.op === "issue" && row.token && row.uid !== undefined && row.expiresAt !== undefined) {
          store.sessions.set(row.token, { uid: row.uid, expiresAt: row.expiresAt });
        } else if (row?.op === "revoke" && row.token) {
          store.sessions.delete(row.token);
        }
      } catch {
        // 坏行
      }
    }
    return store;
  }

  private writeEvent(row: SessionEventRow): void {
    if (!this.persist) return;
    // 同步落盘：issue/revoke 是同步 API，持久化不能留竞态窗口（重启前一瞬的签发不丢）
    mkdirSync(dirname(this.persist.file), { recursive: true });
    appendFileSync(this.persist.file, JSON.stringify(row) + "\n", "utf8");
  }

  issue(uid: string): string {
    const token = randomBytes(24).toString("hex"); // 48 hex 字符
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(token, { uid, expiresAt });
    this.writeEvent({ op: "issue", token, uid, expiresAt });
    return token;
  }

  verify(token: string | undefined): string | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return session.uid;
  }

  revoke(token: string): void {
    this.sessions.delete(token);
    this.writeEvent({ op: "revoke", token });
  }
}
