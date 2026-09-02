// 两阶段压缩（设计 §5.3/§5.4）：裁剪（恒在投影里生效，零成本）+ 摘要（花 token）。
// 摘要请求复用会话前缀（同 system + tools + 被压区间消息）以保 KV cache 命中，仅末尾追加指令消息；
// 事务提交：稳定性检查 → compaction/summary 事件（遮蔽区间 + checkpoint 整体替换）；
// shrink 校验：压缩不许越压越大；替换代数 = compaction/summary 累计数（只进不退）。

import type { LlmAdapter, LlmRequest, ToolPublicSchema } from "../llm/adapter";
import { llmFailure } from "../llm/errors";
import type { SessionLog } from "../session/log";
import type { SessionEvent } from "../session/events";
import { projectSurface, type SurfaceItem } from "../session/project";
import { currentGeneration } from "../session/queries";
import type { Message, UserMessage } from "../types";
import { heuristicMessageTokens, heuristicRequestTokens } from "./meter";

export interface CompactionConfig {
  contextWindow: number;
  thresholdRatio: number; // 0.8
  retainRatio: number; // 0.16
  summaryMaxTokens: number;
  maxOverflowRetries: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  contextWindow: 64_000,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  summaryMaxTokens: 2048,
  maxOverflowRetries: 1,
};

export interface CompactDeps {
  sessionLog: SessionLog;
  adapter: LlmAdapter;
  model: { provider: string; model: string };
  system: string;
  tools: ToolPublicSchema[];
  config: CompactionConfig;
  signal?: AbortSignal;
}

export interface CompactOptions {
  /** 溢出路径传 0（保留尾部归零，设计 §5.2）；默认 retainRatio × contextWindow */
  retainTokens?: number;
  /** 绕过阈值（溢出强制触发 / 手动压缩） */
  force?: boolean;
}

export interface CompactResult {
  changed: boolean;
  /** 提交后的替换代数 */
  generation: number;
}

const SUMMARY_INSTRUCTION = `请把以上对话历史压缩为一份结构化 Markdown 摘要，供后续对话作为唯一的历史记忆。严格按以下小节输出：

# 任务意图
# 关键概念
# 文件与代码
# 错误与修复
# 未竟事项
# 当前工作
# 下一步
# 关键上下文

要求：文件路径、命令、错误原文、数值等必须逐字保留，不得改写或省略；没有内容的小节写"无"；只输出摘要本身。`;

function summaryCheckpoint(summary: string): UserMessage {
  return { role: "user", content: [{ type: "text", text: summary }] };
}

/** 区间尾部是否会切开 assistant(tool_call)↔tool_result 配对 */
function splitsPair(surface: SurfaceItem[], end: number): boolean {
  const callIds = new Set<string>();
  for (let i = 0; i <= end; i++) {
    const message = surface[i]!.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool_call") callIds.add(block.id);
      }
    }
  }
  for (let i = end + 1; i < surface.length; i++) {
    const message = surface[i]!.message;
    if (message.role === "tool_result" && callIds.has(message.callId)) return true;
  }
  return false;
}

interface ShadowInterval {
  startSeq: number;
  endSeq: number;
  items: SurfaceItem[];
}

/** 从头部选可压缩区间：遮蔽后尾部至少保留 retainTokens；边界回退至不切开配对 */
export function selectShadowInterval(surface: SurfaceItem[], retainTokens: number): ShadowInterval | null {
  if (surface.length < 2) return null;
  let end = surface.length - 1;
  let kept = 0;
  while (end >= 0 && kept < retainTokens) {
    kept += heuristicMessageTokens(surface[end]!.message);
    end -= 1;
  }
  if (end < 0) return null; // 保留尾部吃掉全部历史：无可压区间
  end = Math.min(end, surface.length - 2); // 至少保留 1 条（retain=0 的溢出路径）
  while (end >= 0 && splitsPair(surface, end)) end -= 1; // 边界回退
  if (end < 0) return null;
  return { startSeq: surface[0]!.seq, endSeq: surface[end]!.seq, items: surface.slice(0, end + 1) };
}

async function requestSummary(deps: CompactDeps, intervalMessages: Message[]): Promise<string> {
  const instruction: UserMessage = { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] };
  const request: LlmRequest = {
    provider: deps.model.provider,
    model: deps.model.model,
    system: deps.system,
    messages: [...intervalMessages, instruction],
    tools: deps.tools, // 复用会话前缀以保 KV cache 命中
    maxTokens: deps.config.summaryMaxTokens,
  };
  const response = await deps.adapter.complete(request, { signal: deps.signal });
  const text = response.message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    throw llmFailure("EMPTY_RESPONSE", "compaction: summary came back empty");
  }
  return text;
}

function surfaceSignature(surface: SurfaceItem[]): string {
  return surface.map((item) => item.seq).join(",");
}

export async function compactConversation(deps: CompactDeps, options: CompactOptions = {}): Promise<CompactResult> {
  const events: SessionEvent[] = deps.sessionLog.readAll();
  const generationBefore = currentGeneration(events);
  const surface = projectSurface(events);

  // 阶段一（裁剪）恒在投影里生效，这里直接按投影后的压力判断
  const pressure = heuristicRequestTokens(deps.system, deps.tools, surface.map((it) => it.message));
  const threshold = deps.config.thresholdRatio * deps.config.contextWindow;
  if (!options.force && pressure < threshold) {
    return { changed: false, generation: generationBefore };
  }

  const retainTokens =
    options.retainTokens ?? Math.round(deps.config.retainRatio * deps.config.contextWindow);
  const interval = selectShadowInterval(surface, retainTokens);
  if (!interval) {
    throw new Error("compaction: nothing compressible (surface too small or retention consumes all)");
  }

  // 阶段二：摘要（此期间日志可能继续增长）
  const summary = await requestSummary(deps, interval.items.map((it) => it.message));

  // 稳定性检查：摘要期间 Surface 变更则放弃提交（事务，设计 §5.4）
  const eventsNow = deps.sessionLog.readAll();
  const surfaceNow = projectSurface(eventsNow);
  if (surfaceSignature(surfaceNow) !== surfaceSignature(surface)) {
    return { changed: false, generation: generationBefore };
  }

  // shrink 校验：摘要 token 必须严格小于被遮蔽区间
  const intervalTokens = interval.items.reduce((sum, it) => sum + heuristicMessageTokens(it.message), 0);
  const summaryTokens = heuristicMessageTokens(summaryCheckpoint(summary));
  if (summaryTokens >= intervalTokens) {
    throw new Error(
      `compaction: shrink validation failed (summary ${summaryTokens} >= shadowed ${intervalTokens})`,
    );
  }

  // 提交：compaction/summary 事件 + checkpoint 整体替换遮蔽区间
  await deps.sessionLog.append({
    type: "compaction/summary",
    shadowed: [interval.startSeq, interval.endSeq],
    summary,
    generation: generationBefore + 1,
  });

  return { changed: true, generation: generationBefore + 1 };
}
