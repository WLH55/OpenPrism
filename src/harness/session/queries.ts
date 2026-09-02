// 日志查询：从事件流恢复运行时状态（崩溃安全的根源——一切计数都能从日志重放出来）。

import type { RequestHeaderEvent, SessionEvent } from "./events";

export function countTurns(events: SessionEvent[]): number {
  return events.filter((e) => e.type === "turn/start").length;
}

/** 替换代数：compaction/summary 的累计数（单调只进不退，设计 §5.4） */
export function currentGeneration(events: SessionEvent[]): number {
  return events.filter((e) => e.type === "compaction/summary").length;
}

/**
 * 重试预算恢复（设计 §4.2）：末次成功 assistant/message 之后，该 provider+model 的连续 llm/retry 数。
 * 收到成功 assistant 消息即清零；崩溃重启后预算不重置。
 */
export function retryBudgetUsed(events: SessionEvent[], provider: string, model: string): number {
  let used = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant/message") return used;
    if (event.type === "llm/retry" && event.provider === provider && event.model === model) used++;
  }
  return used;
}

export function lastRequestHeader(events: SessionEvent[]): RequestHeaderEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "request/header") return event;
  }
  return undefined;
}
