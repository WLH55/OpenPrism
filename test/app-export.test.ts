// 数据导出组装器（2026-09-30 SDD 数据导出）：JSON 全量口径（含作废/休眠行）与
// Markdown 时间线（active 口径 + tz 日期分组 + 用户/助手文本轮次）的纯函数行为。

import { describe, expect, it } from "vitest";
import { buildExportJson, buildExportMarkdown, type ExportConversation } from "../src/app/export";
import type { LedgerRecord } from "../src/app/ledger";
import type { SessionEvent } from "../src/harness/index";

const TZ = 480;
// 固定锚：2026-09-28 17:00 UTC = 当地（UTC+8）2026-09-29 01:00——跨日分组的判据
const NOW = Date.UTC(2026, 8, 28, 17, 0, 0);

function ledger(): LedgerRecord[] {
  return [
    { seq: 0, ts: NOW - 70000, source: "ui", kind: "plan", planId: "run3", title: "每周运动三天", scope: "week", timesPerPeriod: 3 },
    { seq: 1, ts: NOW - 60000, source: "ui", kind: "plan", planId: "report", title: "交周报", scope: "deadline", due: "2026-10-04" },
    { seq: 2, ts: NOW - 50000, source: "ui", kind: "checkin", planId: "run3", at: NOW - 50000, done: true },
    { seq: 3, ts: NOW - 40000, source: "agent", kind: "event", time: NOW - 40000, category: "餐饮", note: "午餐", value: 28, unit: "¥" },
    { seq: 4, ts: NOW - 30000, source: "ui", kind: "void", targetSeq: 3, reason: "记错" }, // 作废上面的流水
    { seq: 5, ts: NOW - 20000, source: "ui", kind: "goal", goalId: "g1", level: "direction", title: "历史方向", status: "active" }, // 休眠 goal 行
    { seq: 6, ts: NOW - 10000, source: "ui", kind: "event", time: NOW - 10000, category: "运动", note: "跑步", value: 30, unit: "分钟" }, // 存活流水
    { seq: 7, ts: NOW - 9000, source: "ui", kind: "plan", planId: "gone", title: "已作废计划的打卡", scope: "day" },
    { seq: 8, ts: NOW - 8500, source: "ui", kind: "checkin", planId: "gone", at: NOW - 8500, done: true },
    { seq: 9, ts: NOW - 8000, source: "ui", kind: "void", targetSeq: 7, reason: "不做了" }, // 作废计划本身——打卡行保留但计划行不进 MD
  ];
}

function conversations(): ExportConversation[] {
  const events: SessionEvent[] = [
    { seq: 0, ts: NOW - 10000, type: "user/message", channel: "followup", message: { role: "user", content: [{ type: "text", text: "记一笔午餐" }, { type: "image", mediaType: "image/png", data: "x" }] } },
    { seq: 1, ts: NOW - 9000, type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "已记上" }] } },
    { seq: 2, ts: NOW - 8000, type: "tool/call", id: "t1", name: "record_flow", args: {} }, // 不进人读版
  ];
  return [
    { cid: "c-1", title: "记账", createdTs: NOW - 12000, events },
  ];
}

describe("buildExportJson", () => {
  it("全量口径：exportedAt ISO、账本含作废与休眠 goal 行、会话事件原文（AC1）", () => {
    const parsed = JSON.parse(buildExportJson({ exportedAt: NOW, ledger: ledger(), conversations: conversations() })) as {
      exportedAt: string;
      ledger: LedgerRecord[];
      conversations: { cid: string; title: string; events: unknown[] }[];
    };
    expect(parsed.exportedAt).toBe("2026-09-28T17:00:00.000Z");
    expect(parsed.ledger).toHaveLength(10); // 一条不少——含 void 与休眠 goal
    expect(parsed.ledger.some((r) => r.kind === "void")).toBe(true);
    expect(parsed.ledger.some((r) => r.kind === "goal")).toBe(true);
    expect(parsed.conversations[0]!.cid).toBe("c-1");
    expect(parsed.conversations[0]!.events).toHaveLength(3); // 工具调用也保留（机器可读全量）
  });
});

describe("buildExportMarkdown", () => {
  it("active 口径 + tz 跨日分组：作废流水与休眠 goal 不出现；17:00 UTC（当地次日 01:00）归对日（AC2）", () => {
    const md = buildExportMarkdown({ exportedAt: NOW, ledger: ledger(), conversations: [], tzOffsetMinutes: TZ });
    expect(md).toContain("## 生活记录");
    expect(md).toContain("### 2026-09-29"); // 17:00Z + 8h = 次日 01:00（跨日判据）
    expect(md).toContain("建计划：每周运动三天（每周 3 天）"); // 习惯配额（D13 口径）
    expect(md).toContain("建计划：交周报（截止 2026-10-04）");
    expect(md).toContain("打卡 ✓ 每周运动三天");
    expect(md).toContain("打卡 ✓ 已作废计划的打卡"); // 被作废计划的打卡仍显示其标题（只作显示引用，不复活计划行）
    expect(md).not.toContain("建计划：已作废计划的打卡"); // 计划本体已作废——建计划行不进人读版
    expect(md).toContain("运动 30分钟｜跑步"); // 存活流水
    expect(md).not.toContain("午餐"); // 被作废的流水不进人读版
    expect(md).not.toContain("记错"); // void reason 同理
    expect(md).not.toContain("历史方向"); // 休眠 goal 行不进
    expect(md).not.toContain("## 对话记录"); // 无会话不渲染空节
  });

  it("对话区：逐会话标题 + 用户/助手文本轮次；图片占位、附件带名；工具调用不出现（AC2）", () => {
    const md = buildExportMarkdown({ exportedAt: NOW, ledger: [], conversations: conversations(), tzOffsetMinutes: TZ });
    expect(md).toContain("### 记账（创建于");
    expect(md).toContain("**用户** ·");
    expect(md).toContain("记一笔午餐");
    expect(md).toContain("[图片]");
    expect(md).toContain("**助手** ·");
    expect(md).toContain("已记上");
    expect(md).not.toContain("record_flow"); // 工具调用不进人读版
  });

  it("附件块带文件名；空输入给出占位说明", () => {
    const withFile: ExportConversation = {
      cid: "c-2",
      title: "文件会话",
      createdTs: NOW,
      events: [
        {
          seq: 0,
          ts: NOW,
          type: "user/message",
          channel: "followup",
          message: { role: "user", content: [{ type: "file", name: "日记.md", mediaType: "text/markdown", text: "文件正文" }] },
        },
      ],
    };
    const md = buildExportMarkdown({ exportedAt: NOW, ledger: [], conversations: [withFile], tzOffsetMinutes: TZ });
    expect(md).toContain("[附件：日记.md]");
    expect(md).toContain("文件正文");
    const empty = buildExportMarkdown({ exportedAt: NOW, ledger: [], conversations: [], tzOffsetMinutes: TZ });
    expect(empty).toContain("（还没有可导出的记录）");
  });
});
