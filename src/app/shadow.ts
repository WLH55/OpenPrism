// read_shadow 工具（2026-11-10 Spill 回读）：压缩遮蔽区间的原文取回。
// 压缩只改模型可见面（投影），原文永续保存在会话日志里；checkpoint 摘要末尾标注了可回读的 seq 区间，
// 模型拿标注里的区间调本工具即可读回原文——内容直接来自日志，铁律 2（model-visible means logged）天然满足。

import type { ContentBlock, SessionEvent, SessionLog, ToolDefinition } from "../harness/index";

/** 单次可回读的事件数上限：防止一次拖回半个会话（模型可分多次取） */
export const READ_SHADOW_MAX_EVENTS = 500;

/** 单条文本块渲染上限（超出截断并标注——精读原文有 prune 兜底，这里只挡最粗的膨胀） */
const SHADOW_TEXT_CAP = 800;

const clip = (text: string): string => {
  const cps = [...text];
  return cps.length <= SHADOW_TEXT_CAP ? text : `${cps.slice(0, SHADOW_TEXT_CAP).join("")}……（截断，共 ${cps.length} 字）`;
};

/** 把一条日志事件渲染为一行回读文本（消息粒度；turn/*、retry、header 是协议与执行记录，不回读） */
function renderShadowEvent(event: SessionEvent): string | undefined {
  const seq = `#${event.seq}`;
  switch (event.type) {
    case "user/message": {
      const parts = event.message.content.map((block) => {
        if (block.type === "text") return clip(block.text);
        if (block.type === "image") return "[图片]";
        return `[${block.type}]`;
      });
      return `${seq} 用户：${parts.join(" ")}`;
    }
    case "assistant/message": {
      const parts = event.message.content.map((block) => {
        if (block.type === "text") return clip(block.text);
        if (block.type === "tool_call") return `〔调用工具 ${block.name}，参数 ${JSON.stringify(block.arguments)}〕`;
        return `[${block.type}]`;
      });
      return `${seq} 助手：${parts.join(" ")}`;
    }
    case "tool/result": {
      const text = event.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      const mark = event.isError ? `（失败${event.code !== undefined ? ` ${event.code}` : ""}）` : "";
      return `${seq} 工具结果${mark}：${text === "" ? "（无文本输出）" : clip(text)}`;
    }
    case "compaction/summary":
      return `${seq} （压缩摘要事件：本区间此前已被摘要替换，摘要正文见上文 checkpoint）`;
    default:
      return undefined;
  }
}

/**
 * 回读工具：按 seq 区间（含两端）取回会话日志原文。区间校验失败直接抛错（管线 isError 化，模型可见原因）。
 */
export function createReadShadowTool(deps: { log: SessionLog }): ToolDefinition {
  return {
    name: "read_shadow",
    description:
      "读取本会话较早被压缩成摘要的原文。当摘要不够用（缺数字、缺具体约定、需要当时的原话）时，按压缩摘要标注的序号区间调用本工具取回原文。区间两端都包含，单次最多 500 条事件。",
    parameters: {
      type: "object",
      required: ["start", "end"],
      properties: {
        start: { type: "integer", description: "起始序号（含），来自压缩摘要标注的区间" },
        end: { type: "integer", description: "结束序号（含）" },
      },
    },
    output: {
      schema: { type: "object", required: ["text", "count"], properties: { text: { type: "string" }, count: { type: "number" } } },
      render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }] satisfies ContentBlock[],
    },
    async execute(args) {
      const rawStart = (args as { start?: unknown })?.start;
      const rawEnd = (args as { end?: unknown })?.end;
      // null/undefined/空串经 Number() 会静默变 0——fast-fail 口径下显式拒绝（2026-11-10 审查）
      if (rawStart === null || rawStart === undefined || rawStart === "" || rawEnd === null || rawEnd === undefined || rawEnd === "") {
        throw new Error("start/end 必须是非负整数序号（见压缩摘要标注的区间）");
      }
      const start = Number(rawStart);
      const end = Number(rawEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) {
        throw new Error("start/end 必须是非负整数序号（见压缩摘要标注的区间）");
      }
      if (end < start) throw new Error(`区间反了：end(${end}) 小于 start(${start})`);
      if (end - start + 1 > READ_SHADOW_MAX_EVENTS) {
        throw new Error(`区间过宽（${end - start + 1} 条）：单次最多 ${READ_SHADOW_MAX_EVENTS} 条，请分多次取`);
      }
      const lines: string[] = [];
      for (const event of deps.log.readAll()) {
        if (event.seq < start || event.seq > end) continue;
        const line = renderShadowEvent(event);
        if (line !== undefined) lines.push(line);
      }
      const header = `#seq ${start}–${end} 的原文${lines.length === 0 ? "（区间内没有消息记录）" : ""}：`;
      return { text: [header, ...lines].join("\n"), count: lines.length };
    },
    isConcurrencySafe: () => true,
  };
}
