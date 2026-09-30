// 录入工具（D3.4 同源铁律：模型只能经工具写账本；UI 是另一写入方，source 语义不同）。
// 七件（2026-09-29 补 update_plan + 补撤卡）：record_flow / create_plan / update_plan（追加新版本+void 旧记录，planId 稳定）/
// checkin_plan（date/time 可补历史卡）/ query_ledger 只读（limit）/ void_flow（流水作废+打卡撤销）+ cancel_plan 走作废回路。
// 2026-09-30 目标层级下线（SDD 2026-09-30_00-29）：goal 三工具与 goalId 挂载参数移除；what=goals 下线。
// execute 返回 canonical JSON value；render 产出人话文本块（模型输入与 UI 回执共用）。

import { randomUUID } from "node:crypto";
import type { ContentBlock, ToolDefinition } from "../harness/index";
import { todayView } from "./fold";
import { mergePlanUpdate, parseAt } from "./plans";
import type { Ledger, LedgerActor, PlanRecord } from "./ledger";

export interface LedgerToolsDeps {
  ledger: Ledger;
  now: () => number;
  /** 会话归属（D4.2：账本凭据按消息归属的伙伴记录） */
  actor?: () => LedgerActor;
  /** 用户档案时区（分钟；2026-09-29）：today/goals 视图与 flows 日期过滤按用户钟面折叠；缺省 0（UTC，测试口径） */
  tzOffsetMinutes?: () => number;
}

