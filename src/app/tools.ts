// 录入工具（D3.4 同源铁律：模型只能经工具写账本；UI 是另一写入方，source 语义不同）。
// 六件：record_flow / create_plan / checkin_plan / query_ledger 只读 / void_flow+cancel_plan 走作废回路（2026-09-04 补）。
// execute 返回 canonical JSON value；render 产出人话文本块（模型输入与 UI 回执共用）。

import { randomUUID } from "node:crypto";
import type { ContentBlock, ToolDefinition } from "../harness/index";
import { todayView } from "./fold";
import type { Ledger, LedgerActor, PlanRecord } from "./ledger";

export interface LedgerToolsDeps {
  ledger: Ledger;
  now: () => number;
  /** 会话归属（D4.2：账本凭据按消息归属的伙伴记录） */
  actor?: () => LedgerActor;
}

/** "HH:mm"（或 HH:mm:ss）解析为当地今天的该时刻；非法值原样抛错（管线收敛 isError） */
function parseTimeToday(input: string, now: number): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (!match) throw new Error(`invalid time "${input}"，期望 HH:mm`);
  const base = new Date(now);
  base.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  return base.getTime();
}

export function createLedgerTools(deps: LedgerToolsDeps): ToolDefinition[] {
  const { ledger, now } = deps;
  const actor = () => ({ ...(deps.actor?.() ?? {}), agentName: deps.actor?.().agentName ?? "助手" });
  // 写入类工具统一以注入时钟落账（确定性；ts = 事件时刻）
  const append = (record: Parameters<Ledger["append"]>[0]) => ledger.append(record, now());

  const recordFlow: ToolDefinition = {
    name: "record_flow",
    description: "记一笔生活流水：花钱、吃饭、运动、心情、任何发生的事。需要写入账本时必须调用本工具。",
    parameters: {
      type: "object",
      required: ["category"],
      properties: {
        category: { type: "string", description: "分类，用用户说过的词，如「餐饮」「运动」" },
        note: { type: "string" },
        value: { type: "number", description: "数值（金额或时长等）" },
        unit: { type: "string", description: "单位，如 ¥、分钟、公里" },
        time: { type: "string", description: "发生时刻 HH:mm，缺省为现在" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["seq", "time", "category"],
        properties: { seq: { type: "integer" }, time: { type: "integer" }, category: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { category: string };
        return [{ type: "text", text: `已记一笔「${v.category}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { category?: string; note?: string; value?: number; unit?: string; time?: string };
      if (typeof input.category !== "string" || input.category.trim() === "") {
        throw new Error("category 必填");
      }
      const time = input.time === undefined ? now() : parseTimeToday(input.time, now());
      const record = await append({
        kind: "event",
        source: "agent",
        actor: actor(),
        time,
        category: input.category.trim(),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
      });
      const flow = record as { seq: number; time: number; category: string };
      return { seq: flow.seq, time: flow.time, category: flow.category };
    },
    isConcurrencySafe: () => false,
  };

  const createPlan: ToolDefinition = {
    name: "create_plan",
    description: "建一个计划/待办：今天要做的事、本周目标、带截止日的任务等。",
    parameters: {
      type: "object",
      required: ["title", "scope"],
      properties: {
        title: { type: "string" },
        scope: { type: "string", description: "day | week | month | year | ndays | deadline" },
        due: { type: "string", description: "截止日 YYYY-MM-DD（scope=deadline 必填）" },
        ndays: { type: "integer", description: "最近 N 天（scope=ndays 必填）" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["planId", "title"],
        properties: { planId: { type: "string" }, title: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { title: string };
        return [{ type: "text", text: `已建计划「${v.title}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { title?: string; scope?: string; due?: string; ndays?: number };
      if (typeof input.title !== "string" || input.title.trim() === "") throw new Error("title 必填");
      const scopes = ["day", "week", "month", "year", "ndays", "deadline"] as const;
      const scope = scopes.find((s) => s === input.scope);
      if (!scope) throw new Error(`scope 必须是 ${scopes.join(" | ")}`);
      if (scope === "deadline" && typeof input.due !== "string") throw new Error("scope=deadline 需要 due（YYYY-MM-DD）");
      if (scope === "ndays" && (typeof input.ndays !== "number" || input.ndays < 1)) throw new Error("scope=ndays 需要 ndays ≥ 1");
      const planId = `plan-${randomUUID().slice(0, 8)}`;
      await append({
        kind: "plan",
        source: "agent",
        actor: actor(),
        planId,
        title: input.title.trim(),
        scope,
        ...(input.due !== undefined ? { due: input.due } : {}),
        ...(input.ndays !== undefined ? { ndays: input.ndays } : {}),
      });
      return { planId, title: input.title.trim() };
    },
    isConcurrencySafe: () => false,
  };

  const checkinPlan: ToolDefinition = {
    name: "checkin_plan",
    description: "打卡：认证某个计划做了/没做。planId 从 query_ledger 的结果里拿。",
    parameters: {
      type: "object",
      required: ["planId"],
      properties: { planId: { type: "string" }, done: { type: "boolean" } },
    },
    output: {
      schema: {
        type: "object",
        required: ["planId", "done", "at"],
        properties: { planId: { type: "string" }, done: { type: "boolean" }, at: { type: "integer" } },
      },
      render: (_args, value) => {
        const v = value as { done: boolean };
        return [{ type: "text", text: v.done ? "打卡完成" : "已记为未完成" }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { planId?: string; done?: boolean };
      if (typeof input.planId !== "string") throw new Error("planId 必填");
      const exists = ledger.activeRecords().some((r) => r.kind === "plan" && (r as PlanRecord).planId === input.planId);
      if (!exists) throw new Error(`planId "${input.planId}" 不存在，先用 query_ledger 查`);
      const done = input.done ?? true;
      const record = await append({
        kind: "checkin",
        source: "agent",
        actor: actor(),
        planId: input.planId,
        at: now(),
        done,
      });
      return { planId: input.planId, done, at: record.ts };
    },
    isConcurrencySafe: () => false,
  };

  const queryLedger: ToolDefinition = {
    name: "query_ledger",
    description: "查用户的账本：今天视图（流水+计划+打卡态）、活跃计划列表、按分类/日期过滤流水。只读。",
    parameters: {
      type: "object",
      required: ["what"],
      properties: {
        what: { type: "string", description: "today | plans | flows" },
        category: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
    },
    output: { schema: { type: "object" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args) {
      const input = (args ?? {}) as { what?: string; category?: string; from?: string; to?: string };
      const active = ledger.activeRecords();
      if (input.what === "today") {
        return todayView(ledger.readAll(), now()) as unknown;
      }
      if (input.what === "plans") {
        const plans = active
          .filter((r): r is PlanRecord => r.kind === "plan")
          .map(({ planId, title, scope, due }) => ({ planId, title, scope, ...(due !== undefined ? { due } : {}) }));
        return { plans };
      }
      if (input.what === "flows") {
        const dayKey = (ts: number) => Math.floor(ts / 86400000); // from/to 过滤按 UTC 日近似，粗粒度够用
        const fromKey = input.from !== undefined ? Math.floor(Date.parse(input.from + "T00:00:00Z") / 86400000) : -Infinity;
        const toKey = input.to !== undefined ? Math.floor(Date.parse(input.to + "T00:00:00Z") / 86400000) + 1 : Infinity;
        const flows = active
          .filter((r) => r.kind === "event")
          .map((r) => r as { seq: number; time: number; category: string; note?: string; value?: number; unit?: string })
          .filter((r) => dayKey(r.time) >= fromKey && dayKey(r.time) < toKey)
          .filter((r) => input.category === undefined || r.category === input.category)
          .sort((a, b) => b.time - a.time);
        return { flows }; // seq 是作废（void_flow）的引用凭据
      }
      throw new Error("what 必须是 today | plans | flows");
    },
    isConcurrencySafe: () => true,
  };

  const voidFlow: ToolDefinition = {
    name: "void_flow",
    description: "作废一笔记错/重复的流水（seq 从 query_ledger 的 flows 拿）。修正 = 作废后用 record_flow 重记，不要原地补偿。",
    parameters: {
      type: "object",
      required: ["seq"],
      properties: {
        seq: { type: "integer", description: "要作废的流水 seq" },
        reason: { type: "string", description: "作废原因（如：记错金额）" },
      },
    },
    output: {
      schema: { type: "object", required: ["seq"], properties: { seq: { type: "integer" } } },
      render: (_args, value) => [{ type: "text", text: `已作废流水 #${(value as { seq: number }).seq}` }],
    },
    async execute(args) {
      const input = (args ?? {}) as { seq?: number; reason?: string };
      const seq = Number(input.seq);
      if (!Number.isInteger(seq)) throw new Error("seq 必填（query_ledger 的 flows 里有）");
      const hit = ledger.activeRecords().find((r) => r.seq === seq && r.kind === "event");
      if (!hit) throw new Error(`seq ${seq} 不是有效流水，先用 query_ledger 查`);
      await append({
        kind: "void",
        source: "agent",
        actor: actor(),
        targetSeq: seq,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      return { seq };
    },
    isConcurrencySafe: () => false,
  };

  const cancelPlan: ToolDefinition = {
    name: "cancel_plan",
    description: "取消一个计划/待办：作废后不再出现在今天视图。planId 从 query_ledger 的 plans 拿；已打的卡不受影响。",
    parameters: {
      type: "object",
      required: ["planId"],
      properties: {
        planId: { type: "string" },
        reason: { type: "string", description: "取消原因" },
      },
    },
    output: {
      schema: { type: "object", required: ["planId", "title"], properties: { planId: { type: "string" }, title: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: `已取消计划「${(value as { title: string }).title}」` }],
    },
    async execute(args) {
      const input = (args ?? {}) as { planId?: string; reason?: string };
      if (typeof input.planId !== "string" || input.planId === "") throw new Error("planId 必填（query_ledger 的 plans 里有）");
      const hit = ledger.activeRecords().find((r) => r.kind === "plan" && (r as PlanRecord).planId === input.planId);
      if (!hit) throw new Error(`planId "${input.planId}" 不存在，先用 query_ledger 查`);
      await append({
        kind: "void",
        source: "agent",
        actor: actor(),
        targetSeq: hit.seq,
        reason: input.reason ?? "用户取消计划",
      });
      return { planId: input.planId, title: (hit as PlanRecord).title };
    },
    isConcurrencySafe: () => false,
  };

  return [recordFlow, createPlan, checkinPlan, queryLedger, voidFlow, cancelPlan];
}
