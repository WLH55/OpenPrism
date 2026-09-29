// 录入工具（D3.4 同源铁律：模型只能经工具写账本；UI 是另一写入方，source 语义不同）。
// 七件（2026-09-29 补 update_plan + 补撤卡）：record_flow / create_plan / update_plan（追加新版本+void 旧记录，planId 稳定）/
// checkin_plan（date/time 可补历史卡）/ query_ledger 只读（goalId 过滤+limit）/ void_flow（流水作废+打卡撤销）+cancel_plan 走作废回路。
// goal 三件（2026-09-28 B2，SDD 个人工作台业务借鉴）：create_goal / update_goal（修订=追加快照）/
// query_ledger what=goals；create_plan 增 goalId 等价外键。
// execute 返回 canonical JSON value；render 产出人话文本块（模型输入与 UI 回执共用）。

import { randomUUID } from "node:crypto";
import type { ContentBlock, ToolDefinition } from "../harness/index";
import { latestGoalSnapshots, validateGoalParenting } from "./goals";
import { goalView, todayView } from "./fold";
import { mergePlanUpdate, parseAt } from "./plans";
import type { GoalRecord, Ledger, LedgerActor, PlanRecord } from "./ledger";

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
    description: "建一个计划/待办：今天要做的事、本周目标、带截止日的任务等；可挂到某个目标（方向/阶段/项目）下。",
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
        goalId: { type: "string", description: "挂到的目标 goalId（里程碑用 deadline scope 挂阶段下）" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["planId", "title"],
        properties: { planId: { type: "string" }, title: { type: "string" }, goalTitle: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { title: string; goalTitle?: string };
        return [{ type: "text", text: v.goalTitle ? `已建计划「${v.title}」（${v.goalTitle}）` : `已建计划「${v.title}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { title?: string; scope?: string; due?: string; ndays?: number; goalId?: string };
      if (typeof input.title !== "string" || input.title.trim() === "") throw new Error("title 必填");
      if (input.title.trim().length > 200) throw new Error("title 过长（≤200 字）");
      const scopes = ["day", "week", "month", "year", "ndays", "deadline"] as const;
      const scope = scopes.find((s) => s === input.scope);
      if (!scope) throw new Error(`scope 必须是 ${scopes.join(" | ")}`);
      if (scope === "deadline" && typeof input.due !== "string") throw new Error("scope=deadline 需要 due（YYYY-MM-DD）");
      if (scope === "ndays" && (typeof input.ndays !== "number" || input.ndays < 1)) throw new Error("scope=ndays 需要 ndays ≥ 1");
      const latest = latestGoalSnapshots(ledger.readAll());
      let goalTitle: string | undefined;
      if (input.goalId !== undefined) {
        const goal = latest.get(input.goalId);
        if (!goal) throw new Error(`goalId "${input.goalId}" 不存在，先用 query_ledger what=goals 查`); // 等价外键
        goalTitle = goal.title;
      }
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
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      });
      return { planId, title: input.title.trim(), ...(goalTitle !== undefined ? { goalTitle } : {}) };
    },
    isConcurrencySafe: () => false,
  };

  const updatePlan: ToolDefinition = {
    name: "update_plan",
    description:
      "修改计划：标题/截止日/周期/挂载目标，只传要改的字段，未提供的保持原值。比取消重建好——planId 不变，已打的卡都还在。goalId 传空串 = 解除挂载变独立待办。",
    parameters: {
      type: "object",
      required: ["planId"],
      properties: {
        planId: { type: "string", description: "要改的计划 planId（query_ledger 的 plans 里有）" },
        title: { type: "string" },
        scope: { type: "string", description: "day | week | month | year | ndays | deadline；周期换了就改成用户最新说法" },
        due: { type: "string", description: "截止日 YYYY-MM-DD（scope=deadline 必有）；相对期限换算规则同 create_plan" },
        ndays: { type: "integer", description: "最近 N 天（scope=ndays 必填）" },
        goalId: { type: "string", description: "挂到的目标 goalId；空串 = 解除挂载" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["planId", "title"],
        properties: { planId: { type: "string" }, title: { type: "string" }, goalTitle: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { title: string; goalTitle?: string };
        return [{ type: "text", text: v.goalTitle ? `已更新计划「${v.title}」（${v.goalTitle}）` : `已更新计划「${v.title}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { planId?: string; title?: string; scope?: string; due?: string; ndays?: number; goalId?: string };
      if (typeof input.planId !== "string" || input.planId === "") throw new Error("planId 必填（query_ledger 的 plans 里有）");
      const hit = ledger.activeRecords().find((r) => r.kind === "plan" && (r as PlanRecord).planId === input.planId);
      if (!hit) throw new Error(`planId "${input.planId}" 不存在，先用 query_ledger 查`);
      const cur = hit as PlanRecord;

      const latest = latestGoalSnapshots(ledger.readAll());
      const merged = mergePlanUpdate(cur, input, latest); // 校验+合并与 UI 路由同源（plans.ts）
      const goalTitle = merged.goalId !== undefined ? latest.get(merged.goalId)?.title : undefined;

      // 追加新版本 + void 旧记录（与「逾期跳过」同构）：planId 稳定 → 历史打卡引用不断，折叠层零感知
      await append({ ...merged, kind: "plan", source: "agent", actor: actor() });
      await append({ kind: "void", source: "agent", actor: actor(), targetSeq: cur.seq, reason: "更新计划" });
      return { planId: merged.planId, title: merged.title, ...(goalTitle !== undefined ? { goalTitle } : {}) };
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

  /** query_ledger 人话回执：按返回体形状判别视角（today 带 date、plans/flows 各带同名数组、goals 带 directions）。
   *  凭据保留（评审 agent-native O8，2026-09-29）：摘要必须带 planId——取消/打卡/改计划全靠它调工具，
   *  纯计数会让晚间汇报承诺的"帮用户取消"在用户答应那一刻失败；top3/goalCard 是内置简报指令点名要的数据 */
  const renderQuery = (_args: unknown, value: unknown): ContentBlock[] => {
    const v = value as {
      directions?: { title: string; progress: { done: number; total: number } }[];
      activeDirectionCount?: number;
      activePhaseCount?: number;
      date?: string;
      streakDays?: number;
      flows?: { category: string }[];
      plans?: { planId?: string; title: string; state?: string; due?: string }[];
      top3?: { kind: string; title: string; planId?: string; due?: string }[];
      goalCard?: { directions: { title: string; progress: { done: number; total: number } }[] };
      total?: number;
      truncated?: boolean;
    };
    if (v.directions !== undefined) {
      const lines = v.directions.map((d) => `${d.title} ${d.progress.done}/${d.progress.total}`).join("；");
      return [{ type: "text", text: `${v.activeDirectionCount} 个方向、${v.activePhaseCount} 个阶段：${lines}` }];
    }
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
            .map((p) => `${p.title}(${p.planId ?? "?"}, ${p.state ?? "?"}${p.due !== undefined ? `, 截止 ${p.due}` : ""})`)
            .join("、")}${undone.length > 10 ? ` 等 ${undone.length} 个` : ""}`,
        );
      }
      const dirs = v.goalCard?.directions ?? [];
      if (dirs.length > 0) {
        lines.push(`方向进度：${dirs.map((d) => `${d.title} ${d.progress.done}/${d.progress.total}`).join("；")}`);
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
    description: "查用户的账本：今天视图（流水+计划+打卡态+Top3）、目标层级树（方向/阶段/项目+进度）、活跃计划列表（可按 goalId 过滤）、按分类/日期过滤流水。只读。",
    parameters: {
      type: "object",
      required: ["what"],
      properties: {
        what: { type: "string", description: "today | goals | plans | flows" },
        category: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        goalId: { type: "string", description: "what=plans 时只看挂该目标下的计划" },
        limit: { type: "integer", description: "plans/flows 返回条数上限（默认 200），截断时带 total 与 truncated" },
      },
    },
    output: { schema: { type: "object" }, render: renderQuery },
    async execute(args) {
      const input = (args ?? {}) as { what?: string; category?: string; from?: string; to?: string; goalId?: string; limit?: number };
      const limit = input.limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1) throw new Error("limit 需为 ≥1 的整数");
      const active = ledger.activeRecords();
      const tzMin = tz(); // today/goals/flows 全按用户档案钟面（2026-09-29），与 UI 请求的 tz 参数同语义
      if (input.what === "today") {
        return todayView(ledger.readAll(), now(), tzMin) as unknown;
      }
      if (input.what === "goals") {
        return goalView(ledger.readAll(), now(), tzMin) as unknown; // 层级树 + 各级进度（建/改目标前先查 goalId）
      }
      if (input.what === "plans") {
        const all = active
          .filter((r): r is PlanRecord => r.kind === "plan")
          .filter((r) => input.goalId === undefined || r.goalId === input.goalId)
          .map(({ planId, title, scope, due, goalId }) => ({
            planId, title, scope,
            ...(due !== undefined ? { due } : {}),
            ...(goalId !== undefined ? { goalId } : {}), // 归属目标（打卡/调整时定位层级用）
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
      throw new Error("what 必须是 today | goals | plans | flows");
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
      if (hit.kind === "goal") throw new Error(`seq ${seq} 是目标，目标不走作废（修订用 update_goal）`);
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

  const createGoal: ToolDefinition = {
    name: "create_goal",
    description:
      "建一个目标：direction（长期方向，最多建议同时 3 个）/ phase（8-12 周阶段计划，挂在 direction 下）/ project（项目，挂在 phase 或 direction 下）。要做的事（下一步/行动/里程碑，都是同一种东西）不在这里建——用 create_plan（scope=deadline）挂到阶段下，第一条未完成的自动成为下一步。",
    parameters: {
      type: "object",
      required: ["level", "title"],
      properties: {
        level: { type: "string", description: "direction | phase | project" },
        title: { type: "string" },
        parentId: { type: "string", description: "phase/project 必填：父目标 goalId（query_ledger what=goals 拿）" },
        why: { type: "string", description: "direction：为什么重要" },
        outcome: { type: "string", description: "可验收的预期结果" },
        metric: { type: "string", description: "direction：衡量指标" },
        due: { type: "string", description: "YYYY-MM-DD（阶段截止日常用）。相对期限（本周内/本月内…）取该周期最后一天，与 create_plan 同规" },
        nextStep: { type: "string", description: "（已弃用）下一步统一用 create_plan 建打卡点表达——阶段下第一条未完成的打卡点就是下一步" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["goalId", "title"],
        properties: { goalId: { type: "string" }, title: { type: "string" }, hint: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { title: string; hint?: string };
        return [{ type: "text", text: v.hint ? `已建目标「${v.title}」——${v.hint}` : `已建目标「${v.title}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as Record<string, string>;
      if (typeof input.title !== "string" || input.title.trim() === "") throw new Error("title 必填");
      if (input.title.trim().length > 200) throw new Error("title 过长（≤200 字）");
      const levels = ["direction", "phase", "project"] as const;
      const level = levels.find((l) => l === input.level);
      if (!level) throw new Error(`level 必须是 ${levels.join(" | ")}`);
      const latest = latestGoalSnapshots(ledger.readAll());
      validateGoalParenting(level, "", input.parentId, latest); // 新建无环可言，只校验层级与存在性
      // 软约束（不 block）：同层 active ≥3 时在回执里提醒聚焦
      let hint: string | undefined;
      const activeOfLevel = [...latest.values()].filter((g) => g.level === level && g.status === "active").length;
      if (activeOfLevel >= 3) hint = `该层级已有 ${activeOfLevel} 个进行中，同时推进太多容易分散注意力，建议先聚焦 3 个以内`;
      const goalId = `goal-${randomUUID().slice(0, 8)}`;
      await append({
        kind: "goal",
        source: "agent",
        actor: actor(),
        goalId,
        level,
        title: input.title.trim(),
        status: "active",
        ...(input.parentId !== undefined && input.parentId !== "" ? { parentId: input.parentId } : {}),
        ...(input.why !== undefined && input.why !== "" ? { why: input.why } : {}),
        ...(input.outcome !== undefined && input.outcome !== "" ? { outcome: input.outcome } : {}),
        ...(input.metric !== undefined && input.metric !== "" ? { metric: input.metric } : {}),
        ...(input.due !== undefined && input.due !== "" ? { due: input.due } : {}),
        ...(input.nextStep !== undefined && input.nextStep !== "" ? { nextStep: input.nextStep } : {}),
      });
      return { goalId, title: input.title.trim(), ...(hint !== undefined ? { hint } : {}) };
    },
    isConcurrencySafe: () => false,
  };

  const updateGoal: ToolDefinition = {
    name: "update_goal",
    description:
      "修改目标（标题/字段/状态/父级）：只传要改的字段，未提供的字段保持原值（部分更新）；追加新快照生效，历史保留。status：active | paused | done | archived；level 创建后不可改。goalId 从 query_ledger what=goals 拿。",
    parameters: {
      type: "object",
      required: ["goalId"],
      properties: {
        goalId: { type: "string" },
        title: { type: "string" },
        status: { type: "string", description: "active | paused | done | archived" },
        parentId: { type: "string", description: "父目标 goalId；空串 = 解除父级" },
        why: { type: "string" },
        outcome: { type: "string" },
        metric: { type: "string" },
        due: { type: "string", description: "YYYY-MM-DD；相对期限换算同 create_plan" },
        nextStep: { type: "string", description: "（已弃用）下一步统一用 create_plan 建打卡点表达——阶段下第一条未完成的打卡点就是下一步" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["goalId", "title", "status"],
        properties: { goalId: { type: "string" }, title: { type: "string" }, status: { type: "string" } },
      },
      render: (args, value) => {
        const v = value as { title: string; status: string };
        const statusLabel: Record<string, string> = { active: "进行中", paused: "已暂停", done: "已完成", archived: "已归档" };
        // 弃用回执 hint（评审 O5，2026-09-29）：模型用 nextStep 时当面提醒，别让它静默产生只有 UI「转为打卡点」才能收敛的存量数据
        const hint =
          (args as { nextStep?: unknown } | undefined)?.nextStep !== undefined
            ? "（注意：nextStep 已弃用——下一步=阶段下第一条未完成打卡点，建议改用 create_plan 建打卡点）"
            : "";
        return [{ type: "text", text: `已更新「${v.title}」（${statusLabel[v.status] ?? v.status}）${hint}` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as Record<string, string>;
      if (typeof input.goalId !== "string" || input.goalId === "") throw new Error("goalId 必填（query_ledger what=goals 拿）");
      const latest = latestGoalSnapshots(ledger.readAll());
      const cur = latest.get(input.goalId);
      if (!cur) throw new Error(`goalId "${input.goalId}" 不存在，先用 query_ledger what=goals 查`);
      const statuses = ["active", "paused", "done", "archived"] as const;
      if (input.status !== undefined && !statuses.some((s) => s === input.status)) {
        throw new Error(`status 必须是 ${statuses.join(" | ")}`);
      }
      // 合并新快照：未提供的字段沿用当前值
      const optStr = (value: unknown, max = 2000): string | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || value.length > max) throw new Error(`字段需为不超过 ${max} 字的字符串`);
        return value;
      };
      const newTitle = typeof input.title === "string" ? input.title.trim() : undefined;
      if (newTitle !== undefined && newTitle.length > 200) throw new Error("title 过长（≤200 字）");
      const parentIdRaw = optStr(input.parentId, 200);
      const merged = {
        ...cur,
        ...(newTitle !== undefined && newTitle !== "" ? { title: newTitle } : {}), // 空白串视为未提供（与 create 同规）
        ...(input.status !== undefined ? { status: input.status as GoalRecord["status"] } : {}),
        ...(input.parentId !== undefined ? { ...(parentIdRaw === "" ? {} : { parentId: parentIdRaw }) } : {}), // 空串=解除父级（与 PUT 路由同语义）
        ...(optStr(input.why) !== undefined ? { why: optStr(input.why) } : {}),
        ...(optStr(input.outcome) !== undefined ? { outcome: optStr(input.outcome) } : {}),
        ...(optStr(input.metric) !== undefined ? { metric: optStr(input.metric) } : {}),
        ...(optStr(input.due, 200) !== undefined ? { due: optStr(input.due, 200) } : {}),
        ...(optStr(input.nextStep) !== undefined ? { nextStep: optStr(input.nextStep) } : {}),
      };
      validateGoalParenting(merged.level, merged.goalId, merged.parentId, latest); // 换父级时校验层级 + 环
      // 展开在前、显式覆盖在后：source/actor 以本次落账为准（seq/ts 由 append 重分配）
      await append({ ...merged, kind: "goal", source: "agent", actor: actor() });
      return { goalId: merged.goalId, title: merged.title, status: merged.status };
    },
    isConcurrencySafe: () => false,
  };

  const deleteGoal: ToolDefinition = {
    name: "delete_goal",
    description:
      "删除一个目标（真删=作废该 goalId 全部快照，历史留痕）：其下还有存活的阶段/项目时不放行，先删子再删父；挂在该目标上的打卡点计划会保留（只解除挂靠，不连坐）。goalId 从 query_ledger what=goals 拿。修订改名等用 update_goal，别用这个。",
    parameters: {
      type: "object",
      required: ["goalId"],
      properties: {
        goalId: { type: "string" },
        reason: { type: "string", description: "删除原因（如：建错了）" },
      },
    },
    output: {
      schema: { type: "object", required: ["goalId", "voided"], properties: { goalId: { type: "string" }, voided: { type: "integer" } } },
      render: (_args, value) => {
        const v = value as { goalId: string; voided: number };
        return [{ type: "text", text: `已删除目标 ${v.goalId}（作废 ${v.voided} 条快照，留痕可审计）` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { goalId?: string; reason?: string };
      if (typeof input.goalId !== "string" || input.goalId === "") throw new Error("goalId 必填（query_ledger what=goals 拿）");
      const records = ledger.readAll();
      const latest = latestGoalSnapshots(records);
      if (!latest.has(input.goalId)) throw new Error(`goalId "${input.goalId}" 不存在，先用 query_ledger what=goals 查`);
      // 有存活子目标不放行（与 DELETE /api/goals 同语义）：静默提根会偷改树结构
      if ([...latest.values()].some((g) => g.parentId === input.goalId)) {
        throw new Error("其下还有阶段/项目——先删除它们，再删这个目标");
      }
      const voidedSeqs = new Set(records.filter((r) => r.kind === "void").map((r) => (r as { targetSeq: number }).targetSeq));
      const seqs = records.filter((r) => r.kind === "goal" && (r as GoalRecord).goalId === input.goalId && !voidedSeqs.has(r.seq)).map((r) => r.seq);
      for (const seq of seqs) {
        await append({
          kind: "void",
          source: "agent",
          actor: actor(),
          targetSeq: seq,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
      }
      return { goalId: input.goalId, voided: seqs.length };
    },
    isConcurrencySafe: () => false,
  };

  return [recordFlow, createPlan, updatePlan, checkinPlan, queryLedger, voidFlow, cancelPlan, createGoal, updateGoal, deleteGoal];
}
