// 循环机器（设计 §3/§8/§9）：kick → turn → step 三层状态机。
// kick：Inbox 有待处理就开新 Turn；turn：turn/start → … → turn/end{reason}；step：一次模型请求 + 其全部工具调用。
// Inbox 三通道：followup（唤醒、开新 Turn）/ steer（唤醒、插入当前 Turn 下一步）/ inject（不唤醒、捎带）。
// abort 保留部分输出；Turn Budget 用尽补合成 isError（TURN_BUDGET）；max-tokens 粘性；
// turn-stopping 检查点为可选串行回调；请求组装经 onRequest 拦截、指纹变更落 request/header。

import { compactConversation, DEFAULT_COMPACTION, type CompactOptions, type CompactionConfig, type CompactResult } from "../context/compact";
import { heuristicRequestTokens } from "../context/meter";
import type { PlatformEnv } from "../env";
import type { LlmAdapter, LlmRequest, LlmResponse } from "../llm/adapter";
import { isLlmFailure } from "../llm/errors";
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from "../retry/retry";
import type { InputChannel, TurnEndReason } from "../session/events";
import { InMemorySessionLog, type SessionLog } from "../session/log";
import { projectSurface } from "../session/project";
import { countTurns, currentGeneration, lastRequestHeader, retryBudgetUsed } from "../session/queries";
import type { AssistantMessage, ContentBlock, ToolCallBlock, UserContent, UserMessage } from "../types";
import { fnv1a } from "../util";
import { runToolCalls } from "../tools/pipeline";
import { ToolRegistry, type ToolDefinition } from "../tools/registry";
import type { AgentLiveEvent } from "./events";

