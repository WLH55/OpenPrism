// OpenAI 兼容默认 adapter（设计 §4.3）：覆盖 DeepSeek/GLM/Qwen/Moonshot/OpenRouter。
// SSE 流式（工具调用按 index 跨 chunk 累积、增量 UTF-8 解码防中文截断、流空闲看门狗）+ 非流式。
// fetch 由 PlatformEnv 注入；usage 归一（prompt_tokens 为总输入，缓存命中单列 cacheRead）。

import type { EnvFetchResponse, PlatformEnv } from "../env";
import type { AssistantMessage, Message, ToolCallBlock, Usage } from "../types";
import type { LlmAdapter, LlmCallOptions, LlmRequest, LlmResponse } from "./adapter";
import { isAbortLike, isLlmFailure, llmFailure, looksLikeContextOverflow, looksLikeQuota } from "./errors";
import { IncrementalUtf8Decoder } from "./utf8";

export interface OpenAICompatConfig {
  baseURL: string; // 如 https://api.deepseek.com/v1
  apiKey: string;
  stream?: boolean; // 默认 true
  idleTimeoutMs?: number; // 流空闲看门狗，默认 120_000
  extraHeaders?: Record<string, string>;
}

interface WireMessage {
  role: string;
  content?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toWireMessages(request: LlmRequest): WireMessage[] {
  const out: WireMessage[] = [];
  if (request.system) out.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: textOf(message) });
    } else if (message.role === "assistant") {
      const wire: WireMessage = { role: "assistant", content: textOf(message) };
      const calls = message.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
      if (calls.length > 0) {
        wire.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      out.push(wire);
    } else {
      out.push({ role: "tool", tool_call_id: message.callId, content: textOf(message) });
    }
  }
  return out;
}

function normalizeUsage(raw: any): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const prompt = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
  const completion = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
  const hit =
    typeof raw.prompt_cache_hit_tokens === "number"
      ? raw.prompt_cache_hit_tokens
      : typeof raw.prompt_tokens_details?.cached_tokens === "number"
        ? raw.prompt_tokens_details.cached_tokens
        : 0;
  const write = typeof raw.prompt_cache_write_tokens === "number" ? raw.prompt_cache_write_tokens : undefined;
  return { input: prompt, output: completion, cacheRead: hit, ...(write !== undefined ? { cacheWrite: write } : {}) };
}

function parseArgumentsString(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // 解析失败喂空对象给校验，延续旧 loop.ts 的容错
  }
}

function assembleAssistant(text: string, toolCalls: ToolCallBlock[], reasoning = ""): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) content.push({ type: "text", text });
  content.push(...toolCalls);
  return { role: "assistant", content, ...(reasoning ? { reasoning } : {}) };
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return undefined;
}

async function mapHttpError(response: EnvFetchResponse): Promise<never> {
  const text = await response.text().catch(() => "");
  const status = response.status;
  const fail = (code: Parameters<typeof llmFailure>[0], extra?: { retryAfterMs?: number }) =>
    llmFailure(code, `HTTP ${status}: ${text.slice(0, 500)}`, { status, ...extra });
  if (status === 401) throw fail("AUTH");
  if (status === 402 || looksLikeQuota(text)) throw fail("QUOTA");
  if (status === 403) throw fail("AUTH");
  if (status === 429) {
    throw fail("RATE_LIMIT", { retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) });
  }
  if (status >= 500) throw fail("SERVER");
  if (status === 400 || status === 413) {
    if (looksLikeContextOverflow(text)) throw fail("CONTEXT_WINDOW_EXCEEDED");
    throw fail("INVALID_REQUEST");
  }
  throw fail("INVALID_REQUEST");
}

