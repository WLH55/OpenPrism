// SQLite 版会话日志（ADR 0008）：实现 harness 的 SessionLog 缝（宿主可换任意载体）。
// 九事件完整原文落 conversation_events（cid+seq 唯一）；seq 从库里最后一条续排（崩溃重启不回退）。
// cid 约定：聊天会话 = cid；任务专属会话 = "task:<taskId>"。

import type { DatabaseSync } from "node:sqlite";
import type { SessionEvent, SessionEventPayload, SessionLog } from "../harness/index";

export class SqliteSessionLog implements SessionLog {
  private events: SessionEvent[] = [];
  private nextSeq = 0;
  private listeners = new Set<(event: SessionEvent) => void>();

  private constructor(
    private db: DatabaseSync,
    private key: string,
    private now: () => number,
  ) {}

  /** 打开（或创建）一份会话日志；seq 从库里的最后一条续排 */
  static open(db: DatabaseSync, key: string, now: () => number = Date.now): SqliteSessionLog {
    const log = new SqliteSessionLog(db, key, now);
    const rows = db.prepare("SELECT event_json FROM conversation_events WHERE cid = ? ORDER BY seq").all(key) as unknown as {
      event_json: string;
    }[];
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as SessionEvent;
      log.events.push(event);
      log.nextSeq = Math.max(log.nextSeq, event.seq + 1);
    }
    return log;
  }

  async append(payload: SessionEventPayload, ts: number = this.now()): Promise<SessionEvent> {
    const event = { ...payload, seq: this.nextSeq++, ts } as SessionEvent;
    this.events.push(event);
    this.db
      .prepare(
        "INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.key,
        event.seq,
        event.type,
        event.ts,
        event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : null,
        JSON.stringify(event),
      );
    for (const cb of this.listeners) cb(event);
    return event;
  }

  readAll(): SessionEvent[] {
    return [...this.events];
  }

  subscribe(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
