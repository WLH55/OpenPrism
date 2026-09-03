import { useEffect, useState } from "react";
import { api4, type ProgressLoose } from "../api";

export function Progress() {
  const [view, setView] = useState<ProgressLoose | null>(null);

  useEffect(() => {
    void api4.progress().then(setView).catch(() => undefined);
  }, []);

  if (!view) {
    return (
      <div className="page">
        <p className="muted">加载中…</p>
      </div>
    );
  }
  const maxTrend = Math.max(1, ...view.trend14.map((t) => t.count));
  const ratePct = Math.round(view.completion.rate * 100);

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: "0 0 4px" }}>成长</h1>
      <p className="muted">复利四指标 · 全部由账本确定性折叠</p>

      <div className="stat-grid">
        <div className="card">
          <div className="muted">连续记录</div>
          <div className="num" style={{ color: "var(--warm)" }}>
            {view.streakDays} <span style={{ fontSize: 13 }}>天</span>
          </div>
        </div>
        <div className="card">
          <div className="muted">计划完成</div>
          <div className="num">
            {view.completion.done}/{view.completion.total}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {ratePct}%
          </div>
        </div>
        <div className="card">
          <div className="muted">活跃分类（本周）</div>
          <div className="num">{view.weekOverWeek.length}</div>
        </div>
      </div>

      <div className="section-title">近 14 天记录趋势</div>
      <div className="card">
        <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 72 }}>
          {view.trend14.map((t) => (
            <div
              key={t.date}
              title={`${t.date}：${t.count} 笔`}
              style={{
                flex: 1,
                height: `${Math.max(6, (t.count / maxTrend) * 100)}%`,
                borderRadius: 3,
                background: t.count === 0 ? "var(--surface-2)" : "var(--accent)",
              }}
            />
          ))}
        </div>
      </div>

      <div className="section-title">本周 vs 上周（笔数）</div>
      <div className="card" style={{ padding: 0 }}>
        {view.weekOverWeek.length === 0 && <div className="flow-row muted">本周还没有记录</div>}
        {view.weekOverWeek.map((w) => (
          <div key={w.category} className="flow-row">
            <div className="meta">
              <div>{w.category}</div>
              <div className="sub">
                本周 {w.thisWeek} 笔 · 上周 {w.lastWeek} 笔
              </div>
            </div>
            <span style={{ fontVariantNumeric: "tabular-nums", color: w.deltaPct !== null && w.deltaPct < 0 ? "var(--warm)" : "var(--accent)" }}>
              {w.deltaPct === null ? "新增" : `${w.deltaPct > 0 ? "+" : ""}${w.deltaPct}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
