// LlmAdapter 接口：harness 对"模型后端"的全部认知就这么多（设计 §4.3）。

import type { AssistantMessage, JsonSchema, Message, Usage } from "../types";

export interface ToolPublicSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmRequest {
  provider: string;
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolPublicSchema[];
  maxTokens?: number;
  /** 提示 adapter 的窗口信息；不参与 request/header 指纹 */
  contextWindow?: number;
}

export interface LlmResponse {
  message: AssistantMessage;
  usage?: Usage;
  /** 原样透传厂商 finish_reason（"stop" / "length" / "tool_calls" …）；"length" 触发 max-tokens 粘性 */
  finishReason?: string;
}

/** embedding 调用（记忆向量召回用）：单段文本 → 一个向量 */
export interface LlmEmbeddingRequest {
  model: string;
  input: string;
}

export interface LlmEmbeddingResponse {
  model: string;
  vector: number[];
}

export interface LlmCallOptions {
  signal?: AbortSignal;
  /** 流式文本增量：只走活体事件流，不落日志（设计 §9） */
  onTextDelta?(delta: string): void;
  /** 思维链增量（reasoning 模型）：同 text-delta，只展示不回传 */
  onReasoningDelta?(delta: string): void;
}

export interface LlmAdapter {
  name: string;
  complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>;
  /** 可选：OpenAI 兼容 /embeddings；仅支持 embedding 的后端实现（错误同样归一 LlmFailure） */
  embed?(request: LlmEmbeddingRequest, options?: LlmCallOptions): Promise<LlmEmbeddingResponse>;
}
