// SQLite 版会话日志（ADR 0008）：实现 harness 的 SessionLog 缝（宿主可换任意载体）。
// 九事件完整原文落 conversation_events（cid+seq 唯一）；seq 从库里最后一条续排（崩溃重启不回退）。
// cid 约定：聊天会话 = cid；任务专属会话 = "task:<taskId>"。
// 图片分离（2026-10-17 媒体膨胀治理）：user/message 里 image 块的 base64 在落库前抽到
// conversation_blobs（内容寻址），事件（内存缓存与磁盘一致）只留 blobRef 引用——
// 单会话不再随图片数线性膨胀（生产实测曾达 29MB）；回填入口见 conversations.ts hydrateImageRefs。

import type { DatabaseSync } from "node:sqlite";
import type { SessionEvent, SessionEventPayload, SessionLog } from "../harness/index";
import { storeImageBlob } from "./db";

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
    this.extractImages(event);
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

  /** 落库前把内联图片抽到 blobs 表，事件里留 blobRef（内存与磁盘同一形态）。
   * 只处理 user/message：词表上 assistant/tool_result 不产图；附件块由 attachments 管线构造。 */
  private extractImages(event: SessionEvent): void {
    if (event.type !== "user/message") return;
    const content = event.message.content;
    if (!content.some((block) => block.type === "image" && block.data !== undefined)) return;
    event.message = {
      ...event.message,
      content: content.map((block) => {
        if (block.type !== "image" || block.data === undefined) return block;
        const bytes = Buffer.from(block.data, "base64");
        const ref = storeImageBlob(this.db, bytes, block.mediaType, event.ts);
        return { type: "image" as const, mediaType: block.mediaType, blobRef: ref };
      }),
    };
  }

  readAll(): SessionEvent[] {
    return [...this.events];
  }

  subscribe(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
