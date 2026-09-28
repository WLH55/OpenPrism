import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type GoalNodeLoose, type GoalsPageLoose } from "../api";
import { CheckSolidIcon } from "../icons";

const LEVEL_LABEL: Record<GoalNodeLoose["level"], string> = {
  direction: "方向",
  phase: "阶段",
  project: "项目",
};

const STATUS_LABEL: Record<GoalNodeLoose["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  done: "已完成",
  archived: "已归档",
};

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function daysLeft(due: string): number | null {
  if (due === "") return null;
  const today = new Date();
  const dueDate = new Date(`${due}T00:00:00`);
  if (Number.isNaN(dueDate.getTime())) return null;
  return Math.floor((dueDate.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
}

/** 进度条：里程碑完成度（无里程碑时隐藏，不给无意义的空条） */
function ProgressBar({ progress }: { progress: { done: number; total: number; rate: number } }) {
  if (progress.total === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface2">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: pct(progress.rate) }} />
      </div>
      <span className="num shrink-0 text-xs text-ink3">
        {progress.done}/{progress.total}
      </span>
    </div>
  );
}

/** 创建表单（方向/阶段共用；阶段带 parentId） */
function GoalForm({
  level,
  parentId,
  onDone,
  onCancel,
}: {
  level: GoalNodeLoose["level"];
  parentId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (title.trim() === "") {
      setError("标题必填");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createGoal({
        level,
        title: title.trim(),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(outcome.trim() !== "" ? { outcome: outcome.trim() } : {}),
        ...(due !== "" ? { due } : {}),
      });
      onDone();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const field = "rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent";
  return (
    <div className="mb-4 rounded-xl border border-accent/40 bg-surface p-4">
      <div className="mb-2 text-sm font-medium text-ink">
        {parentId !== undefined ? "新阶段（8—12 周，挂在此方向下）" : "新方向（长期想要什么）"}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input className={field} placeholder={level === "direction" ? "方向标题（如：更健康的身体）" : "阶段标题（如：8 周减脂）"} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className={field} placeholder="预期结果（可验收，如：体重降到 70kg）" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        {level === "phase" && (
          <input className={field} type="date" value={due} onChange={(e) => setDue(e.target.value)} title="阶段截止日" />
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void submit()}>
          建立
        </button>
        <button className="text-sm text-ink3 transition hover:text-ink" onClick={onCancel}>
          取消
        </button>
        {error && <span className="text-sm text-warm">{error}</span>}
      </div>
    </div>
  );
}

/**
 * 里程碑行：点圈打卡；撤销 = 作废那条打卡记录（#A，2026-09-28）。
 * 里程碑完成判定是 doneEver（打过一次就算），追加 done:false 打卡不会撤销它——所以撤销走账本作废回路，历史留痕。
 * 无存活打卡 seq（旧服务端）时退化为静态完成态，不给"可点"的假象。
 */
function MilestoneRow({ planId, title, due, done, doneSeqs, isNext = false, onChanged }: { planId: string; title: string; due: string; done: boolean; doneSeqs: number[]; isNext?: boolean; onChanged: () => void }) {
  const left = daysLeft(due);
  const undoable = done && doneSeqs.length > 0;
  const toggle = async () => {
    if (done) {
      for (const seq of doneSeqs) await api.voidRecord(seq);
    } else {
      await api.checkin(planId, true);
    }
    onChanged();
  };
  const hint = done ? (undoable ? "点击撤销打卡（作废该打卡记录，历史留痕）" : "已完成") : "点击打卡";
  return (
    <button
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-surface2/60 disabled:cursor-default disabled:hover:bg-transparent"
      disabled={done && !undoable}
      onClick={() => void toggle()}
      title={hint}
    >
      {done ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent2 text-white">
          <CheckSolidIcon className="h-2.5 w-2.5" />
        </span>
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-full border-2 border-line" />
      )}
      {isNext && !done && <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">下一步</span>}
      <span className={`flex-1 truncate text-sm ${done ? "text-ink3 line-through" : "text-ink"}`}>{title}</span>
      {due !== "" && (
        <span className={`num shrink-0 text-xs ${!done && left !== null && left < 0 ? "text-warm" : "text-ink3"}`}>
          {due}
          {!done && left !== null && left < 0 ? " · 逾期" : !done && left !== null && left <= 3 ? " · 临近" : ""}
        </span>
      )}
    </button>
  );
}

/**
 * 阶段卡（2026-09-28 统一执行项）：只留一种执行物——打卡点（挂树的 deadline 计划）。
 * 「下一步」= 列表里第一条未完成的打卡点（带徽标，完成自动顶位）；不再有独立的下一步文字字段。
 * 存量阶段还挂着旧 nextStep 文字的，给一行"转为打卡点"入口（转完字段清空，无缝衔接）。
 */
function PhaseCard({ node, milestones, onChanged }: { node: GoalNodeLoose; milestones: GoalsPageLoose["milestones"]; onChanged: () => void }) {
  const [open, setOpen] = useState(true);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [converting, setConverting] = useState(false);
  const left = node.due !== undefined ? daysLeft(node.due) : null;
  const projects = node.children;
  const firstOpenIdx = milestones.findIndex((m) => !m.done);

  const addMilestone = async () => {
    if (milestoneTitle.trim() === "" || milestoneDue === "") return;
    await api.createPlan({ title: milestoneTitle.trim(), scope: "deadline", due: milestoneDue, goalId: node.goalId });
    setMilestoneTitle("");
    setMilestoneDue("");
    setAddingMilestone(false);
    onChanged();
  };

  /** 旧「唯一下一步」文字 → 今天的打卡点 + 清空字段（迁移一次性，转完这行就没了） */
  const convertNextStep = async () => {
    if (converting || !node.nextStep) return;
    setConverting(true);
    try {
      await api.createPlan({ title: node.nextStep, scope: "deadline", due: new Date().toISOString().slice(0, 10), goalId: node.goalId });
      await api.updateGoal(node.goalId, { nextStep: "" });
      onChanged();
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className={`rounded-xl border p-3.5 transition ${node.status !== "active" ? "border-line bg-surface2/40 opacity-75" : "border-line bg-surface"}`}>
      <div className="flex items-start gap-2">
        <button className="mt-0.5 shrink-0 text-ink3 transition hover:text-ink" onClick={() => setOpen(!open)} aria-label={open ? "折叠" : "展开"}>
          <svg className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-medium text-ink">{node.title}</span>
            {node.status !== "active" && <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-ink3">{STATUS_LABEL[node.status]}</span>}
            {node.due !== undefined && (
              <span className={`num text-xs ${node.status === "active" && left !== null && left < 0 ? "text-warm" : "text-ink3"}`}>
                截止 {node.due}
                {node.status === "active" && left !== null && left < 0 ? " · 逾期" : node.status === "active" && left !== null && left <= 7 ? ` · 剩 ${left} 天` : ""}
              </span>
            )}
          </div>
          {node.outcome !== undefined && <p className="mt-1 text-xs text-ink2">{node.outcome}</p>}

          {open && (
            <div className="mt-3 space-y-2">
              <ProgressBar progress={node.progress} />
              {node.recurring.total > 0 && (
                <p className="num text-xs text-ink3">今日计划 {node.recurring.doneToday}/{node.recurring.total}</p>
              )}
              {node.nextStep && (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-accent/40 bg-surface px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink2">旧「下一步」：{node.nextStep}</span>
                  <button className="shrink-0 text-xs text-accent transition hover:text-accent2 disabled:opacity-50" disabled={converting} onClick={() => void convertNextStep()}>
                    转为打卡点
                  </button>
                </div>
              )}
              {milestones.length > 0 && (
                <div className="rounded-lg border border-line/60 bg-surface2/50 p-1">
                  {milestones.map((m, i) => (
                    <MilestoneRow key={m.planId} planId={m.planId} title={m.title} due={m.due} done={m.done} doneSeqs={m.doneSeqs ?? []} isNext={i === firstOpenIdx} onChanged={onChanged} />
                  ))}
                </div>
              )}
              {milestones.length === 0 && !node.nextStep && (
                <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink3">还没有打卡点——把"约教练""首次 5km"这类要做的事加进来，第一条就是下一步</p>
              )}
              {projects.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {projects.map((p) => (
                    <span key={p.goalId} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${p.status === "active" ? "border-line text-ink2" : "border-line text-ink3 line-through"}`}>
                      📁 {p.title}
                      <button
                        className="text-ink3 transition hover:text-warm"
                        title="删除该项目（作废快照留痕）"
                        onClick={async () => {
                          if (!window.confirm(`删除项目「${p.title}」？删除记录留痕可审计。`)) return;
                          try {
                            await api.deleteGoal(p.goalId);
                          } catch (e) {
                            window.alert(String((e as Error).message));
                          }
                          onChanged();
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {node.status === "active" && (
                  <button className="text-xs text-accent transition hover:text-accent2" onClick={() => setAddingMilestone(!addingMilestone)}>
                    ＋打卡点
                  </button>
                )}
                <button
                  className="text-xs text-ink3 transition hover:text-ink"
                  onClick={async () => {
                    await api.updateGoal(node.goalId, { status: node.status === "active" ? "paused" : "active" });
                    onChanged();
                  }}
                >
                  {node.status === "active" ? "暂停" : "恢复"}
                </button>
                {node.status !== "done" && (
                  <button
                    className="text-xs text-ink3 transition hover:text-ink"
                    onClick={async () => {
                      await api.updateGoal(node.goalId, { status: "done" });
                      onChanged();
                    }}
                  >
                    完成阶段
                  </button>
                )}
                <button
                  className="text-xs text-ink3 transition hover:text-warm"
                  title="作废该阶段全部快照（留痕）；其下里程碑计划保留、解除挂靠"
                  onClick={async () => {
                    if (!window.confirm(`删除${LEVEL_LABEL[node.level]}「${node.title}」？删除记录留痕可审计；其下里程碑计划会保留（解除挂靠）。`)) return;
                    try {
                      await api.deleteGoal(node.goalId);
                    } catch (e) {
                      window.alert(String((e as Error).message));
                    }
                    onChanged();
                  }}
                >
                  删除
                </button>
              </div>
              {addingMilestone && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line/60 bg-surface p-2">
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
                    placeholder="打卡点（如：约教练做体测 / 完成首次 5km）"
                    value={milestoneTitle}
                    onChange={(e) => setMilestoneTitle(e.target.value)}
                  />
                  <input className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent" type="date" value={milestoneDue} onChange={(e) => setMilestoneDue(e.target.value)} />
                  <button className="rounded-lg bg-accent2 px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90" onClick={() => void addMilestone()}>
                    加打卡点
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 方向卡：下辖阶段；暂停/完成 */
function DirectionCard({ node, milestones, onChanged }: { node: GoalNodeLoose; milestones: GoalsPageLoose["milestones"]; onChanged: () => void }) {
  const [addingPhase, setAddingPhase] = useState(false);
  const phases = node.children.filter((c) => c.level === "phase" || c.level === "project");
  const directProjects = node.children.filter((c) => c.level === "project");

  return (
    <section className={`rounded-xl border p-4 transition ${node.status !== "active" ? "border-line bg-surface2/40 opacity-80" : "border-line bg-surface"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink3">{LEVEL_LABEL.direction}</span>
            <h2 className="text-lg font-semibold text-ink">{node.title}</h2>
            {node.status !== "active" && <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-ink3">{STATUS_LABEL[node.status]}</span>}
          </div>
          {node.why !== undefined && <p className="mt-1 text-sm text-ink2">为什么：{node.why}</p>}
          {node.outcome !== undefined && <p className="mt-0.5 text-sm text-ink2">预期结果：{node.outcome}</p>}
          {node.metric !== undefined && <p className="mt-0.5 text-xs text-ink3">衡量：{node.metric}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            className="text-xs text-ink3 transition hover:text-ink"
            onClick={async () => {
              await api.updateGoal(node.goalId, { status: node.status === "active" ? "paused" : "active" });
              onChanged();
            }}
          >
            {node.status === "active" ? "暂停" : "恢复"}
          </button>
          {node.status !== "done" && (
            <button
              className="text-xs text-ink3 transition hover:text-ink"
              onClick={async () => {
                await api.updateGoal(node.goalId, { status: "done" });
                onChanged();
              }}
            >
              完成
            </button>
          )}
          <button
            className="text-xs text-ink3 transition hover:text-warm"
            title="作废该方向全部快照（留痕）；有阶段/项目挂着时需先清空"
            onClick={async () => {
              if (!window.confirm(`删除方向「${node.title}」？删除记录留痕可审计；其下需无阶段/项目。`)) return;
              try {
                await api.deleteGoal(node.goalId);
              } catch (e) {
                window.alert(String((e as Error).message));
              }
              onChanged();
            }}
          >
            删除
          </button>
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar progress={node.progress} />
        {node.recurring.total > 0 && <p className="num mt-1.5 text-xs text-ink3">今日计划 {node.recurring.doneToday}/{node.recurring.total}</p>}
      </div>

      <div className="mt-3 space-y-2.5">
        {phases.length === 0 && directProjects.length === 0 && (
          <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-sm text-ink3">
            还没有阶段——建一个 8—12 周的阶段计划，写清可验收的结果和唯一下一步
          </p>
        )}
        {phases.map((phase) => (
          <PhaseCard key={phase.goalId} node={phase} milestones={milestones.filter((m) => m.goalId === phase.goalId)} onChanged={onChanged} />
        ))}
        {node.status === "active" &&
          (addingPhase ? (
            <GoalForm level="phase" parentId={node.goalId} onDone={() => { setAddingPhase(false); onChanged(); }} onCancel={() => setAddingPhase(false)} />
          ) : (
            <button className="text-sm text-accent transition hover:text-accent2" onClick={() => setAddingPhase(true)}>
              ＋ 阶段计划
            </button>
          ))}
      </div>
    </section>
  );
}

/** 计划页（B3，2026-09-28）：方向 → 阶段 → 项目 → 任务的层级视图；里程碑打卡；软约束提示；空状态给行动入口 */
export function Plans() {
  const [view, setView] = useState<GoalsPageLoose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingDirection, setAddingDirection] = useState(false);

  const reload = useCallback(() => {
    api
      .goals()
      .then(setView)
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => reload(), [reload]);

  const sorted = useMemo(() => {
    if (!view) return [];
    const rank = { active: 0, paused: 1, done: 2, archived: 3 } as const;
    return [...view.directions].sort((a, b) => rank[a.status] - rank[b.status] || a.updatedAt - b.updatedAt);
  }, [view]);

  if (!view) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <p className="text-sm text-ink3">{error ?? "加载中…"}</p>
      </div>
    );
  }

  const hasGoals = view.directions.length > 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">让今天的行动，始终连接长期方向</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">计划</h1>
      </header>

      {view.warning !== undefined && (
        <div className="mb-5 rounded-xl border border-warm/40 bg-warm/5 px-4 py-3 text-sm text-warm">{view.warning}</div>
      )}

      {!hasGoals && !addingDirection && (
        <div className="rounded-xl border border-dashed border-line bg-surface px-5 py-8 text-center">
          <p className="text-[15px] text-ink">还没有方向</p>
          <p className="mt-1 text-sm text-ink3">写下 1—3 件长期想做成的事，今天的行动才有对齐的对象</p>
          <button
            className="mt-4 rounded-lg bg-accent2 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            onClick={() => setAddingDirection(true)}
          >
            建立第一个方向
          </button>
        </div>
      )}

      {!hasGoals && addingDirection && <GoalForm level="direction" onDone={() => { setAddingDirection(false); reload(); }} onCancel={() => setAddingDirection(false)} />}

      <div className="space-y-4">
        {sorted.map((direction) => (
          <DirectionCard key={direction.goalId} node={direction} milestones={view.milestones} onChanged={reload} />
        ))}
      </div>

      {hasGoals && (
        <div className="mt-5">
          {addingDirection ? (
            <GoalForm level="direction" onDone={() => { setAddingDirection(false); reload(); }} onCancel={() => setAddingDirection(false)} />
          ) : (
            <button className="text-sm text-accent transition hover:text-accent2" onClick={() => setAddingDirection(true)}>
              ＋ 新方向
            </button>
          )}
        </div>
      )}
    </div>
  );
}