export function createOpenAICompatAdapter(env: PlatformEnv, config: OpenAICompatConfig): LlmAdapter {
  const useStream = config.stream ?? true;
  const idleTimeoutMs = config.idleTimeoutMs ?? 120_000;
  const url = config.baseURL.replace(/\/+$/, "") + "/chat/completions";

  return {
    name: "openai-compat",
    async complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse> {
      const callerSignal = options?.signal;
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", onCallerAbort);
      }
      try {
        const body: Record<string, any> = {
          model: request.model,
          messages: toWireMessages(request),
        };
        if (request.tools && request.tools.length > 0) {
          body.tools = request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          }));
        }
        if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
        if (useStream) {
          body.stream = true;
          body.stream_options = { include_usage: true };
        }
        let response: EnvFetchResponse;
        try {
          response = await env.fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
              ...config.extraHeaders,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (callerSignal?.aborted || isAbortLike(error)) {
            throw llmFailure("ABORTED", "request aborted");
          }
          throw llmFailure("TRANSPORT", `transport failure: ${String((error as Error)?.message ?? error)}`);
        }
        if (!response.ok) await mapHttpError(response);
        if (!useStream) {
          return parseNonStream(await response.json());
        }
        if (!response.body) {
          throw llmFailure("TRANSPORT", "streaming response has no body");
        }
        return await readStream(response.body, options, callerSignal, controller, idleTimeoutMs);
      } finally {
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

function parseNonStream(json: any): LlmResponse {
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const reasoning =
    typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoning === "string"
        ? message.reasoning
        : "";
  const toolCalls: ToolCallBlock[] = (message.tool_calls ?? []).map((call: any, index: number) => ({
    type: "tool_call" as const,
    id: typeof call?.id === "string" ? call.id : `call-${index}`,
    name: String(call?.function?.name ?? ""),
    arguments: parseArgumentsString(call?.function?.arguments),
  }));
  if (!text && toolCalls.length === 0) {
    throw llmFailure("EMPTY_RESPONSE", "completion finished with no content");
  }
  return {
    message: assembleAssistant(text, toolCalls, reasoning),
    usage: normalizeUsage(json?.usage),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

async function readStream(
  body: NonNullable<EnvFetchResponse["body"]>,
  options: LlmCallOptions | undefined,
  callerSignal: AbortSignal | undefined,
  controller: AbortController,
  idleTimeoutMs: number,
): Promise<LlmResponse> {
  const reader = body.getReader();
  const decoder = new IncrementalUtf8Decoder();
  let buffer = "";
  let text = "";
  let reasoningText = "";
  let finishReason: string | undefined;
  let usage: Usage | undefined;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let sawDone = false;

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    let payload = line.slice(5);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    if (!payload) return;
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // 忽略坏行，流以 chunk 为准
    }
    if (parsed.usage) usage = normalizeUsage(parsed.usage);
    const delta = parsed.choices?.[0]?.delta;
    if (delta) {
      // 思维链增量（DeepSeek 字段 reasoning_content；部分兼容厂商叫 reasoning）
      const reasoningDelta =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : undefined;
      if (reasoningDelta && reasoningDelta.length > 0) {
        reasoningText += reasoningDelta;
        options?.onReasoningDelta?.(reasoningDelta);
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        options?.onTextDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls as any[]) {
          const index = typeof call.index === "number" ? call.index : 0;
          const current = toolAcc.get(index) ?? { id: "", name: "", args: "" };
          if (typeof call.id === "string" && call.id) current.id = call.id;
          if (typeof call.function?.name === "string" && call.function.name) current.name += call.function.name;
          if (typeof call.function?.arguments === "string" && call.function.arguments) {
            current.args += call.function.arguments;
          }
          toolAcc.set(index, current);
        }
      }
    }
    if (typeof parsed.choices?.[0]?.finish_reason === "string") {
      finishReason = parsed.choices[0].finish_reason;
    }
  };

  const pushText = (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  };

  // 流空闲看门狗：单个可重复 reject 的超时 Promise，每个 chunk 重置定时器。
  // 与 reader.read() 竞速；controller.abort()（超时或调用方取消）触发拒绝。
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReject: ((failure: ReturnType<typeof llmFailure>) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });
  const armWatchdog = () => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    if (idleTimeoutMs > 0) {
      watchdogTimer = setTimeout(() => {
        timeoutReject?.(llmFailure("TIMEOUT", `stream idle for over ${idleTimeoutMs}ms`));
        controller.abort();
      }, idleTimeoutMs);
    }
  };
  const onControllerAbort = () => {
    timeoutReject?.(llmFailure("TIMEOUT", `stream idle for over ${idleTimeoutMs}ms`));
  };
  controller.signal.addEventListener("abort", onControllerAbort);

  try {
    for (;;) {
      armWatchdog();
      let readResult: { done: boolean; value?: Uint8Array };
      try {
        readResult = await Promise.race([reader.read(), timeoutPromise]);
      } finally {
        if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      }
      if (readResult.done) break;
      if (readResult.value) pushText(decoder.decode(readResult.value));
    }
    pushText(decoder.flush());
    if (buffer) handleLine(buffer);
  } catch (error) {
    if (callerSignal?.aborted) throw llmFailure("ABORTED", "stream aborted");
    throw isLlmFailure(error)
      ? error
      : llmFailure("TRANSPORT", `stream failure: ${String((error as Error)?.message ?? error)}`);
  } finally {
    controller.signal.removeEventListener("abort", onControllerAbort);
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
  }

  const toolCalls: ToolCallBlock[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({
      type: "tool_call" as const,
      id: acc.id || `call-${acc.name}`,
      name: acc.name,
      arguments: parseArgumentsString(acc.args),
    }));

  if (!text && toolCalls.length === 0) {
    throw llmFailure("EMPTY_RESPONSE", "stream finished with no content");
  }

  return {
    message: assembleAssistant(text, toolCalls, reasoningText),
    usage,
    finishReason,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
