import { useEffect, useState } from "react";
import { api4, type ProgressLoose } from "../api";
import { catColor } from "../catcolor";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** 成长页：连续火柴棍 + 完成率进度条 + 环比双条，结构照 prototype 页 5 */
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
  // 近 7 天火柴棍（末位 = 今天）
  const week = view.trend14.slice(-7);
  const maxWeek = Math.max(1, ...week.map((t) => t.count));
  const barH = (count: number): string => `${Math.max(8, (count / maxWeek) * 100)}%`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">复利向前 · 四个可计算的指标</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">成长</h1>
      </header>

      {/* 连续（streak） */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink">连续打卡</h2>
            <p className="mt-0.5 text-xs text-ink3">你保持记录的最长动力，断了就是"从零再来"</p>
          </div>
          <div className="text-right">
            <div className="num text-3xl font-semibold text-warm">{view.streakDays}</div>
            <div className="text-xs text-ink3">天</div>
          </div>
        </div>
        {/* 7 天小火柴棍 */}
        <div className="mt-4 flex items-end gap-2">
          {week.map((t, i) => {
            const isToday = i === week.length - 1;
            const day = new Date(`${t.date}T00:00:00`);
            return (
              <div key={t.date} className="flex-1 text-center" title={`${t.date}：${t.count} 笔`}>
                <div
                  className={`mx-auto w-full max-w-8 rounded ${t.count === 0 ? "bg-surface2" : isToday ? "bg-warm" : "bg-accent"}`}
                  style={{ height: barH(t.count) }}
                />
                <div className="mt-1 text-[10px] text-ink3">{isToday ? "今天" : WEEKDAY[day.getDay()]}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 完成率（本期计划） */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">本周计划完成率</h2>
        <p className="mt-0.5 text-xs text-ink3">
          本周期 {view.completion.total} 项，完成 {view.completion.done} 项
        </p>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface2">
            <div className="num h-full rounded-full bg-accent" style={{ width: `${ratePct}%` }} />
          </div>
          <span className="num text-sm font-semibold text-ink">{ratePct}%</span>
        </div>
        {view.completion.total === 0 && (
          <p className="mt-2 text-xs text-ink3">还没有计划——跟助手说一句就能建</p>
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

      {/* 近 14 天趋势（小柱） */}
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">近 14 天记录趋势</h2>
          <span className="num text-xs text-ink3">单位：笔</span>
        </div>
        <div className="flex items-end gap-1.5" style={{ height: 72 }}>
          {view.trend14.map((t) => {
            const max = Math.max(1, ...view.trend14.map((x) => x.count));
            return (
              <div
                key={t.date}
                title={`${t.date}：${t.count} 笔`}
                className="flex-1 rounded"
                style={{
                  height: `${Math.max(6, (t.count / max) * 100)}%`,
                  background: t.count === 0 ? "var(--surface-2)" : "var(--accent)",
                }}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
