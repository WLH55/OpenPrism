// 数据导出（2026-09-30 SDD 数据导出）：纯函数组装器。
// JSON = 机器可读全量（readAll 口径：含作废与休眠 goal 行，完整可审计）；
// Markdown = 人读时间线（active 口径：当前真相，作废/修订旧版本不出现）+ 对话的用户/助手文本轮次。
// 路由只做 IO（server.ts），分组与渲染在此单测。

import type { LedgerRecord, PlanRecord } from "./ledger";
import type { SessionEvent } from "../harness/index";

export interface ExportConversation {
  cid: string;
  title: string;
  agentId?: string;
  createdTs: number;
  events: SessionEvent[];
}

export interface ExportInput {
  exportedAt: number;
  ledger: LedgerRecord[];
  conversations: ExportConversation[];
}

export function buildExportJson(input: ExportInput): string {
  return JSON.stringify(
    {
      exportedAt: new Date(input.exportedAt).toISOString(),
      ledger: input.ledger, // 全量原文：流水/计划/打卡/作废/休眠 goal 行
      conversations: input.conversations.map((c) => ({
        cid: c.cid,
        title: c.title,
        ...(c.agentId !== undefined ? { agentId: c.agentId } : {}),
        createdTs: c.createdTs,
        events: c.events,
      })),
    },
    null,
    2,
  );
}

// ── Markdown 时间线 ──────────────────────────────────────────

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function localParts(ts: number, tz: number): { ymd: string; weekday: string; hhmm: string; full: string } {
  const d = new Date(ts + tz * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    ymd: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    weekday: WEEKDAY[d.getUTCDay()] ?? "?",
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    full: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** 计划的周期描述（与 D13 习惯口径一致：带配额 = 习惯，day 按次/周月年按天） */
function scopeDesc(plan: PlanRecord): string {
  if (plan.timesPerPeriod !== undefined) {
    const unit = ({ day: "每天", week: "每周", month: "每月", year: "每年" } as Record<string, string>)[plan.scope];
    if (unit !== undefined) return `${unit} ${plan.timesPerPeriod} ${plan.scope === "day" ? "次" : "天"}`;
  }
  switch (plan.scope) {
    case "day":
      return "今日";
    case "week":
      return "本周";
    case "month":
      return "本月";
    case "year":
      return "今年";
    case "ndays":
      return `最近 ${plan.ndays ?? 1} 天`;
    case "deadline":
      return `截止 ${plan.due ?? "?"}`;
  }
}

/** 消息内容块 → 文本（file 带附件名，image 占位；tool_call 是助手内部动作不进人读版） */
function blockText(block: ContentBlockLike): string {
  switch (block.type) {
    case "text":
      return block.text ?? "";
    case "file":
      return `[附件：${block.name ?? "文件"}]\n${block.text ?? ""}`;
    case "image":
      return "[图片]";
    default:
      return "";
  }
}
type ContentBlockLike = { type: string; text?: string; name?: string };

export function buildExportMarkdown(input: ExportInput & { tzOffsetMinutes: number }): string {
  const tz = input.tzOffsetMinutes;
  const out: string[] = [];
  const now = localParts(input.exportedAt, tz);
  const tzLabel = `UTC${tz >= 0 ? "+" : ""}${tz / 60}`;
  out.push(`# OpenPrism 数据导出`);
  out.push("");
  out.push(`导出时间：${now.full}（${tzLabel}）。生活记录按日分组（当前真相，已作废记录与修订旧版本不在此版，JSON 全量备份含全部历史）；对话收录你与助手的发言文本。`);
  out.push("");

  // ── 生活记录（active 口径）：plan/checkin/event 各自的时刻归日 ──
  const voided = new Set(input.ledger.filter((r) => r.kind === "void").map((r) => (r as { targetSeq: number }).targetSeq));
  const active = input.ledger.filter((r) => r.kind !== "void" && !voided.has(r.seq));
  const planTitle = new Map<string, string>();
  for (const r of active) if (r.kind === "plan") planTitle.set(r.planId, r.title);

  type Row = { ts: number; line: string };
  const byDay = new Map<string, Row[]>();
  const pushRow = (ts: number, line: string): void => {
    const day = localParts(ts, tz).ymd;
    const rows = byDay.get(day) ?? [];
    rows.push({ ts, line });
    byDay.set(day, rows);
  };
  for (const r of active) {
    if (r.kind === "plan") pushRow(r.ts, `建计划：${r.title}（${scopeDesc(r)}）`);
    else if (r.kind === "checkin") pushRow(r.at, `打卡 ${r.done ? "✓" : "✗"} ${planTitle.get(r.planId) ?? r.planId}`);
    else if (r.kind === "event") {
      const value = r.value !== undefined ? ` ${r.value}${r.unit ?? ""}` : "";
      const note = r.note !== undefined && r.note !== "" ? `｜${r.note}` : "";
      pushRow(r.time, `${r.category}${value}${note}`);
    }
  }

  if (byDay.size > 0) {
    out.push(`## 生活记录`);
    out.push("");
    for (const day of [...byDay.keys()].sort()) {
      const p = localParts(new Date(`${day}T00:00:00Z`).getTime() + tz * 60000, tz);
      out.push(`### ${day} 周${p.weekday}`);
      const rows = (byDay.get(day) ?? []).sort((a, b) => a.ts - b.ts);
      for (const row of rows) out.push(`- ${localParts(row.ts, tz).hhmm} ${row.line}`);
      out.push("");
    }
  }

  // ── 对话（按创建时间正序；仅 user/assistant 消息事件） ──
  const convs = [...input.conversations].sort((a, b) => a.createdTs - b.createdTs);
  if (convs.length > 0) {
    out.push(`## 对话记录`);
    out.push("");
    for (const c of convs) {
      const created = localParts(c.createdTs, tz);
      out.push(`### ${c.title || "（未命名会话）"}（创建于 ${created.full}${c.agentId !== undefined ? ` · 伙伴 ${c.agentId}` : ""}）`);
      out.push("");
      const messages = c.events
        .filter((e): e is Extract<SessionEvent, { type: "user/message" | "assistant/message" }> => e.type === "user/message" || e.type === "assistant/message")
        .sort((a, b) => a.seq - b.seq);
      if (messages.length === 0) {
        out.push(`（无消息记录）`);
        out.push("");
        continue;
      }
      for (const m of messages) {
        const role = m.type === "user/message" ? "用户" : "助手";
        const text = (m.message.content as ContentBlockLike[]).map(blockText).filter((t) => t !== "").join("\n");
        out.push(`**${role}** · ${m.ts !== undefined ? localParts(m.ts, tz).hhmm : ""}`);
        out.push(text === "" ? "（无文本内容）" : text);
        out.push("");
      }
    }
  }

  if (byDay.size === 0 && convs.length === 0) {
    out.push(`（还没有可导出的记录）`);
    out.push("");
  }
  return out.join("\n");
}
