// 账本（D2 数据原语 + ADR 0008）：ledger_entries 表只追加（(uid, seq) 主键）；
// 单进程串行写队列（并行对话、串行账本追加）；按 uid 懒加载进内存缓存；面板 = 确定性折叠。
// 结构定死、内容自由：kind/time/value/plan-ref/checkin 状态是骨架，category/note/attrs 随意。
// 更正回路 = void 事件引用 targetSeq，不原地改写（历史永远可审计）。

import type { DatabaseSync } from "node:sqlite";

export type LedgerSource = "agent" | "ui";

export interface LedgerActor {
  conversationId?: string;
  agentName?: string;
}

interface LedgerEventBase {
  seq: number;
  ts: number;
  source: LedgerSource;
  actor?: LedgerActor;
}

/** 流水：记"发生了什么"（花钱、运动、心情……分类自由） */
export interface FlowRecord extends LedgerEventBase {
  kind: "event";
  time: number;
  category: string;
  note?: string;
  value?: number;
  unit?: string;
  attrs?: Record<string, string | number>;
}

/** 计划：今日/本周/本月/今年/最近 N 天/带截止日 */
export interface PlanRecord extends LedgerEventBase {
  kind: "plan";
  planId: string;
  title: string;
  scope: "day" | "week" | "month" | "year" | "ndays" | "deadline";
  due?: string; // YYYY-MM-DD（scope=deadline 必填）
  ndays?: number; // scope=ndays 必填
}

/** 打卡：认证"计划做了没"（引用 planId，不与流水混同） */
export interface CheckinRecord extends LedgerEventBase {
  kind: "checkin";
  planId: string;
  at: number;
  done: boolean;
}

/** 作废：更正回路——引用目标 seq，折叠层剔除、审计层保留 */
export interface VoidRecord extends LedgerEventBase {
  kind: "void";
  targetSeq: number;
  reason?: string;
}

export type LedgerRecord = FlowRecord | PlanRecord | CheckinRecord | VoidRecord;

/** appender 视角（seq/ts 由账本分配）；联合逐成员 Omit，保留各自判别字段 */
export type LedgerAppend =
  | Omit<FlowRecord, "seq" | "ts">
  | Omit<PlanRecord, "seq" | "ts">
  | Omit<CheckinRecord, "seq" | "ts">
  | Omit<VoidRecord, "seq" | "ts">;

