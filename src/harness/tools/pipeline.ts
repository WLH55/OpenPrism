// 工具执行管线（设计 §6.2/§6.3）：
// tool/call 先落日志再执行（经 onToolCall 回调）→ 超时包装 → 工具体 → isError 归一化 →
// tool/result 冻结落日志（经 onToolResult 回调）。七种失败路径全部收敛为合法 tool/result，
// 模型永远收到结构化结果，不存在悬空 tool_call。
// 并发：两态 executionMode（parallel/exclusive，fail-closed）+ 有界滚动池 + 每组提交前重新分类 +
// 结果按模型给定顺序连续提交。

import type { PlatformEnv } from "../env";
import type { ContentBlock, ToolCallBlock } from "../types";
import { ToolRegistry } from "./registry";
import { validateAgainstJsonSchema } from "./schema";

export interface ToolRunOutcome {
  id: string;
  isError: boolean;
  content: ContentBlock[];
  code?: string;
}

interface RunOneResult extends ToolRunOutcome {
  concluded: boolean;
}

export interface RunToolCallsDeps {
  registry: ToolRegistry;
  env: PlatformEnv;
  signal: AbortSignal;
  maxParallelToolCalls?: number; // 默认 10
  /** tool/call 落日志钩子：先记再执行 */
  onToolCall?(call: ToolCallBlock): void | Promise<void>;
  /** tool/result 冻结落日志钩子 */
  onToolResult?(outcome: ToolRunOutcome): void | Promise<void>;
}

export interface RunToolCallsResult {
  /** 按模型给定顺序 */
  outcomes: ToolRunOutcome[];
  /** 任一工具 concludeTurn() === true（本 step 工具已全部提交，Turn 应停止） */
  concludeTurn: boolean;
}

function errorOutcome(id: string, code: string, message: string): RunOneResult {
  return {
    id,
    isError: true,
    content: [{ type: "text", text: message }],
    code,
    concluded: false,
  };
}

/** fail-closed 分类：isConcurrencySafe(args) === true 精确判定才 parallel */
function classify(call: ToolCallBlock, registry: ToolRegistry): "parallel" | "exclusive" {
  try {
    return registry.get(call.name)?.isConcurrencySafe?.(call.arguments) === true ? "parallel" : "exclusive";
  } catch {
    return "exclusive";
  }
}

/** 派生 deadline 信号：父信号取消或自声明超时，二选一先到；超时同时赢下与工具体的竞速 */
function armTimeout(parent: AbortSignal, timeoutMs: number | undefined) {
  const controller = new AbortController();
  const timeoutSentinel = { timeout: true };
  const abortSentinel = { aborted: true };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raceReject: ((reason: unknown) => void) | undefined;
  // 竞速 Promise：永不 resolve；超时/父取消时 reject 哨兵。挂 no-op catch 防止赢得竞速后未处理拒绝。
  const race = new Promise<never>((_, reject) => {
    raceReject = reject;
  });
  race.catch(() => {});
  const onParentAbort = () => {
    controller.abort();
    raceReject?.(abortSentinel);
  };
  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort);
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      raceReject?.(timeoutSentinel);
    }, timeoutMs);
  }
  const cleanup = () => {
    parent.removeEventListener("abort", onParentAbort);
    if (timer !== undefined) clearTimeout(timer);
  };
  return { signal: controller.signal, race, cleanup, isTimeout: (error: unknown) => error === timeoutSentinel || timedOut, isAbort: (error: unknown) => error === abortSentinel };
}

