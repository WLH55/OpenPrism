// SessionLog：append / readAll / subscribe（设计 §7.2）。
// 内存实现为默认（测试零依赖）；JSONL 实现走注入的文件 IO；宿主可换任意载体。

import type { FileIO } from "../env";
import type { SessionEvent, SessionEventPayload } from "./events";

export interface SessionLog {
  /** 落一条事件，返回带 seq/ts 的完整事件；持久化实现里这是写穿（崩溃安全的预算恢复依赖它） */
  append(payload: SessionEventPayload, ts?: number): Promise<SessionEvent>;
  readAll(): SessionEvent[];
  subscribe(cb: (event: SessionEvent) => void): () => void;
}

export class InMemorySessionLog implements SessionLog {
  private events: SessionEvent[] = [];
  private nextSeq = 0;
  private listeners = new Set<(event: SessionEvent) => void>();

  constructor(private now: () => number = Date.now) {}

  async append(payload: SessionEventPayload, ts: number = this.now()): Promise<SessionEvent> {
    const event = { ...payload, seq: this.nextSeq++, ts } as SessionEvent;
    this.events.push(event);
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

export class JsonlSessionLog implements SessionLog {
  private events: SessionEvent[] = [];
  private nextSeq = 0;
  private listeners = new Set<(event: SessionEvent) => void>();

  private constructor(
    private fileIO: FileIO,
    private path: string,
    private now: () => number,
  ) {}

  /** 打开（或创建）一份 JSONL 日志；seq 从磁盘上的最后一条续排（崩溃重启不回退） */
  static async open(fileIO: FileIO, path: string, now: () => number = Date.now): Promise<JsonlSessionLog> {
    const log = new JsonlSessionLog(fileIO, path, now);
    let lines: string[] = [];
    try {
      lines = await fileIO.readAll(path);
    } catch {
      // 首次创建：文件不存在
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as SessionEvent;
      log.events.push(event);
      log.nextSeq = Math.max(log.nextSeq, event.seq + 1);
    }
    return log;
  }

  async append(payload: SessionEventPayload, ts: number = this.now()): Promise<SessionEvent> {
    const event = { ...payload, seq: this.nextSeq++, ts } as SessionEvent;
    this.events.push(event);
    await this.fileIO.appendLine(this.path, JSON.stringify(event));
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