export function createLedgerTools(deps: LedgerToolsDeps): ToolDefinition[] {
  const { ledger, now } = deps;
  const tz = () => deps.tzOffsetMinutes?.() ?? 0;
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
      const time = input.time === undefined ? now() : parseAt(undefined, input.time, now());
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
        scope: {
          type: "string",
          description:
            "day | week | month | year | ndays | deadline。周期习惯用 day/week/month/year/ndays（每个周期重新打卡，如\"每天背单词\"=day、\"每周跑两次\"=week）；一次性的事用 deadline 并填 due（打过一次就算完成，如\"周五前交报告\"）。计划没有次数字段——\"每周两次\"的\"两次\"这类量词要写进 title（如\"跑步（每周目标 2 次）\"），不要默默丢弃。用户话里没有\"每天/每周\"也没有截止日就先问一句要哪种，不要猜。",
        },
        due: {
          type: "string",
          description:
            "截止日 YYYY-MM-DD（scope=deadline 必填）。相对期限换算成该周期最后一天：本周内=本周日（周一起算）、本月内=月末、今年内=12-31，以系统注入的今天为准；用户说了具体日期就直接用，不要替他改。",
        },
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
      const input = (args ?? {}) as { title?: string; scope?: string; due?: string; ndays?: number; goalId?: string };
      if (input.goalId !== undefined) throw new Error("目标层级（方向/阶段/项目）已下线，计划都是独立待办，不要传 goalId");
      if (typeof input.title !== "string" || input.title.trim() === "") throw new Error("title 必填");
      if (input.title.trim().length > 200) throw new Error("title 过长（≤200 字）");
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

  const updatePlan: ToolDefinition = {
    name: "update_plan",
    description: "修改计划：标题/截止日/周期，只传要改的字段，未提供的保持原值。比取消重建好——planId 不变，已打的卡都还在。",
    parameters: {
      type: "object",
      required: ["planId"],
      properties: {
        planId: { type: "string", description: "要改的计划 planId（query_ledger 的 plans 里有）" },
        title: { type: "string" },
        scope: { type: "string", description: "day | week | month | year | ndays | deadline；周期换了就改成用户最新说法" },
        due: { type: "string", description: "截止日 YYYY-MM-DD（scope=deadline 必有）；相对期限换算规则同 create_plan" },
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
        return [{ type: "text", text: `已更新计划「${v.title}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { planId?: string; title?: string; scope?: string; due?: string; ndays?: number; goalId?: string };
      if (input.goalId !== undefined) throw new Error("目标层级（方向/阶段/项目）已下线，计划都是独立待办，不要传 goalId");
      if (typeof input.planId !== "string" || input.planId === "") throw new Error("planId 必填（query_ledger 的 plans 里有）");
      const hit = ledger.activeRecords().find((r) => r.kind === "plan" && (r as PlanRecord).planId === input.planId);
      if (!hit) throw new Error(`planId "${input.planId}" 不存在，先用 query_ledger 查`);
      const cur = hit as PlanRecord;

      const merged = mergePlanUpdate(cur, input); // 校验+合并与 UI 路由同源（plans.ts）；goalId 修订时剥离

      // 追加新版本 + void 旧记录（与「逾期跳过」同构）：planId 稳定 → 历史打卡引用不断，折叠层零感知
      await append({ ...merged, kind: "plan", source: "agent", actor: actor() });
      await append({ kind: "void", source: "agent", actor: actor(), targetSeq: cur.seq, reason: "更新计划" });
      return { planId: merged.planId, title: merged.title };
    },
    isConcurrencySafe: () => false,
  };

  const checkinPlan: ToolDefinition = {
    name: "checkin_plan",
    description: "打卡：认证某个计划做了/没做。planId 从 query_ledger 的结果里拿。昨天做了忘了打，带 date 补卡；打错了用 void_flow 撤——刚打的 seq 在回执里，历史打卡的 seq 从 query_ledger what=today 该计划的 checkins 里拿。",
    parameters: {
      type: "object",
      required: ["planId"],
      properties: {
        planId: { type: "string" },
        done: { type: "boolean" },
        date: { type: "string", description: "补卡日期 YYYY-MM-DD，缺省为今天；不能是未来" },
        time: { type: "string", description: "打卡时刻 HH:mm，缺省为现在" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["planId", "done", "at", "seq"],
        properties: { planId: { type: "string" }, done: { type: "boolean" }, at: { type: "integer" }, seq: { type: "integer" } },
      },
      render: (_args, value) => {
        const v = value as { done: boolean };
        return [{ type: "text", text: v.done ? "打卡完成" : "已记为未完成" }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { planId?: string; done?: boolean; date?: string; time?: string };
      if (typeof input.planId !== "string") throw new Error("planId 必填");
      const exists = ledger.activeRecords().some((r) => r.kind === "plan" && (r as PlanRecord).planId === input.planId);
      if (!exists) throw new Error(`planId "${input.planId}" 不存在，先用 query_ledger 查`);
      const done = input.done ?? true;
      const at = parseAt(input.date, input.time, now());
      const record = await append({
        kind: "checkin",
        source: "agent",
        actor: actor(),
        planId: input.planId,
        at,
        done,
      });
      const checkin = record as { seq: number; ts: number };
      return { planId: input.planId, done, at, seq: checkin.seq };
    },
    isConcurrencySafe: () => false,
  };

  /** query_ledger 人话回执：按返回体形状判别视角（today 带 date、plans/flows 各带同名数组）。
   *  凭据保留（评审 agent-native O8，2026-09-29）：摘要必须带 planId——取消/打卡/改计划全靠它调工具，
   *  纯计数会让晚间汇报承诺的"帮用户取消"在用户答应那一刻失败；top3 是内置简报指令点名要的数据。
   *  完成面数据（评审 2026-09-30 W1/O3）：今日完成行给晚间汇报、近 30 天完成存档行给每周复盘（doneAt 归类自然周）、
   *  未完成行的打卡 seq 给撤历史卡——模型看不到原始载荷，回执不渲染就等于不存在 */
  const renderQuery = (_args: unknown, value: unknown): ContentBlock[] => {
    const v = value as {
      date?: string;
      streakDays?: number;
      flows?: { category: string }[];
      plans?: { planId?: string; title: string; state?: string; due?: string; doneToday?: boolean; doneAt?: number; checkins?: { seq: number }[] }[];
      top3?: { kind: string; title: string; planId?: string; due?: string }[];
      total?: number;
      truncated?: boolean;
    };
    if (v.date !== undefined) {
      const undone = (v.plans ?? []).filter((p) => p.state !== "done");
      const lines = [
        `${v.date}：${(v.flows ?? []).length} 笔流水、${(v.plans ?? []).length} 个计划（${undone.length} 个未完成）、连续记录 ${v.streakDays} 天`,
      ];
      if ((v.top3 ?? []).length > 0) {
        lines.push(`今日必做：${v.top3!.map((t) => `${t.title}${t.planId !== undefined ? `(${t.planId})` : ""}`).join("；")}`);
      }
      if (undone.length > 0) {
        lines.push(
          `未完成计划：${undone
            .slice(0, 10)
            .map((p) => {
              const seqs = (p.checkins ?? []).slice(0, 2).map((c) => c.seq).join("/"); // 撤历史卡凭据（作废走 void_flow）
              return `${p.title}(${p.planId ?? "?"}, ${p.state ?? "?"}${p.due !== undefined ? `, 截止 ${p.due}` : ""}${seqs !== "" ? `, 打卡${seqs}` : ""})`;
            })
            .join("、")}${undone.length > 10 ? ` 等 ${undone.length} 个` : ""}`,
        );
      }
      const doneTodayList = (v.plans ?? []).filter((p) => p.doneToday === true);
      if (doneTodayList.length > 0) {
        lines.push(`今日完成：${doneTodayList.slice(0, 10).map((p) => p.title).join("、")}${doneTodayList.length > 10 ? ` 等 ${doneTodayList.length} 个` : ""}`);
      }
      // 完成存档行（评审 2026-09-30 W1）：模型只看得见回执，每周复盘按 doneAt 归类自然周全靠这行（载荷窗口 30 天）
      const archive = (v.plans ?? [])
        .filter((p) => p.state === "done" && p.doneAt !== undefined)
        .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
      if (archive.length > 0) {
        const shown = archive.slice(0, 20).map((p) => `${p.title}(${new Date(p.doneAt!).toISOString().slice(5, 10)})`).join("、");
        lines.push(`近 30 天完成 ${archive.length} 条：${shown}${archive.length > 20 ? ` 等 ${archive.length} 条` : ""}`);
      }
      return [{ type: "text", text: lines.join("\n") }];
    }
    if (v.plans !== undefined) {
      const names = v.plans.slice(0, 10).map((p) => `${p.title}(${p.planId ?? "?"}${p.due !== undefined ? `, 截止 ${p.due}` : ""})`).join("；");
      const more = (v.total ?? v.plans.length) - Math.min(10, v.plans.length);
      return [{ type: "text", text: `共 ${v.total} 个计划${v.truncated ? `（列表截断为前 ${v.plans.length} 个）` : ""}：${names}${more > 0 ? ` 等 ${more} 个未列出` : ""}` }];
    }
    if (v.flows !== undefined) {
      const byCategory = new Map<string, number>();
      for (const f of v.flows) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
      const parts = [...byCategory.entries()].map(([category, count]) => `${category}×${count}`).join("、");
      return [{ type: "text", text: `共 ${v.total} 笔流水（${parts}）${v.truncated ? `，列表截断为前 ${v.flows.length} 条` : ""}` }];
    }
    return [{ type: "text", text: JSON.stringify(value) }];
  };

  const queryLedger: ToolDefinition = {
    name: "query_ledger",
    description: "查用户的账本：今天视图（流水+计划+打卡态+Top3）、活跃计划列表、按分类/日期过滤流水。只读。",
    parameters: {
      type: "object",
      required: ["what"],
      properties: {
        what: { type: "string", description: "today | plans | flows" },
        category: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", description: "plans/flows 返回条数上限（默认 200），截断时带 total 与 truncated" },
      },
    },
    output: { schema: { type: "object" }, render: renderQuery },
    async execute(args) {
      const input = (args ?? {}) as { what?: string; category?: string; from?: string; to?: string; limit?: number };
      const limit = input.limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1) throw new Error("limit 需为 ≥1 的整数");
      const active = ledger.activeRecords();
      const tzMin = tz(); // today/flows 按用户档案钟面（2026-09-29），与 UI 请求的 tz 参数同语义
      if (input.what === "today") {
        return todayView(ledger.readAll(), now(), tzMin) as unknown;
      }
      if (input.what === "plans") {
        const all = active
          .filter((r): r is PlanRecord => r.kind === "plan")
          .map(({ planId, title, scope, due }) => ({
            planId, title, scope,
            ...(due !== undefined ? { due } : {}),
          }));
        return { plans: all.slice(0, limit), total: all.length, truncated: all.length > limit };
      }
      if (input.what === "flows") {
        // from/to 过滤按用户档案当地日近似（与 today 同钟面；粗粒度够用）
        const dayKey = (ts: number) => Math.floor((ts + tzMin * 60000) / 86400000);
        const fromKey = input.from !== undefined ? Math.floor((Date.parse(input.from + "T00:00:00Z") + tzMin * 60000) / 86400000) : -Infinity;
        const toKey = input.to !== undefined ? Math.floor((Date.parse(input.to + "T00:00:00Z") + tzMin * 60000) / 86400000) + 1 : Infinity;
        const filtered = active
          .filter((r) => r.kind === "event")
          .map((r) => r as { seq: number; time: number; category: string; note?: string; value?: number; unit?: string })
          .filter((r) => dayKey(r.time) >= fromKey && dayKey(r.time) < toKey)
          .filter((r) => input.category === undefined || r.category === input.category)
          .sort((a, b) => b.time - a.time || b.seq - a.seq); // 时间倒序，同刻按后记优先（limit 截断稳定）
        return { flows: filtered.slice(0, limit), total: filtered.length, truncated: filtered.length > limit }; // seq 是作废（void_flow）的引用凭据
      }
      throw new Error("what 必须是 today | plans | flows");
    },
    isConcurrencySafe: () => true,
  };

  const voidFlow: ToolDefinition = {
    name: "void_flow",
    description:
      "作废一笔记错/重复的流水，或撤销一条打错的打卡（seq 从 query_ledger 的 flows / today 计划的 checkins / 打卡回执拿）。修正流水 = 作废后用 record_flow 重记，不要原地补偿。",
    parameters: {
      type: "object",
      required: ["seq"],
      properties: {
        seq: { type: "integer", description: "要作废的流水或打卡的 seq" },
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
      const hit = ledger.activeRecords().find((r) => r.seq === seq);
      if (!hit) throw new Error(`seq ${seq} 不是有效记录，先用 query_ledger 查`);
      if (hit.kind === "plan") throw new Error(`seq ${seq} 是计划，取消计划用 cancel_plan`);
      if (hit.kind === "goal") throw new Error(`seq ${seq} 是历史目标条目（目标层级已下线），不可作废`);
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

  return [recordFlow, createPlan, updatePlan, checkinPlan, queryLedger, voidFlow, cancelPlan];
}
