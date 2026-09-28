// goal 写入校验（2026-09-28 B2，SDD 个人工作台业务借鉴 §4）：工具层与 UI 路由共用。
// 层级规则：direction 无父 / phase 挂 direction / project 挂 phase 或 direction；
// 环检测：换父级时沿新父链上溯不得回到自身（含既有环继承）。
// 数量约束是软的：不在此层 block（spec §3 决策表——agent 建超量提醒不拦截）。

import type { GoalRecord, LedgerRecord } from "./ledger";

/** goalId → 最新快照（同 fold 语义：未 void 的最新 ts 胜出；修订 = 追加，void 仅真删） */
export function latestGoalSnapshots(records: LedgerRecord[]): Map<string, GoalRecord> {
  const voided = new Set(
    records.filter((r): r is Extract<LedgerRecord, { kind: "void" }> => r.kind === "void").map((r) => r.targetSeq),
  );
  const latest = new Map<string, GoalRecord>();
  for (const r of records) {
    if (r.kind !== "goal" || voided.has(r.seq)) continue;
    const cur = latest.get(r.goalId);
    if (cur === undefined || r.ts > cur.ts || (r.ts === cur.ts && r.seq > cur.seq)) latest.set(r.goalId, r);
  }
  return latest;
}

/** 层级与环校验（goalId 传 "" 表示新建——新节点不可能成环，仅校验层级与存在性） */
export function validateGoalParenting(
  level: GoalRecord["level"],
  goalId: string,
  parentId: string | undefined,
  latest: Map<string, GoalRecord>,
): void {
  if (level === "direction") {
    if (parentId !== undefined) throw new Error("direction（长期方向）不挂父级，去掉 parentId");
    return;
  }
  if (parentId === undefined || parentId === "") throw new Error(`${level} 需要 parentId（先用 query_ledger what=goals 查 goalId）`);
  const parent = latest.get(parentId);
  if (!parent) throw new Error(`parentId "${parentId}" 不存在，先用 query_ledger what=goals 查`);
  if (level === "phase" && parent.level !== "direction") throw new Error("phase（阶段计划）只能挂在 direction 下");
  if (level === "project" && parent.level === "project") throw new Error("project（项目）只能挂在 phase 或 direction 下");
  const seen = new Set<string>([goalId]);
  let cur = parent;
  while (cur.parentId !== undefined) {
    if (seen.has(cur.parentId)) throw new Error("parentId 会形成循环引用");
    seen.add(cur.parentId);
    const up = latest.get(cur.parentId);
    if (!up) break;
    cur = up;
  }
}
