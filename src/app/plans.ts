// 计划共享逻辑（2026-09-29 SDD 撤历史打卡与UI计划编辑补卡）：工具（update_plan）与 UI 路由（PUT /api/plans）同源，
// 防两侧校验/合并规则漂移（goals.ts validateGoalParenting 同模式）。修订 = 追加新版本 + void 旧记录（planId 稳定）。

import type { GoalRecord, PlanRecord } from "./ledger";

/** 时刻解析（record_flow/checkin_plan 的补卡共用）：
 * date 缺省=注入时钟的今天、time 缺省=当前时分；date 晚于当地今天抛错（未来不可预记） */
export function parseAt(date: string | undefined, time: string | undefined, now: number): number {
  const base = new Date(now);
  if (date !== undefined) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error(`invalid date "${date}"，期望 YYYY-MM-DD`);
    base.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const dayStart = (d: Date) => {
      const copy = new Date(d);
      copy.setHours(0, 0, 0, 0);
      return copy.getTime();
    };
    if (dayStart(base) > dayStart(new Date(now))) throw new Error("date 不能是未来日期");
  }
  if (time !== undefined) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
    if (!match) throw new Error(`invalid time "${time}"，期望 HH:mm`);
    base.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  }
  return base.getTime();
}

/** 计划修订的校验+合并（纯函数，返回 append payload 的业务字段；seq/ts/source/actor 由调用方按写入方落账）。
 * 部分更新语义：title 空白串=未提供、goalId 空串=解除挂载、undefined=沿用；周期切换不残留 due/ndays。 */
export function mergePlanUpdate(
  cur: PlanRecord,
  changes: { title?: string; scope?: string; due?: string; ndays?: number; goalId?: string },
  latestGoals: Map<string, GoalRecord>,
): Omit<PlanRecord, "seq" | "ts" | "source" | "actor"> {
  const scopes = ["day", "week", "month", "year", "ndays", "deadline"] as const;
  const nextScope = changes.scope !== undefined ? scopes.find((s) => s === changes.scope) : undefined;
  if (changes.scope !== undefined && !nextScope) throw new Error(`scope 必须是 ${scopes.join(" | ")}`);

  const newTitle = typeof changes.title === "string" ? changes.title.trim() : undefined;
  if (newTitle !== undefined && newTitle.length > 200) throw new Error("title 过长（≤200 字）");

  // goalId 三态：undefined = 沿用旧挂载；空串 = 解除；非空 = 换挂（校验存在）
  let nextGoalId: string | undefined | null = cur.goalId;
  if (changes.goalId === "") nextGoalId = null;
  else if (changes.goalId !== undefined) {
    const goal = latestGoals.get(changes.goalId);
    if (!goal) throw new Error(`goalId "${changes.goalId}" 不存在，先用 query_ledger what=goals 查`);
    nextGoalId = changes.goalId;
  }

  const mergedScope = nextScope ?? cur.scope;
  const nextDue = mergedScope === "deadline" ? (changes.due ?? cur.due) : undefined;
  const nextNdays = mergedScope === "ndays" ? (changes.ndays ?? cur.ndays) : undefined;
  if (mergedScope === "deadline" && typeof nextDue !== "string") throw new Error("scope=deadline 需要 due（YYYY-MM-DD）");
  // due 是折叠层字典序比较的键（POST /api/plans 簇 C 同规）：非 ISO 日期会让逾期判定永久出错
  if (mergedScope === "deadline" && !/^\d{4}-\d{2}-\d{2}$/.test(nextDue!) ) {
    throw new Error("due 需为合法日期 YYYY-MM-DD（如 2026-10-04）");
  }
  if (mergedScope === "ndays" && (typeof nextNdays !== "number" || nextNdays < 1)) throw new Error("scope=ndays 需要 ndays ≥ 1");

  // 先剥离旧凭据与周期专属字段，再按 mergedScope 按需重建
  const { seq: _seq, ts: _ts, source: _source, actor: _actor, due: _oldDue, ndays: _oldNdays, goalId: _oldGoalId, ...snapshot } = cur;
  return {
    ...snapshot,
    ...(newTitle !== undefined && newTitle !== "" ? { title: newTitle } : {}),
    scope: mergedScope,
    ...(nextDue !== undefined ? { due: nextDue } : {}),
    ...(nextNdays !== undefined ? { ndays: nextNdays } : {}),
    ...(nextGoalId !== null && nextGoalId !== undefined ? { goalId: nextGoalId } : {}),
  };
}
