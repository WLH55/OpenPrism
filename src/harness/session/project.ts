// 投影：从日志推导模型可见历史（Surface，设计 §5/§7）。
// 铁律：model-visible means logged —— 每一条发给模型的消息都能从日志重建（不变量测试守护）。
// 裁剪（压缩阶段一，零成本）在这里恒定生效：对超长 tool/result 文本按规则截断。
// 规则是日志的纯函数，因此"过阈才裁"与"恒定裁剪"对不变量等价，后者不需要额外事件——这是本实现的一个决定。

import type { Message, ToolResultMessage, UserMessage } from "../types";
import type { SessionEvent } from "./events";

export interface PruneConfig {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

export const DEFAULT_PRUNE: PruneConfig = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
};

export const PRUNE_PLACEHOLDER = "[... tool result middle pruned ...]";

export interface SurfaceItem {
  seq: number;
  message: Message;
}

function codePointLength(text: string): number {
  return [...text].length;
}

function pruneToolResult(message: ToolResultMessage, cfg: PruneConfig): ToolResultMessage {
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "text") return block;
    const cps = [...block.text];
    if (cps.length <= cfg.thresholdChars) return block;
    changed = true;
    const text =
      cps.slice(0, cfg.headChars).join("") +
      "\n" +
      PRUNE_PLACEHOLDER +
      "\n" +
      cps.slice(cps.length - cfg.tailChars).join("");
    return { type: "text" as const, text };
  });
  return changed ? { ...message, content } : message;
}

export function summaryCheckpointMessage(summary: string): UserMessage {
  return { role: "user", content: [{ type: "text", text: summary }] };
}

/** 从日志投影模型可见历史：跳过遮蔽区间、应用裁剪规则 */
export function projectSurface(events: SessionEvent[], prune: PruneConfig = DEFAULT_PRUNE): SurfaceItem[] {
  let items: SurfaceItem[] = [];
  for (const event of events) {
    switch (event.type) {
      case "user/message":
        items.push({ seq: event.seq, message: event.message });
        break;
      case "assistant/message":
        items.push({ seq: event.seq, message: event.message });
        break;
      case "tool/result":
        items.push({
          seq: event.seq,
          message: pruneToolResult(
            {
              role: "tool_result",
              callId: event.id,
              isError: event.isError,
              content: event.content,
              ...(event.code !== undefined ? { code: event.code } : {}),
            },
            prune,
          ),
        });
        break;
      case "compaction/summary": {
        // 遮蔽区间内条目整体丢弃，checkpoint 摘要消息落在区间起点位置
        const [start, end] = event.shadowed;
        const kept = items.filter((it) => it.seq < start || it.seq > end);
        let insertAt = kept.length;
        for (let i = 0; i < kept.length; i++) {
          if (kept[i]!.seq > start) {
            insertAt = i;
            break;
          }
        }
        kept.splice(insertAt, 0, { seq: start, message: summaryCheckpointMessage(event.summary) });
        items = kept;
        break;
      }
      default:
        // turn/*、llm/retry、request/header、tool/call（执行记录）不进入模型可见历史
        break;
    }
  }
  return items;
}

export function deriveMessages(events: SessionEvent[], prune: PruneConfig = DEFAULT_PRUNE): Message[] {
  return projectSurface(events, prune).map((it) => it.message);
}
