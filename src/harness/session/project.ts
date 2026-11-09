// 投影：从日志推导模型可见历史（Surface，设计 §5/§7）。
// 铁律：model-visible means logged —— 每一条发给模型的消息都能从日志重建（不变量测试守护）。
// 裁剪（压缩阶段一，零成本）在这里恒定生效：对超长 tool/result 文本按规则截断。
// 规则是日志的纯函数，因此"过阈才裁"与"恒定裁剪"对不变量等价，后者不需要额外事件——这是本实现的一个决定。

import type { Message, ToolResultMessage, UserMessage } from "../types";
import { IMAGE_OMITTED_PLACEHOLDER } from "../types";
import type { SessionEvent } from "./events";

export { IMAGE_OMITTED_PLACEHOLDER };

export interface PruneConfig {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
  /** 图片回合窗口（2026-10-17 媒体膨胀治理）：仅最近 N 个回合内的图片进模型上下文，
   * 更早回合的 image 块替换为占位文本（内联与引用形态同样适用）。0 = 全部占位。 */
  imageTurnWindow: number;
}

export const DEFAULT_PRUNE: PruneConfig = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  imageTurnWindow: 2,
};

export const PRUNE_PLACEHOLDER = "[... tool result middle pruned ...]";

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 历史日期锚（2026-11-09 时效可见性）：给用户消息正文注入 〔YYYY-MM-DD 周X〕 行——事件 ts + 时区偏移
 * 的纯 UTC 位移推导（与 persona.dateLine 同口径）。这是投影的确定性推导，日志原文不动（铁律 2 投影路径）。
 * 只锚用户消息（回合起点）：同回合的助手回复与工具结果继承回合日期，不再重复打标。
 * 背景：投影原本剥掉全部时间戳，模型看得见今天几号（末条钟面）却看不见历史对话发生在哪天，
 * 由此凭旧历史误判「今天已完成」并抢答打卡（2026-11-09 真机事故）。 */
function anchorUserMessageDate(event: SessionEvent & { type: "user/message" }, tzOffsetMinutes: number): UserMessage {
  const shifted = new Date(event.ts + tzOffsetMinutes * 60000);
  const date = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
  const line = `〔${date} ${WEEKDAY_NAMES[shifted.getUTCDay()]}〕`;
  const firstText = event.message.content.findIndex((block) => block.type === "text");
  if (firstText === -1) {
    return { ...event.message, content: [{ type: "text", text: line }, ...event.message.content] };
  }
  const content = event.message.content.map((block, index) =>
    index === firstText && block.type === "text" ? { type: "text" as const, text: `${line}\n${block.text}` } : block,
  );
  return { ...event.message, content };
}

function elideImagesOlderThan(items: SurfaceItem[], cutoffSeq: number): void {
  for (const item of items) {
    if (item.seq >= cutoffSeq) continue;
    const { message } = item;
    if (message.role !== "user") continue; // assistant/tool_result 不产图（词表决定），防御性只动 user
    if (!message.content.some((block) => block.type === "image")) continue;
    item.message = {
      ...message,
      content: message.content.map((block) =>
        block.type === "image" ? { type: "text" as const, text: IMAGE_OMITTED_PLACEHOLDER } : block,
      ),
    };
  }
}

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

/** 从日志投影模型可见历史：跳过遮蔽区间、应用裁剪规则；传了 dateAnchorTz 再给每条用户消息注入日期锚 */
export function projectSurface(events: SessionEvent[], prune: PruneConfig = DEFAULT_PRUNE, dateAnchorTz?: number): SurfaceItem[] {
  let items: SurfaceItem[] = [];
  // 回合上下文注入（2026-10-14 前缀缓存稳定化）：只并入最后一条带 context 的用户消息——
  // 历史注入剥离使 wire 至多一个注入块（历史不膨胀），缓存失配点被压在历史尾部（system 与深历史持续命中）。
  // 按 seq 记位（压缩会重建 items，下标不稳）；该消息若被压缩区间吞掉则自然放弃注入。
  let lastContext: { seq: number; text: string } | undefined;
  const turnStartSeqs: number[] = [];
  for (const event of events) {
    if (event.type === "turn/start") turnStartSeqs.push(event.seq);
    switch (event.type) {
      case "user/message":
        items.push({
          seq: event.seq,
          message: dateAnchorTz === undefined ? event.message : anchorUserMessageDate(event, dateAnchorTz),
        });
        if (event.context !== undefined && event.context !== "") lastContext = { seq: event.seq, text: event.context };
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
  // 图片回合窗口（2026-10-17 媒体膨胀治理）：cutoff = 倒数第 imageTurnWindow 个回合边界（turn/start 的 seq），
  // 更早回合的图片换占位——模型回答过老图后不再携带像素，请求体不随历史图片数线性膨胀。
  // 回合数不足窗口 = 全保留（现行为）；窗口 ≤ 0 = 全占位（显式关图片）。
  if (prune.imageTurnWindow <= 0) {
    elideImagesOlderThan(items, Infinity);
  } else if (turnStartSeqs.length > prune.imageTurnWindow) {
    const cutoff = turnStartSeqs[turnStartSeqs.length - prune.imageTurnWindow]!;
    elideImagesOlderThan(items, cutoff);
  }
  if (lastContext !== undefined) {
    const target = items.find((it) => it.seq === lastContext!.seq);
    if (target && target.message.role === "user") {
      target.message = {
        ...target.message,
        content: [{ type: "text", text: `${TURN_CONTEXT_LABEL}\n${lastContext.text}` }, ...target.message.content],
      };
    }
  }
  return items;
}

/** 注入块的固定前缀标签：与用户消息正文区分（正文内出现同串也无妨——按 content 首块结构并入，不依赖标签做解析） */
export const TURN_CONTEXT_LABEL = "〔系统上下文〕";

export function deriveMessages(events: SessionEvent[], prune: PruneConfig = DEFAULT_PRUNE, dateAnchorTz?: number): Message[] {
  return projectSurface(events, prune, dateAnchorTz).map((it) => it.message);
}
