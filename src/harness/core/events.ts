// 活体事件流（设计 §9）：text-delta 不落日志，只走这里；其余与日志事件一一对应。

import type { AssistantMessage, ContentBlock, Usage } from "../types";
import type { TurnEndReason } from "../session/events";

export type AgentLiveEvent =
  | { type: "status"; status: "idle" | "running" }
  | { type: "text-delta"; text: string }
  | { type: "assistant"; message: AssistantMessage; usage?: Usage }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; isError: boolean; content: ContentBlock[]; code?: string }
  | { type: "retry"; attempt: number; code: string; delayMs: number }
  | { type: "compaction"; ok: boolean; error?: string }
  | { type: "budget-exhausted"; steps: number }
  | { type: "turn-end"; turn: number; reason: TurnEndReason }
  | { type: "error"; error: string };
