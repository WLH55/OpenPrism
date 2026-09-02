// 会话日志九事件词表（设计 §7.1，消息粒度）。
// 刻意不记：assistant/chunk（流式动画还原不值手机写盘成本）、step/start|end（可从消息序列推导）。

import type { AssistantMessage, ContentBlock, Usage, UserMessage } from "../types";

export type TurnEndReason =
  | "completed"
  | "blocked" // 保留码：当前无审批门，暂不会产生（ADR 0006 排除了 intent gate）
  | "max-tokens"
  | "aborted"
  | "error"
  | "budget-exhausted";

export type InputChannel = "followup" | "steer" | "inject";

export interface TurnStartEvent {
  type: "turn/start";
  turn: number;
}

export interface TurnEndEvent {
  type: "turn/end";
  turn: number;
  reason: TurnEndReason;
}

export interface UserMessageEvent {
  type: "user/message";
  channel: InputChannel;
  message: UserMessage;
}

export interface AssistantMessageEvent {
  type: "assistant/message";
  message: AssistantMessage;
  usage?: Usage;
}

export interface ToolCallEvent {
  type: "tool/call";
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultEvent {
  type: "tool/result";
  id: string;
  isError: boolean;
  content: ContentBlock[];
  code?: string;
}

export interface LlmRetryEvent {
  type: "llm/retry";
  provider: string;
  model: string;
  attempt: number;
  code: string;
  delayMs: number;
}

export interface CompactionSummaryEvent {
  type: "compaction/summary";
  /** 被遮蔽区间（含端点的 seq 闭区间） */
  shadowed: [number, number];
  summary: string;
  /** 替换代数：第几次区间替换（单调只进不退，溢出恢复的闸门） */
  generation: number;
}

export interface RequestHeaderEvent {
  type: "request/header";
  provider: string;
  model: string;
  systemFingerprint: string;
  toolsFingerprint: string;
}

export type SessionEventPayload =
  | TurnStartEvent
  | TurnEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | LlmRetryEvent
  | CompactionSummaryEvent
  | RequestHeaderEvent;

export type SessionEvent = SessionEventPayload & {
  /** 日志序号，append 时分配，从 0 单调递增 */
  seq: number;
  ts: number;
};
