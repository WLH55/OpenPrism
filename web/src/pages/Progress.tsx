import { useEffect, useState } from "react";
import { api4, type ProgressLoose } from "../api";
import { catColor } from "../catcolor";

/** 成长页（B4 升级）：指标带基准 + 行为模式（目标进度区随目标层级 2026-09-30 下线移除） */
export function Progress() {
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
          <p className="mt-2 text-xs text-ink3">还没有计划——直接跟助手说一句，它会帮你建好</p>
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
    </div>
  );
}
