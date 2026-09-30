// token 计量·启发式轨（设计 §5.1）：chars/4 + 每内容块 4 + 每消息 role 开销 4。
// 图片按视觉模型的典型单图开销记固定值（base64 字符数不代表 token 数，不能按 chars/4 计）。
// 用于实时压力判断；精确轨是 adapter 归一回来的 usage（账单统计），两者不混用。

import type { ToolPublicSchema } from "../llm/adapter";
import type { Message } from "../types";

export function codePointLength(text: string): number {
  return [...text].length;
}

export function heuristicTextTokens(text: string): number {
  return Math.ceil(codePointLength(text) / 4);
}

/** 单张图片的启发式开销（vision 模型一张中等图片的量级，与字节数无关） */
export const IMAGE_HEURISTIC_TOKENS = 1024;

export function heuristicMessageTokens(message: Message): number {
  let tokens = 4; // 每消息 role 开销
  for (const block of message.content) {
    tokens += 4; // 每内容块
    if (block.type === "text") {
      tokens += heuristicTextTokens(block.text);
    } else if (block.type === "image") {
      tokens += IMAGE_HEURISTIC_TOKENS;
    } else if (block.type === "file") {
      tokens += heuristicTextTokens(block.text);
    } else {
      tokens += heuristicTextTokens(JSON.stringify(block.arguments ?? null));
    }
  }
  return tokens;
}

/** 压力测量对象是"将要发出的请求"：system + 工具表 + 可见历史 */
export function heuristicRequestTokens(system: string, tools: ToolPublicSchema[], messages: Message[]): number {
  let tokens = heuristicTextTokens(system);
  if (tools.length > 0) tokens += heuristicTextTokens(JSON.stringify(tools));
  for (const message of messages) tokens += heuristicMessageTokens(message);
  return tokens;
}
