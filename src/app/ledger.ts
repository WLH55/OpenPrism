// 账本（D2 数据原语 + D2b 存储裁决）：users/{uid}/life.jsonl 只追加；
// 单进程串行写队列（并行对话、串行账本追加）；启动全量载入内存；面板 = 确定性折叠。
// 结构定死、内容自由：kind/time/value/plan-ref/checkin 状态是骨架，category/note/attrs 随意。
// 更正回路 = void 事件引用 targetSeq，不原地改写（历史永远可审计）。

import type { FileIO } from "../harness/index";

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

export class Ledger {
  private records: LedgerRecord[] = [];
  private nextSeq = 0;
  private queue: Promise<unknown> = Promise.resolve(); // 串行写队列：并发 append 不交错

  private constructor(
    private fileIO: FileIO,
    private path: string,
  ) {}

  static async open(fileIO: FileIO, path: string): Promise<Ledger> {
    const ledger = new Ledger(fileIO, path);
    for (const line of await fileIO.readAll(path)) {
      try {
        const record = JSON.parse(line) as LedgerRecord;
        if (typeof record?.seq !== "number") continue;
        ledger.records.push(record);
        ledger.nextSeq = Math.max(ledger.nextSeq, record.seq + 1);
      } catch {
        // 崩溃半行：跳过坏行
      }
    }
    return ledger;
  }

  append(record: LedgerAppend, ts: number = Date.now()): Promise<LedgerRecord> {
    const run = async (): Promise<LedgerRecord> => {
      const full = { ...record, seq: this.nextSeq++, ts } as LedgerRecord;
      this.records.push(full);
      await this.fileIO.appendLine(this.path, JSON.stringify(full));
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
