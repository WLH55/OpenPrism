// 通知（D9 首版 = 站内兜底通道）：users/{uid}/notifications.jsonl 追加式；
// 通道缝 = NotifyChannel 数组（微信桥等后续接入，D9.2 双向网关架构位）。

import { join } from "node:path";
import type { FileIO } from "../harness/index";
import type { AppPaths } from "./store";

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
  constructor(private deps: { fileIO: FileIO; paths: AppPaths; now(): number }) {}

  private file(uid: string): string {
    return join(this.deps.paths.userDir(uid), "notifications.jsonl");
  }

  private rowsAsync = new Map<string, Promise<NotificationRow[]>>();

  private load(uid: string): Promise<NotificationRow[]> {
    let cached = this.rowsAsync.get(uid);
    if (!cached) {
      cached = (async () => {
        const rows: NotificationRow[] = [];
        for (const line of await this.deps.fileIO.readAll(this.file(uid))) {
          try {
            const row = JSON.parse(line) as NotificationRow;
            if (typeof row?.seq === "number") rows.push(row);
          } catch {
            // 坏行
          }
        }
        return rows;
      })();
      this.rowsAsync.set(uid, cached);
    }
    return cached;
  }

  async push(uid: string, payload: NotifyPayload): Promise<NotificationRow> {
    const rows = await this.load(uid);
    const row: NotificationRow = {
      seq: rows.reduce((max, r) => Math.max(max, r.seq), -1) + 1,
      ts: this.deps.now(),
      kind: payload.kind,
      ...(payload.taskId !== undefined ? { taskId: payload.taskId } : {}),
      text: payload.text,
    };
    await this.deps.fileIO.appendLine(this.file(uid), JSON.stringify(row));
    rows.push(row);
    return row;
  }

  async list(uid: string, opts?: { unreadOnly?: boolean }): Promise<NotificationRow[]> {
    const rows = await this.load(uid);
    return opts?.unreadOnly ? rows.filter((r) => r.readTs === undefined) : rows;
  }

  async unreadCount(uid: string): Promise<number> {
    return (await this.list(uid, { unreadOnly: true })).length;
  }

  async markRead(uid: string, which: number | "all"): Promise<void> {
    const rows = await this.load(uid);
    const now = this.deps.now();
    let dirty = false;
    for (const row of rows) {
      if (row.readTs === undefined && (which === "all" || row.seq === which)) {
        row.readTs = now;
        dirty = true;
      }
    }
    if (!dirty) return;
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    const file = this.file(uid);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
}

/** 站内通道（永远在线的兜底） */
export function inAppChannel(store: NotificationStore): NotifyChannel {
  return async (uid, payload) => {
    await store.push(uid, payload);
  };
}
