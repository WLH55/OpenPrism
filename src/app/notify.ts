// 通知（D9 首版 = 站内兜底通道，ADR 0008 领域表）：notifications 表，(uid, seq) 主键；
// markRead = UPDATE（不再整文件重写）。通道缝 = NotifyChannel 数组（微信桥等后续接入，D9.2 双向网关架构位）。

import type { DatabaseSync } from "node:sqlite";

export interface NotificationRow {
  seq: number;
  ts: number;
  kind: string;
  taskId?: string;
  text: string;
  readTs?: number;
}

export interface NotifyPayload {
  kind: string;
  taskId?: string;
  text: string;
}

export type NotifyChannel = (uid: string, payload: NotifyPayload) => Promise<void>;

export class NotificationStore {
  constructor(private deps: { db: DatabaseSync; now(): number }) {}

  async push(uid: string, payload: NotifyPayload): Promise<NotificationRow> {
    const ts = this.deps.now();
    // seq = 用户内 max+1（INSERT...SELECT 原子取号；单进程下无并发竞争窗口）
    this.deps.db
      .prepare(
        "INSERT INTO notifications (uid, seq, ts, kind, task_id, text) SELECT ?, IFNULL(MAX(seq), -1) + 1, ?, ?, ?, ? FROM notifications WHERE uid = ?",
      )
      .run(uid, ts, payload.kind, payload.taskId ?? null, payload.text, uid);
    const row = this.deps.db
      .prepare("SELECT seq, ts, kind, task_id, text, read_ts FROM notifications WHERE uid = ? ORDER BY seq DESC LIMIT 1")
      .get(uid) as unknown as { seq: number; ts: number; kind: string; task_id: string | null; text: string; read_ts: number | null };
    return {
      seq: row.seq,
      ts: row.ts,
      kind: row.kind,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      text: row.text,
      ...(row.read_ts !== null ? { readTs: row.read_ts } : {}),
    };
  }

  async list(uid: string, opts?: { unreadOnly?: boolean }): Promise<NotificationRow[]> {
    const where = opts?.unreadOnly ? "WHERE uid = ? AND read_ts IS NULL" : "WHERE uid = ?";
    const rows = this.deps.db
      .prepare(`SELECT seq, ts, kind, task_id, text, read_ts FROM notifications ${where} ORDER BY seq`)
      .all(uid) as unknown as { seq: number; ts: number; kind: string; task_id: string | null; text: string; read_ts: number | null }[];
    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      kind: row.kind,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      text: row.text,
      ...(row.read_ts !== null ? { readTs: row.read_ts } : {}),
    }));
  }

  async unreadCount(uid: string): Promise<number> {
    const row = this.deps.db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE uid = ? AND read_ts IS NULL")
      .get(uid) as unknown as { n: number };
    return row.n;
  }

  async markRead(uid: string, which: number | "all"): Promise<void> {
    if (which === "all") {
      this.deps.db.prepare("UPDATE notifications SET read_ts = ? WHERE uid = ? AND read_ts IS NULL").run(this.deps.now(), uid);
      return;
    }
    this.deps.db
      .prepare("UPDATE notifications SET read_ts = ? WHERE uid = ? AND seq = ? AND read_ts IS NULL")
      .run(this.deps.now(), uid, which);
  }
}

/** 站内通道（永远在线的兜底） */
export function inAppChannel(store: NotificationStore): NotifyChannel {
  return async (uid, payload) => {
    await store.push(uid, payload);
  };
}
