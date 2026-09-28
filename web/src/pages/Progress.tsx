import { useEffect, useState } from "react";
import { api, api4, type GoalNodeLoose, type ProgressLoose } from "../api";
import { catColor } from "../catcolor";

/** 一行迷你条（sparkline）：小图只配一行，不配大版面（B4 图表判据：回答问题才有图） */
function Sparkline({ data, highlightLast = true }: { data: { date: string; count: number }[]; highlightLast?: boolean }) {
  const max = Math.max(1, ...data.map((t) => t.count));
  return (
    <div className="flex items-end gap-1" style={{ height: 28 }}>
      {data.map((t, i) => (
        <div
          key={t.date}
          title={`${t.date}：${t.count} 笔`}
          className="flex-1 rounded-sm"
          style={{
            height: `${Math.max(6, (t.count / max) * 100)}%`,
            background: t.count === 0 ? "var(--surface-2)" : highlightLast && i === data.length - 1 ? "var(--warm)" : "var(--accent)",
          }}
        />
      ))}
    </div>
  );
}

/** 目标进度区（B4）：方向 + 里程碑完成度，点击进计划页 */
function GoalProgress({ onOpenPlans }: { onOpenPlans: () => void }) {
  const [goals, setGoals] = useState<GoalNodeLoose[] | null>(null);
  useEffect(() => {
    void api
      .goals()
      .then((view) => setGoals(view.directions.filter((d) => d.status === "active" || d.progress.total > 0)))
      .catch(() => undefined);
  }, []);
  if (goals === null) return null;
  if (goals.length === 0) {
    return (
      <section className="mb-5 rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-sm text-ink3">
        还没有长期方向——
        <button className="text-accent transition hover:text-accent2" onClick={onOpenPlans}>
          建立第一个方向
        </button>
        ，成长从这里开始有坐标
      </section>
    );
  }
  return (
    <section className="mb-5 rounded-xl border border-line bg-surface p-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">目标进度</h2>
        <button className="text-xs text-ink3 transition hover:text-ink" onClick={onOpenPlans}>
          计划页 →
        </button>
      </div>
      <div className="space-y-2.5">
        {goals.map((g) => (
          <button key={g.goalId} onClick={onOpenPlans} className="w-full text-left">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm text-ink">{g.title}</span>
              {g.progress.total > 0 && (
                <span className="num shrink-0 text-xs text-ink3">
                  里程碑 {g.progress.done}/{g.progress.total}
                </span>
              )}
            </div>
            {g.progress.total > 0 && (
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface2">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(g.progress.rate * 100)}%` }} />
              </div>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

/** 成长页（B4 升级）：四指标带基准 + 行为模式 + 目标进度；小图降为 sparkline（结构照 prototype 页 5 骨架） */
export function Progress({ onOpenPlans }: { onOpenPlans: () => void }) {
  const [view, setView] = useState<ProgressLoose | null>(null);

  useEffect(() => {
    void api4.progress().then(setView).catch(() => undefined);
  }, []);

  if (!view) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <p className="text-sm text-ink3">加载中…</p>
      </div>
    );
  }

  const ratePct = Math.round(view.completion.rate * 100);
  // 近 8 周打卡基准（本周完成率的参照）
  const weekly = view.weeklyDone8w ?? [];
  const doneThisWeek = weekly.at(-1)?.done ?? 0;
  const priorAvg = weekly.length > 1 ? weekly.slice(0, -1).reduce((s, w) => s + w.done, 0) / (weekly.length - 1) : 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">复利向前 · 指标带基准，结论替你算好</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">成长</h1>
      </header>

      {/* 行为模式（B4 元认知）：结论句优先于图表 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">AI 从你的记录里看到</h2>
        {((view.insights ?? []).length === 0) ? (
          <p className="text-sm text-ink3">多记几笔（≥5），这里会开始总结你的规律——时段、分类、坚持节奏</p>
        ) : (
          <ul className="space-y-1.5">
            {(view.insights ?? []).map((text) => (
              <li key={text} className="flex gap-2 text-sm leading-relaxed text-ink">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {text}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 目标进度（B4） */}
      <GoalProgress onOpenPlans={onOpenPlans} />

      {/* 连续（streak）+ 历史最长锚点 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink">连续打卡</h2>
            <p className="mt-0.5 text-xs text-ink3">
              {view.bestStreak > view.streakDays
                ? `历史最长 ${view.bestStreak} 天——还差 ${view.bestStreak - view.streakDays} 天追平`
                : "断过就是从零再来，但历史最长就是你"}
            </p>
          </div>
          <div className="text-right">
            <div className="num text-3xl font-semibold text-warm">{view.streakDays}</div>
            <div className="text-xs text-ink3">天</div>
          </div>
        </div>
        <div className="mt-3">
          <Sparkline data={(view.trend14 ?? []).slice(-7)} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-ink3">
          <span>7 天前</span>
          <span>今天</span>
        </div>
      </section>

      {/* 完成率（本期计划）+ 周均基准 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">本周计划完成率</h2>
        <p className="mt-0.5 text-xs text-ink3">
          本周期 {view.completion.total} 项，完成 {view.completion.done} 项
          {priorAvg > 0 ? ` · 近 8 周周均打卡 ${priorAvg.toFixed(1)} 次（本周已 ${doneThisWeek} 次）` : ""}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface2">
            <div className="num h-full rounded-full bg-accent" style={{ width: `${ratePct}%` }} />
          </div>
          <span className="num text-sm font-semibold text-ink">{ratePct}%</span>
        </div>
        {view.completion.total === 0 && (
          <p className="mt-2 text-xs text-ink3">
            还没有计划——
            <button className="text-accent transition hover:text-accent2" onClick={onOpenPlans}>
              去计划页
            </button>
            给阶段加个里程碑，或跟助手说一句
          </p>
        )}
      </section>

      {/* 趋势对照（本周 vs 上周） */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">本周 vs 上周</h2>
        <p className="mt-0.5 text-xs text-ink3">环比变化（笔数），向上 = 在变好</p>
        <div className="mt-4 space-y-3">
          {view.weekOverWeek.length === 0 && <p className="text-sm text-ink3">本周还没有记录</p>}
          {view.weekOverWeek.map((w) => {
            const sum = w.thisWeek + w.lastWeek;
            const thisPct = sum === 0 ? 0 : (w.thisWeek / sum) * 100;
            const down = w.deltaPct !== null && w.deltaPct < 0;
            return (
              <div key={w.category} className="flex items-center gap-3">
                <span className="flex w-14 shrink-0 items-center gap-1.5 text-sm text-ink2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: catColor(w.category) }} />
                  <span className="truncate">{w.category}</span>
                </span>
                <div className="flex-1">
                  <div className="mb-1 flex justify-between text-xs text-ink3">
                    <span>本周 {w.thisWeek} 笔</span>
                    <span>上周 {w.lastWeek} 笔</span>
                  </div>
                  <div className="flex h-2 gap-1">
                    <div className="rounded-full" style={{ width: `${thisPct}%`, background: down ? "var(--warm)" : "var(--accent)" }} />
                    <div className="rounded-full bg-surface2" style={{ width: `${100 - thisPct}%` }} />
                  </div>
                </div>
                <span
                  className="num w-12 shrink-0 text-right text-sm font-medium"
                  style={{ color: w.deltaPct === null ? "var(--ink-3)" : down ? "var(--warm)" : "var(--accent)" }}
                >
                  {w.deltaPct === null ? "新增" : `${w.deltaPct > 0 ? "+" : ""}${w.deltaPct}%`}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* 近 14 天趋势：sparkline 一行（大图降级） */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">近 14 天记录趋势</h2>
          <span className="num text-xs text-ink3">单位：笔</span>
        </div>
        <Sparkline data={view.trend14 ?? []} highlightLast={false} />
        <div className="mt-1 flex justify-between text-[10px] text-ink3">
          <span>14 天前</span>
          <span>今天</span>
        </div>
      </section>
    </div>
  );
}
