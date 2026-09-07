// ADR 0008·会话日志缝对拍：SqliteSessionLog 与参考实现 JsonlSessionLog 行为等价
// （seq 续排 / append 写穿 / readAll 快照 / subscribe）。

import { describe, expect, it } from "vitest";
import type { FileIO, SessionEvent, SessionEventPayload } from "../src/harness/index";
import { JsonlSessionLog } from "../src/harness/session/log";
import { SqliteSessionLog } from "../src/app/session-log";
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