/** 单条落库（迁移器复用）：kind 判别列 → 各自专有列 */
export function insertLedgerRecord(db: DatabaseSync, uid: string, record: LedgerRecord): void {
  const actor = record.actor;
  const actorConv = actor?.conversationId ?? null;
  const actorAgent = actor?.agentName ?? null;
  switch (record.kind) {
    case "event":
      db.prepare(
        "INSERT INTO ledger_entries (uid, seq, kind, ts, source, actor_conv, actor_agent, time, category, note, value, unit, attrs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        uid,
        record.seq,
        record.kind,
        record.ts,
        record.source,
        actorConv,
        actorAgent,
        record.time,
        record.category,
        record.note ?? null,
        record.value ?? null,
        record.unit ?? null,
        record.attrs ? JSON.stringify(record.attrs) : null,
      );
      break;
    case "plan":
      db.prepare(
        "INSERT INTO ledger_entries (uid, seq, kind, ts, source, actor_conv, actor_agent, plan_id, title, scope, due, ndays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        uid,
        record.seq,
        record.kind,
        record.ts,
        record.source,
        actorConv,
        actorAgent,
        record.planId,
        record.title,
        record.scope,
        record.due ?? null,
        record.ndays ?? null,
      );
      break;
    case "checkin":
      db.prepare(
        "INSERT INTO ledger_entries (uid, seq, kind, ts, source, actor_conv, actor_agent, checkin_plan_id, at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        uid,
        record.seq,
        record.kind,
        record.ts,
        record.source,
        actorConv,
        actorAgent,
        record.planId,
        record.at,
        record.done ? 1 : 0,
      );
      break;
    case "void":
      db.prepare(
        "INSERT INTO ledger_entries (uid, seq, kind, ts, source, actor_conv, actor_agent, target_seq, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(uid, record.seq, record.kind, record.ts, record.source, actorConv, actorAgent, record.targetSeq, record.reason ?? null);
      break;
  }
}

type LedgerRow = {
  kind: string;
  seq: number;
  ts: number;
  source: string;
  actor_conv: string | null;
  actor_agent: string | null;
  time: number | null;
  category: string | null;
  note: string | null;
  value: number | null;
  unit: string | null;
  attrs_json: string | null;
  plan_id: string | null;
  title: string | null;
  scope: string | null;
  due: string | null;
  ndays: number | null;
  checkin_plan_id: string | null;
  at: number | null;
  done: number | null;
  target_seq: number | null;
  reason: string | null;
};

/** 行 → 记录：与旧 JSON 透传同构（缺省键不出现，fold 层零感知） */
function rowToRecord(row: LedgerRow): LedgerRecord | null {
  const base = {
    seq: row.seq,
    ts: row.ts,
    source: row.source as LedgerSource,
    ...(row.actor_conv !== null || row.actor_agent !== null
      ? {
          actor: {
            ...(row.actor_conv !== null ? { conversationId: row.actor_conv } : {}),
            ...(row.actor_agent !== null ? { agentName: row.actor_agent } : {}),
          },
        }
      : {}),
  };
  switch (row.kind) {
    case "event":
      return {
        ...base,
        kind: "event",
        time: row.time ?? row.ts,
        category: row.category ?? "",
        ...(row.note !== null ? { note: row.note } : {}),
        ...(row.value !== null ? { value: row.value } : {}),
        ...(row.unit !== null ? { unit: row.unit } : {}),
        ...(row.attrs_json !== null ? { attrs: JSON.parse(row.attrs_json) as Record<string, string | number> } : {}),
      };
    case "plan":
      return {
        ...base,
        kind: "plan",
        planId: row.plan_id ?? "",
        title: row.title ?? "",
        scope: (row.scope ?? "day") as PlanRecord["scope"],
        ...(row.due !== null ? { due: row.due } : {}),
        ...(row.ndays !== null ? { ndays: row.ndays } : {}),
      };
    case "checkin":
      return {
        ...base,
        kind: "checkin",
        planId: row.checkin_plan_id ?? "",
        at: row.at ?? row.ts,
        done: row.done === 1,
      };
    case "void":
      return {
        ...base,
        kind: "void",
        targetSeq: row.target_seq ?? -1,
        ...(row.reason !== null ? { reason: row.reason } : {}),
      };
    default:
      return null; // 未知 kind（向前兼容）：跳过
  }
}

export class Ledger {
  private records: LedgerRecord[] = [];
  private nextSeq = 0;
  private queue: Promise<unknown> = Promise.resolve(); // 串行写队列：并发 append 不交错

  private constructor(
    private db: DatabaseSync,
    private uid: string,
  ) {}

  /** 按用户懒加载：SELECT 全部行映射为记录（账本小，折叠层契约不变） */
  static async open(db: DatabaseSync, uid: string): Promise<Ledger> {
    const ledger = new Ledger(db, uid);
    const rows = db.prepare("SELECT * FROM ledger_entries WHERE uid = ? ORDER BY seq").all(uid) as unknown as LedgerRow[];
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record === null) continue;
      ledger.records.push(record);
      ledger.nextSeq = Math.max(ledger.nextSeq, record.seq + 1);
    }
    return ledger;
  }

  append(record: LedgerAppend, ts: number = Date.now()): Promise<LedgerRecord> {
    const run = async (): Promise<LedgerRecord> => {
      const full = { ...record, seq: this.nextSeq++, ts } as LedgerRecord;
      this.records.push(full);
      insertLedgerRecord(this.db, this.uid, full);
      return full;
    };
    const appended = this.queue.then(run, run); // 前序失败也继续（队列不因单条失败卡死）
    this.queue = appended.catch(() => undefined);
    return appended;
  }

  readAll(): LedgerRecord[] {
    return [...this.records];
  }

  /** 折叠入口：剔除被 void 的目标与 void 记录本身 */
  activeRecords(): LedgerRecord[] {
    const voided = new Set<number>();
    for (const record of this.records) {
      if (record.kind === "void") voided.add(record.targetSeq);
    }
    return this.records.filter((record) => record.kind !== "void" && !voided.has(record.seq));
  }
}
