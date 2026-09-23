// 模型可见消息模型（协议中立）：各 adapter 负责映射到自家线上协议（OpenAI 兼容等）。
// tool_result 独立成消息，与 assistant 内的 tool_call 块按 callId 配对——协议合法性由这一配对定义。

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: unknown;
}

/** 图片（多模态输入）：data 为 base64 裸数据（不含 data: 前缀），adapter 拼成自家协议的图片部件 */
export interface ImageBlock {
  type: "image";
  /** MIME 类型，如 image/png */
  mediaType: string;
  /** base64 裸数据 */
  data: string;
}

/** 文本附件（上传的文件）：正文随块入日志，模型与界面都能重建 */
export interface FileBlock {
  type: "file";
  /** 原始文件名 */
  name: string;
  /** MIME 类型，如 text/markdown */
  mediaType: string;
  text: string;
}

export type ContentBlock = TextBlock | ImageBlock | FileBlock | ToolCallBlock;

/** 用户输入的两种写法：纯文本 / 带附件的块序列 */
export type UserContent = string | ContentBlock[];

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  /** 思维链（reasoning 模型输出）：只展示不回传——wire 映射剔除、压力计量不计 */
  reasoning?: string;
  /** 流被中止时已收到的部分内容（设计 §3 abort 保留部分输出） */
  interrupted?: boolean;
}

export interface ToolResultMessage {
  role: "tool_result";
  callId: string;
  isError: boolean;
  content: ContentBlock[];
  /** isError 时的失败码（TOOL_TIMEOUT / TURN_BUDGET / ABORTED_BEFORE_DISPATCH …） */
  code?: string;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export function textBlocksOf(message: Message): TextBlock[] {
  return message.content.filter((b): b is TextBlock => b.type === "text");
}

export function toolCallBlocksOf(message: Message): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
}

export function imageBlocksOf(message: Message): ImageBlock[] {
  return message.content.filter((b): b is ImageBlock => b.type === "image");
}

export function fileBlocksOf(message: Message): FileBlock[] {
  return message.content.filter((b): b is FileBlock => b.type === "file");
}

function fileSection(block: FileBlock): string {
  return `【附件 ${block.name}】\n${block.text}`;
}

/** 文本与附件正文的拼接（不含图片）：adapter 的 wire 文本就用这一份 */
export function plainTextOf(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "file") parts.push(fileSection(block));
  }
  return parts.join("\n");
}

/**
 * 消息的纯文本投影：文本原样、附件正文带文件名抬头并入、图片记为占位符。
 * 供界面显示、会话标题、召回 query、记忆提取等所有"只需要文字"的场合使用。
 */
export function flattenText(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "file") parts.push(fileSection(block));
    else if (block.type === "image") parts.push(`【图片 ${block.mediaType}】`);
  }
  return parts.join("\n");
}

/** 消息里是否带图片（多模态能力拦截用） */
export function hasImageBlocks(message: Message): boolean {
  return message.content.some((b) => b.type === "image");
}

// 精确 usage（账单统计轨，设计 §5.1）：input 为请求总输入（含缓存命中），cacheRead 为命中部分。
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

// 宽松 JSON Schema：工具参数契约与输出契约共用，校验器只解释已知关键字子集。
export interface JsonSchema {
  [key: string]: unknown;
}
