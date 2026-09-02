// Mock LlmAdapter（设计 §10）：脚本化返回文本/工具调用序列/各 code 失败——测试零网络。

import type { AssistantMessage, Usage } from "../types";
import type { LlmAdapter, LlmCallOptions, LlmRequest, LlmResponse } from "./adapter";
import { llmFailure } from "./errors";

export type MockScriptStep =
  | { kind: "text"; text: string; usage?: Partial<Usage>; finishReason?: string }
  | {
      kind: "tool-calls";
      calls: { id?: string; name: string; arguments?: unknown }[];
      text?: string;
      usage?: Partial<Usage>;
      finishReason?: string;
    }
  | { kind: "failure"; failure: ReturnType<typeof llmFailure> }
  | { kind: "fn"; fn: (request: LlmRequest, options?: LlmCallOptions) => Promise<LlmResponse> };

export interface MockLlmAdapter {
  adapter: LlmAdapter;
  /** 每次 complete 的请求快照（深拷贝），供断言 */
  requests: LlmRequest[];
}

export function createMockLlmAdapter(script: MockScriptStep[]): MockLlmAdapter {
  const requests: LlmRequest[] = [];
  let cursor = 0;
  const adapter: LlmAdapter = {
    name: "mock",
    async complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse> {
      requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
      const step = script[cursor];
      cursor += 1;
      if (!step) throw new Error(`mock script exhausted at call #${cursor}（测试脚本不够长）`);
      if (step.kind === "failure") throw step.failure;
      if (step.kind === "fn") return step.fn(request, options);

      const text = step.kind === "text" ? step.text : (step.text ?? "");
      // 文本分两段派发 delta，模拟流式
      if (text) {
        const mid = Math.ceil([...text].length / 2);
        const cps = [...text];
        options?.onTextDelta?.(cps.slice(0, mid).join(""));
        options?.onTextDelta?.(cps.slice(mid).join(""));
      }
      const calls =
        step.kind === "tool-calls"
          ? step.calls.map((call, index) => ({
              type: "tool_call" as const,
              id: call.id ?? `mock-call-${cursor - 1}-${index}`,
              name: call.name,
              arguments: call.arguments ?? {},
            }))
          : [];
      if (!text && calls.length === 0) {
        throw llmFailure("EMPTY_RESPONSE", "mock step produced no content");
      }
      const message: AssistantMessage = {
        role: "assistant",
        content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
      };
      const usage = step.usage
        ? {
            input: step.usage.input ?? 0,
            output: step.usage.output ?? 0,
            cacheRead: step.usage.cacheRead ?? 0,
            ...(step.usage.cacheWrite !== undefined ? { cacheWrite: step.usage.cacheWrite } : {}),
          }
        : undefined;
      return {
        message,
        usage,
        finishReason: step.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
      };
    },
  };
  return { adapter, requests };
}