export interface AgentModelConfig {
  provider: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface AgentConfig {
  env: PlatformEnv;
  sessionLog?: SessionLog;
  adapter: LlmAdapter;
  model: AgentModelConfig;
  /** 每 step 重取（无启动快照过期，设计 §8） */
  systemPrompt: () => string;
  tools?: ToolDefinition[];
  /** Turn Budget 默认 32；Infinity = dsh 行为（设计 §12 差异 3） */
  maxStepsPerTurn?: number;
  retry?: Partial<RetryPolicy>;
  compaction?: Partial<CompactionConfig>;
  /** 请求拦截点：可改路由（无头场景换便宜模型不动循环） */
  onRequest?: (request: LlmRequest) => LlmRequest;
  /** Turn 自然停止前串行回调（无瀑布） */
  onTurnStopping?(context: { reason: TurnEndReason; turn: number }): void | Promise<void>;
}

export interface Agent {
  readonly status: "idle" | "running";
  readonly sessionLog: SessionLog;
  /** 唤醒并开新 Turn；text 走纯文本，块序列走多模态输入（图片/附件） */
  followup(input: UserContent): void;
  steer(text: string): void;
  inject(text: string): void;
  /** 中止当前 Turn；默认清 Inbox */
  cancel(options?: { clearInbox?: boolean }): void;
  whenIdle(): Promise<void>;
  /** 手动压缩（要求 idle，设计 §12 差异 6） */
  compact(): Promise<void>;
  subscribe(cb: (event: AgentLiveEvent) => void): () => void;
}

interface InboxItem {
  content: ContentBlock[];
}

function userContent(input: UserContent): ContentBlock[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}

function userMessage(content: ContentBlock[]): UserMessage {
  return { role: "user", content };
}

function errorMessage(text: string): string {
  return `Error: ${text}`;
}

export function createAgent(config: AgentConfig): Agent {
  const log = config.sessionLog ?? new InMemorySessionLog();
  const registry = new ToolRegistry();
  for (const def of config.tools ?? []) registry.register(def);
  const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
  const compactionConfig: CompactionConfig = {
    ...DEFAULT_COMPACTION,
    ...(config.model.contextWindow !== undefined ? { contextWindow: config.model.contextWindow } : {}),
    ...config.compaction,
  };
  const maxSteps = config.maxStepsPerTurn ?? 32;

  const inbox = { followup: [] as InboxItem[], steer: [] as InboxItem[], inject: [] as InboxItem[] };
  const listeners = new Set<(event: AgentLiveEvent) => void>();
  let status: "idle" | "running" = "idle";
  let idleWaiters: (() => void)[] = [];
  let turnAbort: AbortController | null = null;
  let compacting = false;

  const emit = (event: AgentLiveEvent) => {
    for (const cb of listeners) cb(event);
  };

  const buildRequest = (): LlmRequest => {
    const surface = projectSurface(log.readAll());
    return {
      provider: config.model.provider,
      model: config.model.model,
      system: config.systemPrompt(),
      messages: surface.map((item) => item.message),
      tools: registry.publicSchemas(),
      maxTokens: config.model.maxTokens,
      contextWindow: compactionConfig.contextWindow,
    };
  };

  const applyOnRequest = (request: LlmRequest): LlmRequest =>
    config.onRequest ? config.onRequest(request) : request;

  const logHeaderIfChanged = async (request: LlmRequest): Promise<void> => {
    const header = {
      provider: request.provider,
      model: request.model,
      systemFingerprint: fnv1a(request.system),
      toolsFingerprint: registry.fingerprint(),
    };
    const last = lastRequestHeader(log.readAll());
    if (
      !last ||
      last.provider !== header.provider ||
      last.model !== header.model ||
      last.systemFingerprint !== header.systemFingerprint ||
      last.toolsFingerprint !== header.toolsFingerprint
    ) {
      await log.append({ type: "request/header", ...header });
    }
  };

  const compactDeps = (request: LlmRequest) => ({
    sessionLog: log,
    adapter: config.adapter,
    model: { provider: request.provider, model: request.model },
    system: request.system,
    tools: request.tools ?? [],
    config: compactionConfig,
    ...(turnAbort?.signal ? { signal: turnAbort.signal } : {}),
  });

  const runCompact = async (request: LlmRequest, options: CompactOptions): Promise<CompactResult> => {
    if (compacting) {
      return { changed: false, generation: currentGeneration(log.readAll()) };
    }
    compacting = true;
    try {
      return await compactConversation(compactDeps(request), options);
    } finally {
      compacting = false;
    }
  };

  // 压力检查（设计 §5.2）：过阈触发压缩；失败仅告警不阻塞 Turn
  const maybeCompact = async (request: LlmRequest): Promise<boolean> => {
    const tokens = heuristicRequestTokens(request.system, request.tools ?? [], request.messages);
    if (tokens < compactionConfig.thresholdRatio * compactionConfig.contextWindow) return false;
    try {
      const result = await runCompact(request, {});
      if (result.changed) emit({ type: "compaction", ok: true });
      return result.changed;
    } catch (error) {
      emit({
        type: "compaction",
        ok: false,
        error: String((error as Error)?.message ?? error),
      });
      return false;
    }
  };

  const runTurn = async (): Promise<void> => {
    const fromSteer = inbox.followup.length === 0;
    const opener = (fromSteer ? inbox.steer.shift() : inbox.followup.shift())!;
    const abort = new AbortController();
    turnAbort = abort;
    const turnNo = countTurns(log.readAll()) + 1;
    await log.append({ type: "turn/start", turn: turnNo });
    const openerChannel: InputChannel = fromSteer ? "steer" : "followup";
    await log.append({ type: "user/message", channel: openerChannel, message: userMessage(opener.content) });

    let reason: TurnEndReason | null = null;
    let stickyMaxTokens = false;
    let steps = 0;
    let overflowRetries = 0;

    while (reason === null) {
      if (abort.signal.aborted) {
        reason = "aborted";
        break;
      }
      // inject：不唤醒，等下次请求捎带
      for (const item of inbox.inject.splice(0)) {
        await log.append({ type: "user/message", channel: "inject", message: userMessage(item.content) });
      }
      // steer：插入当前 Turn 下一步之前
      for (const item of inbox.steer.splice(0)) {
        await log.append({ type: "user/message", channel: "steer", message: userMessage(item.content) });
      }

      let request = applyOnRequest(buildRequest());
      await logHeaderIfChanged(request);
      if (await maybeCompact(request)) {
        // 压缩改写了投影，重建请求
        request = applyOnRequest(buildRequest());
        await logHeaderIfChanged(request);
      }

      let partialText = "";
      let partialReasoning = "";
      let response: LlmResponse;
      try {
        response = await withRetry(
          () => {
            // 每次尝试重置部分累积：失败尝试的增量不混入 abort 保留
            partialText = "";
            partialReasoning = "";
            return config.adapter.complete(request, {
              signal: abort.signal,
              onTextDelta: (delta) => {
                partialText += delta;
                emit({ type: "text-delta", text: delta });
              },
              onReasoningDelta: (delta) => {
                partialReasoning += delta;
                emit({ type: "reasoning-delta", text: delta });
              },
            });
          },
          {
            policy: retryPolicy,
            usedRetries: retryBudgetUsed(log.readAll(), request.provider, request.model),
            onRetry: async (attempt, failure, delayMs) => {
              await log.append({
                type: "llm/retry",
                provider: request.provider,
                model: request.model,
                attempt,
                code: failure.code,
                delayMs,
              });
              emit({ type: "retry", attempt, code: failure.code, delayMs });
            },
          },
        );
      } catch (failure) {
        const normalized = isLlmFailure(failure) ? failure : null;
        if (normalized?.code === "ABORTED" || abort.signal.aborted) {
          // abort 保留部分输出：已收到的内容（含思维链）组装为 interrupted 消息落日志
          if (partialText || partialReasoning) {
            const partial: AssistantMessage = {
              role: "assistant",
              content: partialText ? [{ type: "text", text: partialText }] : [],
              ...(partialReasoning ? { reasoning: partialReasoning } : {}),
              interrupted: true,
            };
            await log.append({ type: "assistant/message", message: partial });
          }
          reason = "aborted";
          break;
        }
        if (
          normalized?.code === "CONTEXT_WINDOW_EXCEEDED" &&
          overflowRetries < compactionConfig.maxOverflowRetries
        ) {
          // 溢出单独路由：交压缩（保留尾部归零），替换代数前进才允许重试
          const generationBefore = currentGeneration(log.readAll());
          let changed = false;
          try {
            changed = (await runCompact(request, { force: true, retainTokens: 0 })).changed;
          } catch {
            changed = false;
          }
          if (changed && currentGeneration(log.readAll()) > generationBefore) {
            overflowRetries += 1;
            continue; // 重建请求重试本步（不消耗 step 预算）
          }
        }
        emit({ type: "error", error: normalized?.message ?? String(failure) });
        reason = "error";
        break;
      }

      steps += 1; // 预算按成功完成的模型请求计
      await log.append({
        type: "assistant/message",
        message: response.message,
        ...(response.usage ? { usage: response.usage } : {}),
      });
      emit({
        type: "assistant",
        message: response.message,
        ...(response.usage ? { usage: response.usage } : {}),
      });

      if (response.finishReason === "length") stickyMaxTokens = true; // max-tokens 粘性
      const toolCalls = response.message.content.filter(
        (block): block is ToolCallBlock => block.type === "tool_call",
      );

      if (toolCalls.length === 0) {
        reason = stickyMaxTokens ? "max-tokens" : "completed";
        break;
      }

      // Turn Budget：用尽时给未回话的工具调用补合成 isError，保证历史协议合法（无悬空 tool_call）
      if (steps >= maxSteps) {
        for (const call of toolCalls) {
          const content: ContentBlock[] = [{ type: "text", text: errorMessage("turn budget exhausted") }];
          await log.append({
            type: "tool/result",
            id: call.id,
            isError: true,
            content,
            code: "TURN_BUDGET",
          });
          emit({ type: "tool-result", id: call.id, isError: true, content, code: "TURN_BUDGET" });
        }
        emit({ type: "budget-exhausted", steps });
        reason = "budget-exhausted";
        break;
      }

      // 工具管线：tool/call 先落日志再执行；七路失败全部 isError 化
      const run = await runToolCalls(toolCalls, {
        registry,
        env: config.env,
        signal: abort.signal,
        onToolCall: async (call) => {
          await log.append({ type: "tool/call", id: call.id, name: call.name, args: call.arguments });
          emit({ type: "tool-call", id: call.id, name: call.name, args: call.arguments });
        },
        onToolResult: async (outcome) => {
          await log.append({
            type: "tool/result",
            id: outcome.id,
            isError: outcome.isError,
            content: outcome.content,
            ...(outcome.code !== undefined ? { code: outcome.code } : {}),
          });
          emit({
            type: "tool-result",
            id: outcome.id,
            isError: outcome.isError,
            content: outcome.content,
            ...(outcome.code !== undefined ? { code: outcome.code } : {}),
          });
        },
      });
      if (run.concludeTurn) {
        // 工具主动结束 Turn：本 step 工具已全部提交，不再发下一条模型请求
        reason = stickyMaxTokens ? "max-tokens" : "completed";
      }
    }

    // 取消后到达/滞留的唤醒输入归入 next-turn，不加入已中止的活动
    if (reason === "aborted") {
      inbox.followup.push(...inbox.steer.splice(0));
    }

    // turn-stopping 检查点：自然停止前串行调用（blocked 为保留码，当前不会产生）
    if (reason === "completed" || reason === "max-tokens") {
      await config.onTurnStopping?.({ reason, turn: turnNo });
    }

    await log.append({ type: "turn/end", turn: turnNo, reason });
    emit({ type: "turn-end", turn: turnNo, reason });
    turnAbort = null;
  };

  const driver = async (): Promise<void> => {
    try {
      // kick：Inbox 有待处理就开新 Turn
      while (inbox.followup.length > 0 || inbox.steer.length > 0) {
        try {
          await runTurn();
        } catch (error) {
          // 最后一道防线：step 内 catch 之外的意外异常（如 onTurnStopping/日志 IO 抛错）不得杀死驱动
          emit({ type: "error", error: String((error as Error)?.message ?? error) });
          try {
            await log.append({ type: "turn/end", turn: countTurns(log.readAll()), reason: "error" });
          } catch {
            // 尽力而为
          }
        }
      }
    } finally {
      status = "idle";
      emit({ type: "status", status: "idle" });
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const wake = () => {
    if (status === "running") return;
    status = "running";
    emit({ type: "status", status: "running" });
    void driver();
  };

  return {
    get status() {
      return status;
    },
    sessionLog: log,
    followup(input: UserContent): void {
      inbox.followup.push({ content: userContent(input) });
      wake();
    },
    steer(text: string): void {
      // steer 也唤醒；空闲时没有"下一步"可插，作为下一 Turn 的开场输入
      inbox.steer.push({ content: userContent(text) });
      wake();
    },
    inject(text: string): void {
      // 不唤醒：等下次请求捎带
      inbox.inject.push({ content: userContent(text) });
    },
    cancel(options?: { clearInbox?: boolean }): void {
      const clearInbox = options?.clearInbox ?? true; // 默认清 Inbox
      if (clearInbox) {
        inbox.followup.length = 0;
        inbox.steer.length = 0;
        inbox.inject.length = 0;
      }
      turnAbort?.abort();
    },
    whenIdle(): Promise<void> {
      if (status === "idle") return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    async compact(): Promise<void> {
      if (status !== "idle") {
        throw new Error("compact() requires idle（设计 §12：无 maintenance phase）");
      }
      if (compacting) throw new Error("compaction already in progress");
      const request = applyOnRequest(buildRequest());
      compacting = true;
      try {
        await compactConversation(compactDeps(request), { force: true });
        emit({ type: "compaction", ok: true });
      } catch (error) {
        emit({ type: "compaction", ok: false, error: String((error as Error)?.message ?? error) });
        throw error;
      } finally {
        compacting = false;
      }
    },
    subscribe(cb: (event: AgentLiveEvent) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
