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

export type ContentBlock = TextBlock | ToolCallBlock;

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
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
