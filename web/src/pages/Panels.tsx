import { useCallback, useEffect, useState } from "react";
import { api4, type CategoryPeriodLoose, type CategoryStatLoose } from "../api";
import { catColor } from "../catcolor";

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

interface MergedView {
  count: number;
  total: number;
  daily: { date: string; count: number; total: number }[];
  flows: CategoryPeriodLoose["flows"];
  categories?: number;
}

function mergeViews(views: CategoryPeriodLoose[]): MergedView {
  const byDate = new Map<string, { count: number; total: number }>();
  for (const v of views) {
    for (const d of v.daily) {
      const cur = byDate.get(d.date) ?? { count: 0, total: 0 };
      cur.count += d.count;
      cur.total += d.total;
      byDate.set(d.date, cur);
    }
  }
  const dates = [...byDate.keys()].sort();
  return {
    count: views.reduce((n, v) => n + v.count, 0),
    total: views.reduce((n, v) => n + v.total, 0),
    daily: dates.map((date) => ({ date, ...byDate.get(date)! })),
    flows: views.flatMap((v) => v.flows).sort((a, b) => b.time - a.time),
    categories: views.length,
  };
}

/** 从 daily 尾部数连续天数（今天或昨天起往前，count>0 连续） */
function streakFromDaily(daily: { date: string; count: number }[]): number {
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i]!.count > 0) streak++;
    else if (i === daily.length - 1) continue; // 今天还没记不打断
    else break;
  }
  return streak;
}