async function runOne(call: ToolCallBlock, deps: RunToolCallsDeps): Promise<RunOneResult> {
  try {
    const def = deps.registry.get(call.name);
    // tool/call 先落日志再执行
    await deps.onToolCall?.(call);
    if (!def) {
      return errorOutcome(call.id, "TOOL_NOT_FOUND", `Error: unknown tool "${call.name}"`);
    }
    if (deps.signal.aborted) {
      return errorOutcome(call.id, "ABORTED_BEFORE_DISPATCH", "Error: tool call aborted before dispatch");
    }
    const { signal, race, cleanup, isTimeout, isAbort } = armTimeout(deps.signal, def.timeoutMs);
    let value: unknown;
    try {
      // 工具体即使完全无视信号，也会被超时/取消竞速截断（硬保证，不只靠协作式取消）
      value = await Promise.race([def.execute(call.arguments, { signal, env: deps.env }), race]);
    } catch (error) {
      if (isTimeout(error) && !deps.signal.aborted) {
        return errorOutcome(
          call.id,
          "TOOL_TIMEOUT",
          `Error: tool call timed out after ${def.timeoutMs}ms`,
        );
      }
      if (isAbort(error) || deps.signal.aborted) {
        return errorOutcome(call.id, "ABORTED", "Error: tool call aborted");
      }
      return errorOutcome(call.id, "TOOL_ERROR", `Error: ${String((error as Error)?.message ?? error)}`);
    } finally {
      cleanup();
    }
    // 输出违约：canonical value 必须满足 output.schema
    const violation = validateAgainstJsonSchema(value, def.output.schema);
    if (violation) {
      return errorOutcome(call.id, "TOOL_OUTPUT_INVALID", `Error: tool output violates contract: ${violation}`);
    }
    // 快照：render 产出内容块
    let blocks: ContentBlock[];
    try {
      blocks = def.output.render(call.arguments, value);
    } catch (error) {
      return errorOutcome(call.id, "TOOL_RENDER_FAILED", `Error: tool render failed: ${String((error as Error)?.message ?? error)}`);
    }
    let concluded = false;
    try {
      concluded = def.concludeTurn?.() === true;
    } catch {
      concluded = false;
    }
    return {
      id: call.id,
      isError: false,
      content: blocks,
      concluded,
    };
  } catch (error) {
    // 管线自身抛错（含 onToolCall 钩子失败）
    return errorOutcome(call.id, "TOOL_PIPELINE_ERROR", `Error: tool pipeline failure: ${String((error as Error)?.message ?? error)}`);
  }
}

/** 有界滚动池：一个完成补一个（设计 §6.3） */
async function runParallelGroup(group: ToolCallBlock[], deps: RunToolCallsDeps): Promise<RunOneResult[]> {
  const max = Math.max(1, deps.maxParallelToolCalls ?? 10);
  const results = new Array<RunOneResult>(group.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= group.length) return;
      results[index] = await runOne(group[index]!, deps); // 单个失败已 isError 化，不影响池
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, group.length) }, () => worker()));
  return results;
}

export async function runToolCalls(calls: ToolCallBlock[], deps: RunToolCallsDeps): Promise<RunToolCallsResult> {
  const queue = [...calls];
  const outcomes: ToolRunOutcome[] = [];
  let concludeTurn = false;

  while (queue.length > 0) {
    if (deps.signal.aborted) {
      // 取消前：未启动的调用合成 isError 结果（协议合法性）
      for (const call of queue.splice(0)) {
        const outcome = errorOutcome(call.id, "ABORTED_BEFORE_DISPATCH", "Error: tool call aborted before dispatch");
        outcomes.push(outcome);
        await deps.onToolResult?.(outcome);
      }
      break;
    }
    // 每组提交前重新分类（registry 变更影响未启动的调用）
    const mode = classify(queue[0]!, deps.registry);
    const group: ToolCallBlock[] = [queue.shift()!];
    if (mode === "parallel") {
      while (queue.length > 0 && classify(queue[0]!, deps.registry) === "parallel") {
        group.push(queue.shift()!);
      }
    }
    // exclusive 单独成组即屏障（组大小恒为 1）
    const groupResults = mode === "parallel" ? await runParallelGroup(group, deps) : [await runOne(group[0]!, deps)];
    // 结果按模型给定顺序连续提交
    for (const result of groupResults) {
      const { concluded, ...outcome } = result;
      if (concluded) concludeTurn = true;
      outcomes.push(outcome);
      await deps.onToolResult?.(outcome);
    }
  }

  return { outcomes, concludeTurn };
}
