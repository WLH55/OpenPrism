import { useCallback, useEffect, useState } from "react";
import { api4, type CategoryPeriodLoose, type CategoryStatLoose } from "../api";

const PERIODS: { key: string; label: string }[] = [
  { key: "today", label: "今日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "year", label: "今年" },
];

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Panels() {
  const [categories, setCategories] = useState<CategoryStatLoose[]>([]);
  const [archived, setArchived] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [period, setPeriod] = useState("week");
  const [view, setView] = useState<CategoryPeriodLoose | null>(null);
  const [mergeTo, setMergeTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const panels = await api4.panels();
    setCategories(panels.categories);
    setArchived(panels.archived);
    return panels;
  }, []);

  useEffect(() => {
    void reload()
      .then((panels) => setSelected((cur) => cur ?? panels.categories[0]?.category ?? null))
      .catch(() => undefined);
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    void api4
      .categoryPanel(selected, period)
      .then(setView)
      .catch(() => undefined);
  }, [selected, period]);

  const maxDaily = Math.max(1, ...(view?.daily.map((d) => d.count) ?? [1]));

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h1 style={{ margin: "0 0 4px" }}>盘面</h1>
      <p className="muted">分类即维度——目录从你记过的流水动态长出；面板 = 账本折叠，0 token</p>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "14px 0 4px" }}>
        {categories.map((stat) => (
          <button
            key={stat.category}
            className={`btn small ${selected === stat.category ? "" : "ghost"}`}
            style={{ flexShrink: 0 }}
            onClick={() => setSelected(stat.category)}
          >
            {stat.category} · {stat.count}
          </button>
        ))}
        {categories.length === 0 && <span className="muted">还没有记录——去聊天或今天页记一笔</span>}
      </div>

      {selected && view && (
        <>
          <div style={{ display: "flex", gap: 4, margin: "12px 0" }}>
            {PERIODS.map((p) => (
              <button key={p.key} className={`tab${period === p.key ? " active" : ""}`} onClick={() => setPeriod(p.key)}>
                {p.label}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <span className="muted" style={{ alignSelf: "center" }}>
              {view.count} 笔 · 合计 {view.total || "—"}
            </span>
          </div>

          <div className="card">
            <div className="muted">近 30 天（颜色深浅 = 当日笔数）</div>
            <div style={{ display: "flex", gap: 3, marginTop: 8, alignItems: "stretch", height: 56 }}>
              {view.daily.map((d) => (
                <div
                  key={d.date}
                  title={`${d.date}：${d.count} 笔${d.total ? ` / ${d.total}` : ""}`}
                  style={{
                    flex: 1,
                    borderRadius: 3,
                    background:
                      d.count === 0
                        ? "var(--surface-2)"
                        : `color-mix(in srgb, var(--accent) ${Math.round(30 + (d.count / maxDaily) * 60)}%, var(--surface-2))`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="section-title">明细（周期内）</div>
          <div className="card" style={{ padding: 0 }}>
            {view.flows.length === 0 && <div className="flow-row muted">该周期没有记录</div>}
            {view.flows.map((f) => (
              <div key={f.seq} className="flow-row">
                <div className="meta">
                  <div>
                    {f.note ?? f.category}
                  </div>
                  <div className="sub">{hhmm(f.time)}</div>
                </div>
                {f.value !== undefined && (
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {f.value}
                    {f.unit ?? ""}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="section-title">分类管理</div>
          <div className="card">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 13 }}>
                把「{selected}」合并进
              </span>
              <input
                className="input"
                style={{ width: 160 }}
                placeholder="目标分类名"
                value={mergeTo}
                onChange={(e) => setMergeTo(e.target.value)}
              />
              <button
                className="btn small"
                onClick={async () => {
                  if (mergeTo.trim() === "" || mergeTo.trim() === selected) return;
                  const result = await api4.mergeCategory(selected, mergeTo.trim());
                  setMessage(`已合并 ${result.moved} 笔（历史留痕，可审计）`);
                  setMergeTo("");
                  setSelected(mergeTo.trim());
                  await reload();
                }}
              >
                合并
              </button>
              <button
                className="btn ghost small"
                onClick={async () => {
                  await api4.archiveCategory(selected);
                  setMessage(`已归档「${selected}」（数据保留，目录不再显示）`);
                  setSelected(null);
                  const panels = await reload();
                  setSelected(panels.categories[0]?.category ?? null);
                }}
              >
                归档此分类
              </button>
            </div>
            {archived.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  已归档：
                </span>
                {archived.map((name) => (
                  <button
                    key={name}
                    className="btn ghost small"
                    style={{ marginRight: 6 }}
                    onClick={async () => {
                      await api4.unarchiveCategory(name);
                      await reload();
                    }}
                  >
                    {name} ↺
                  </button>
                ))}
              </div>
            )}
            {message && <p className="muted" style={{ margin: "10px 0 0" }}>{message}</p>}
          </div>
        </>
      )}
    </div>
  );
}