/** 盘面页：分类即维度——chips 色标 + 周期切片 + 汇总卡 + 折线 + 热力图，结构照 prototype 页 4 */
export function Panels() {
  const [categories, setCategories] = useState<CategoryStatLoose[]>([]);
  const [archived, setArchived] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("全部");
  const [period, setPeriod] = useState("week");
  const [view, setView] = useState<MergedView | null>(null);
  const [mergeTo, setMergeTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const panels = await api4.panels();
    setCategories(panels.categories);
    setArchived(panels.archived);
    return panels;
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  useEffect(() => {
    void (async () => {
      if (selected === "全部") {
        const panels = await api4.panels();
        const views = await Promise.all(panels.categories.map((c) => api4.categoryPanel(c.category, period)));
        setView(mergeViews(views));
      } else {
        const v = await api4.categoryPanel(selected, period);
        setView({ count: v.count, total: v.total, daily: v.daily, flows: v.flows });
      }
    })().catch(() => undefined);
  }, [selected, period]);

  const isAll = selected === "全部";
  const color = isAll ? "var(--accent)" : catColor(selected);
  const maxDaily = Math.max(1, ...(view?.daily.map((d) => d.count) ?? [1]));
  const streak = view ? streakFromDaily(view.daily) : 0;

  // 折线图数据：近 14 天
  const trend = (view?.daily ?? []).slice(-14);
  const maxTrend = Math.max(1, ...trend.map((t) => t.count));
  const W = 320;
  const H = 120;
  const stepX = trend.length > 1 ? W / (trend.length - 1) : W;
  const pts = trend.map((t, i) => [i * stepX, H - 8 - (t.count / maxTrend) * (H - 28)] as const);
  const linePath = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = pts.length > 0 ? `${linePath} L${W},${H} L0,${H} Z` : "";

  const heatLevel = (count: number): number => {
    if (count === 0) return 0;
    const ratio = count / maxDaily;
    return ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.85 ? 3 : 4;
  };

  const summaryCards: [string, string, string][] = isAll
    ? [
        [`${PERIODS.find((p) => p.key === period)?.label ?? ""}记录`, String(view?.count ?? 0), "笔"],
        ["活跃分类", String(view?.categories ?? 0), "个"],
        ["连续记录", String(streak), "天"],
      ]
    : [
        [`${PERIODS.find((p) => p.key === period)?.label ?? ""}笔数`, String(view?.count ?? 0), "笔"],
        ["合计", view && view.total > 0 ? String(view.total) : "—", ""],
        ["连续", String(streak), "天"],
      ];

  return (
    <div className="mx-auto max-w-2xl px-4 py-6" style={{ ["--cat" as string]: color }}>
      <header className="mb-5">
        <div className="text-xs text-ink3">记过的每一种生活，都会长出自己的一页</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">盘面</h1>
      </header>

      {/* 分类选择器：全部 + 各分类并排，色标区分，点选切换 */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setSelected("全部")}
          className="flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-sm transition"
          style={{
            borderColor: isAll ? "var(--accent)" : "var(--line)",
            background: isAll ? "var(--accent-3)" : "transparent",
            color: isAll ? "var(--ink)" : "var(--ink-2)",
            fontWeight: isAll ? 600 : 400,
          }}
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--accent)" }} />
          全部
        </button>
        {categories.map((stat) => {
          const active = selected === stat.category;
          const c = catColor(stat.category);
          return (
            <button
              key={stat.category}
              onClick={() => setSelected(stat.category)}
              className="flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-sm transition"
              style={{
                borderColor: active ? c : "var(--line)",
                background: active ? `${c}1f` : "transparent",
                color: active ? "var(--ink)" : "var(--ink-2)",
                fontWeight: active ? 600 : 400,
              }}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
              {stat.category}
            </button>
          );
        })}
        {categories.length === 0 && <span className="self-center text-sm text-ink3">还没有记录——去聊天或今天页记一笔</span>}
      </div>

      {/* 周期切片 */}
      <div className="mb-5 grid grid-cols-4 rounded-lg bg-surface2 p-1 text-sm">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`rounded-md py-1.5 transition ${period === p.key ? "bg-surface font-medium text-ink shadow-sm" : "text-ink3 hover:text-ink"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 汇总卡（随分类切换换色；窄屏两列，第三张跨满行） */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        {summaryCards.map(([label, num, unit], index) => (
          <div key={label} className={index === 2 ? "col-span-2 rounded-xl border border-line bg-surface px-4 py-3 md:col-span-1" : "rounded-xl border border-line bg-surface px-4 py-3"}>
            <div className="text-xs text-ink2">{label}</div>
            <div className="num mt-1 text-xl font-semibold" style={{ color: label.startsWith("连续") ? "var(--warm)" : "var(--cat)" }}>
              {num}
              {unit && <span className="text-sm font-normal text-ink3"> {unit}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* 趋势图（SVG 折线 + 面积） */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">近 14 天趋势</h2>
          <span className="num text-xs text-ink3">单位：次</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="none">
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--cat)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--cat)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g stroke="var(--line)" strokeWidth="1">
            <line x1="0" y1="30" x2={W} y2="30" />
            <line x1="0" y1="60" x2={W} y2="60" />
            <line x1="0" y1="90" x2={W} y2="90" />
          </g>
          {areaPath && <path d={areaPath} fill="url(#areaFill)" />}
          {linePath && (
            <path d={linePath} fill="none" stroke="var(--cat)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          )}
          {pts.length > 0 && (
            <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="4" fill="var(--cat)" stroke="var(--surface)" strokeWidth="2" />
          )}
        </svg>
      </section>

      {/* 热力图：近 30 天 = 列（周）× 7 行，自上而下填 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">近 30 天热力图</h2>
          <span className="text-xs text-ink3">颜色深浅 = 当日记录数</span>
        </div>
        {/* 固定 12px 格宽，30 天约 26 列，窄屏会超宽：容器内横向滚动，页面不撑破 */}
        <div className="overflow-x-auto">
          <div id="heatmap">
          {(view?.daily ?? []).map((d) => (
            <span key={d.date} className={`heat-${heatLevel(d.count)} rounded-[3px]`} title={`${d.date}：${d.count} 笔${d.total ? ` / ${d.total}` : ""}`} />
          ))}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-ink3">
          <span>少</span>
          <span className="heat-0 h-3 w-3 rounded-sm" />
          <span className="heat-1 h-3 w-3 rounded-sm" />
          <span className="heat-2 h-3 w-3 rounded-sm" />
          <span className="heat-3 h-3 w-3 rounded-sm" />
          <span className="heat-4 h-3 w-3 rounded-sm" />
          <span>多</span>
        </div>
      </section>

      {/* 明细（随分类切换；全部视图带分类色标） */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">{PERIODS.find((p) => p.key === period)?.label ?? ""}记录</h2>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {view && view.flows.length === 0 && <div className="px-4 py-3 text-sm text-ink3">该周期没有记录</div>}
          {view?.flows.map((f) => (
            <div key={f.seq} className="flex items-center gap-3 px-4 py-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: isAll ? catColor(f.category) : "var(--cat)" }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] text-ink">{f.note ?? f.category}</div>
                <div className="text-xs text-ink3">
                  {isAll ? `${f.category} · ${hhmm(f.time)}` : hhmm(f.time)}
                </div>
              </div>
              {f.value !== undefined && (
                <span className="num text-[15px] font-medium text-ink">
                  {f.value}
                  {f.unit ?? ""}
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 分类管理（合并/归档；原型外追加功能，收在页尾） */}
      {!isAll && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-ink">分类管理</h2>
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-ink3">把「{selected}」合并进</span>
              <input
                className="w-40 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
                placeholder="目标分类名"
                value={mergeTo}
                onChange={(e) => setMergeTo(e.target.value)}
              />
              <button
                className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90"
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
                className="rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-ink2 transition hover:text-ink"
                onClick={async () => {
                  await api4.archiveCategory(selected);
                  setMessage(`已归档「${selected}」（数据保留，目录不再显示）`);
                  setSelected("全部");
                  await reload();
                }}
              >
                归档此分类
              </button>
            </div>
            {archived.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-ink3">已归档：</span>
                {archived.map((name) => (
                  <button
                    key={name}
                    className="rounded-full border border-line px-3 py-1 text-xs text-ink2 transition hover:text-ink"
                    onClick={async () => {
                      await api4.unarchiveCategory(name);
                      await reload();
                    }}
                  >
                    {name} ↺ 恢复
                  </button>
                ))}
              </div>
            )}
            {message && <p className="mt-3 text-xs text-ink3">{message}</p>}
          </div>
        </section>
      )}
    </div>
  );
}
