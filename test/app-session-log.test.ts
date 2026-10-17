// ADR 0008·会话日志缝对拍：SqliteSessionLog 与参考实现 JsonlSessionLog 行为等价
// （seq 续排 / append 写穿 / readAll 快照 / subscribe）。

import { describe, expect, it } from "vitest";
import type { FileIO, SessionEvent, SessionEventPayload } from "../src/harness/index";
import { JsonlSessionLog } from "../src/harness/session/log";
import { SqliteSessionLog } from "../src/app/session-log";
import { migrateInlineImages } from "../src/app/db";
import { testDb } from "./helpers-db";

const PAYLOAD = (n: number): SessionEventPayload =>
  ({ type: "user/message", channel: "followup", message: { role: "user", content: [{ type: "text", text: `消息${n}` }] } });

/** 内存 FileIO（JsonlSessionLog 参考实现用） */
function memoryFileIO(): FileIO {
  const files = new Map<string, string[]>();
  return {
    async appendLine(path, line) {
      const lines = files.get(path) ?? [];
      lines.push(line);
      files.set(path, lines);
    },
    async readAll(path) {
      return [...(files.get(path) ?? [])];
    },
  };
}

describe("SqliteSessionLog 与 JsonlSessionLog 对拍", () => {
  it("append 分配 seq/ts、readAll 快照、subscribe 通知——两种实现等价", async () => {
    const db = testDb();
    const sqlite = SqliteSessionLog.open(db, "c1", () => 1000);
    const jsonl = await JsonlSessionLog.open(memoryFileIO(), "c1", () => 1000);

    const seen: SessionEvent[] = [];
    sqlite.subscribe((e) => seen.push(e));

    const e1 = await sqlite.append(PAYLOAD(1));
    const e2 = await sqlite.append(PAYLOAD(2), 2000);
    expect(e1.seq).toBe(0);
    expect(e1.ts).toBe(1000);
    expect(e2.seq).toBe(1);
    expect(e2.ts).toBe(2000);
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
    expect(sqlite.readAll().map((e) => e.seq)).toEqual([0, 1]);

    await jsonl.append(PAYLOAD(1));
    const j2 = await jsonl.append(PAYLOAD(2), 2000);
    expect(j2.seq).toBe(1);
    expect(jsonl.readAll().map((e) => e.seq)).toEqual([0, 1]);
    expect(sqlite.readAll().map((e) => e.type)).toEqual(jsonl.readAll().map((e) => e.type));
  });

  it("重开（同库新实例）从库里续排 seq，事件完整恢复（崩溃重启不回退）", async () => {
    const db = testDb();
    const first = SqliteSessionLog.open(db, "c1", () => 1);
    await first.append(PAYLOAD(1));
    await first.append(PAYLOAD(2));

    const reopened = SqliteSessionLog.open(db, "c1", () => 2);
    const next = await reopened.append(PAYLOAD(3));
    expect(next.seq).toBe(2);
    expect(reopened.readAll()).toHaveLength(3);

    // 按不同 key 隔离
    const other = SqliteSessionLog.open(db, "c2", () => 1);
    expect(other.readAll()).toHaveLength(0);
    const taskLog = SqliteSessionLog.open(db, "task:tid-1", () => 1);
    expect(taskLog.readAll()).toHaveLength(0);
  });
});

// ── 图片分离（2026-10-17 媒体膨胀治理）──
// append 抽图：user/message 的内联 base64 落 blobs 表，事件（内存与磁盘一致）只留 blobRef；
// 存量迁移 migrateInlineImages 幂等：手写内联事件行 → 引用形态，再跑 no-op。

describe("图片分离：append 抽图与存量迁移", () => {
  const PNG = "iVBORw0KGgo="; // 任意合法 base64（内容不校验，仅形态）

  it("append 抽图：事件引用形态落库 + blobs 行可取回原字节（内存与磁盘一致）", async () => {
    const db = testDb();
    const log = SqliteSessionLog.open(db, "c-img");
    await log.append({
      type: "user/message",
      channel: "followup",
      message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", data: PNG }] },
    });

    const events = log.readAll();
    const imageBlock = (events[0] as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content[1]!;
    expect(imageBlock["type"]).toBe("image");
    expect(imageBlock["data"]).toBeUndefined();
    expect(typeof imageBlock["blobRef"]).toBe("string");

    const disk = JSON.parse(
      (db.prepare("SELECT event_json FROM conversation_events WHERE cid = ?").get("c-img") as unknown as { event_json: string }).event_json,
    ) as { message: { content: Array<Record<string, unknown>> } };
    expect(disk.message.content[1]).toEqual(imageBlock); // 磁盘与内存同形态

    const blob = db.prepare("SELECT media_type, data FROM conversation_blobs WHERE ref = ?").get(imageBlock["blobRef"] as string) as unknown as { media_type: string; data: Uint8Array };
    expect(blob.media_type).toBe("image/png");
    expect(Buffer.from(blob.data).toString("base64")).toBe(PNG);
  });

  it("同图两次 append 只存一份 blob（内容寻址去重）；文本附件不受影响", async () => {
    const db = testDb();
    const log = SqliteSessionLog.open(db, "c-dedup");
    await log.append({ type: "user/message", channel: "followup", message: { role: "user", content: [{ type: "image", mediaType: "image/png", data: PNG }] } });
    await log.append({ type: "user/message", channel: "followup", message: { role: "user", content: [{ type: "file", name: "a.md", mediaType: "text/markdown", text: "正文" }] } });
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_blobs").get() as unknown as { n: number }).n).toBe(1);
    const fileBlock = (log.readAll()[1] as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content[0]!;
    expect(fileBlock["text"]).toBe("正文");
  });

  it("migrateInlineImages：存量内联事件 → 引用形态；幂等再跑 no-op", () => {
    const db = testDb();
    // 手写一条内联图片事件（模拟旧版本落库形态）
    db.prepare("INSERT INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      "c-legacy",
      0,
      "user/message",
      0,
      "user",
      JSON.stringify({ type: "user/message", channel: "followup", seq: 0, ts: 0, message: { role: "user", content: [{ type: "image", mediaType: "image/png", data: PNG }] } }),
    );
    migrateInlineImages(db);

    const row = JSON.parse((db.prepare("SELECT event_json FROM conversation_events WHERE cid = ?").get("c-legacy") as unknown as { event_json: string }).event_json) as {
      message: { content: Array<Record<string, unknown>> };
    };
    const block = row.message.content[0]!;
    expect(block["data"]).toBeUndefined();
    const ref = block["blobRef"] as string;
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_blobs").get() as unknown as { n: number }).n).toBe(1);
    expect(Buffer.from((db.prepare("SELECT data FROM conversation_blobs WHERE ref = ?").get(ref) as unknown as { data: Uint8Array }).data).toString("base64")).toBe(PNG);

    // 幂等：再跑无内联可搬
    const before = db.prepare("SELECT event_json FROM conversation_events WHERE cid = ?").get("c-legacy") as unknown as { event_json: string };
    migrateInlineImages(db);
    const after = db.prepare("SELECT event_json FROM conversation_events WHERE cid = ?").get("c-legacy") as unknown as { event_json: string };
    expect(after.event_json).toBe(before.event_json);
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_blobs").get() as unknown as { n: number }).n).toBe(1);
  });
});
