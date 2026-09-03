import { useCallback, useEffect, useState } from "react";
import { api, type TodayView } from "../api";

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const SCOPE_LABEL: Record<string, string> = {
  day: "今天",
  week: "本周",
  month: "本月",
  year: "今年",
  ndays: "最近N天",
  deadline: "截止",
};

export function Today() {
  const [view, setView] = useState<TodayView | null>(null);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .today()
      .then(setView)
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  useEffect(() => reload(), [reload]);

  const quickRecord = async () => {
    if (category.trim() === "") {
      setError("分类必填（如：餐饮 / 运动 / 心情）");
      return;
    }
    setError(null);
    await api.quickFlow({
      category: category.trim(),
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
      ...(value.trim() !== "" ? { value: Number(value) } : {}),
      ...(unit.trim() !== "" ? { unit: unit.trim() } : {}),
    });
    setCategory("");
    setNote("");
    setValue("");
    setUnit("");
    reload();
  };

  if (!view) {
    return (
      <div className="page">
        <p className="muted">{error ?? "加载中…"}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div className="muted">{view.date}</div>
          <h1 style={{ margin: "2px 0 0", fontSize: 24 }}>今天</h1>
        </div>
        <span className="muted">面板 = 账本折叠 · 0 token</span>
      </div>

      <div className="stat-grid">
        <div className="card">
          <div className="muted">今日笔数</div>
          <div className="num">{view.flows.length}</div>
        </div>
        <div className="card">
          <div className="muted">计划完成</div>
          <div className="num">
            {view.plans.filter((p) => p.done).length}/{view.plans.length}
          </div>
        </div>
        <div className="card">
          <div className="muted">连续记录</div>
          <div className="num" style={{ color: "var(--warm)" }}>
            {view.streakDays} 天
          </div>
        </div>
      </div>

      <div className="card">
        <div className="muted">快速记录（不经模型，直接落账）</div>
        <div className="quick-form" style={{ marginTop: 10 }}>
          <input className="input" placeholder="分类（必填）" value={category} onChange={(e) => setCategory(e.target.value)} />
          <input className="input" placeholder="备注（如：午餐）" value={note} onChange={(e) => setNote(e.target.value)} />
          <input className="input" placeholder="数值" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
          <input className="input" placeholder="单位（¥/分钟…）" value={unit} onChange={(e) => setUnit(e.target.value)} />
          <button className="btn" onClick={quickRecord}>
            记一笔
          </button>
        </div>
        {error && <p className="hint-err" style={{ fontSize: 13 }}>{error}</p>}
      </div>

      {view.totalByCategory.length > 0 && (
        <div className="cat-total">
          {view.totalByCategory.map((c) => (
            <span key={c.category} className="cat-chip">
              {c.category} <b>{c.total}</b> · {c.count} 笔
            </span>
          ))}
        </div>
      )}

      <div className="section-title">今日计划</div>
      <div className="card" style={{ padding: 0 }}>
        {view.plans.length === 0 && <div className="plan-row muted">今天还没有计划——跟助手说一句就能建</div>}
        {view.plans.map((plan) => (
          <div key={plan.planId} className={`plan-row${plan.done ? " done" : ""}`}>
            <button
              className={`check${plan.done ? " done" : ""}`}
              title={plan.done ? "取消打卡" : "打卡"}
              onClick={async () => {
                await api.checkin(plan.planId, !plan.done);
                reload();
              }}
            >
              {plan.done ? "✓" : ""}
            </button>
            <span className="title">{plan.title}</span>
            <span className="muted">{SCOPE_LABEL[plan.scope] ?? plan.scope}{plan.due ? ` · ${plan.due}` : ""}</span>
          </div>
        ))}
      </div>

      <div className="section-title">今日流水</div>
      <div className="card" style={{ padding: 0 }}>
        {view.flows.length === 0 && <div className="flow-row muted">今天还没有记录</div>}
        {view.flows.map((flow) => (
          <div key={flow.seq} className="flow-row">
            <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--accent)", flexShrink: 0 }} />
            <div className="meta">
              <div>
                {flow.category}
                {flow.note ? ` · ${flow.note}` : ""}
              </div>
              <div className="sub">{hhmm(flow.time)}</div>
            </div>
            {flow.value !== undefined && (
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {flow.value}
                {flow.unit ?? ""}
              </span>
            )}
            <button
              className="btn ghost small"
              title="作废这一笔"
              onClick={async () => {
                await api.voidRecord(flow.seq);
                reload();
              }}
            >
              作废
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
