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

/** 本地时 YYYY-MM-DD（图表点柱 → 当日明细过滤，与折叠层 daily 的本地日语义一致） */
function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface MergedView {
  count: number;
  total: number;
  daily: { date: string; count: number; total: number }[];
  flows: CategoryPeriodLoose["flows"];
  categories?: number;
  /** B4：全部视图 = 各分类上期对照求和（归因句数据源） */
  lastPeriod?: { count: number; total: number };
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
    lastPeriod: views.reduce(
      (acc, v) => {
        const lp = v.lastPeriod ?? { count: 0, total: 0 }; // 版本错位容错（新前端 + 旧服务端）
        return { count: acc.count + lp.count, total: acc.total + lp.total };
      },
      { count: 0, total: 0 },
    ),
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
  const [pickedDate, setPickedDate] = useState<string | null>(null); // B4 图表交互：点柱 → 数值卡；再点 → 过滤当日明细

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
    setPickedDate(null); // 切分类/周期后旧选日失效，防止明细被静默过滤
    void (async () => {
      if (selected === "全部") {
        const panels = await api4.panels();
        const views = await Promise.all(panels.categories.map((c) => api4.categoryPanel(c.category, period)));
        setView(mergeViews(views));
      } else {
        const v = await api4.categoryPanel(selected, period);
        setView({ count: v.count, total: v.total, daily: v.daily, flows: v.flows, lastPeriod: v.lastPeriod });
      }
    })().catch(() => undefined);
  }, [selected, period]);

  const isAll = selected === "全部";
  const color = isAll ? "var(--accent)" : catColor(selected);
  const maxDaily = Math.max(1, ...(view?.daily.map((d) => d.count) ?? [1]));
  const streak = view ? streakFromDaily(view.daily) : 0;

  // B4 图表层：有数值的分类画数值柱状+日均基准；无数值的只配一行 sparkline（诚实降级，不为像而像）
  const trend = (view?.daily ?? []).slice(-14);
  const hasValue = (view?.daily ?? []).some((d) => d.total > 0);
  const avgValue = hasValue ? (view?.daily ?? []).reduce((s, d) => s + d.total, 0) / Math.max(1, (view?.daily ?? []).length) : 0;
  const maxTrend = Math.max(1, ...trend.map((t) => (hasValue ? t.total : t.count)));

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
      {/* 趋势（B4 图表层）：有数值 → 数值柱状 + 日均基准虚线；无数值 → 一行 sparkline；点柱看数值卡再下钻 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">近 14 天趋势</h2>
          <span className="num text-xs text-ink3">单位：{hasValue ? "数值合计" : "次"}{hasValue ? ` · 日均 ${avgValue.toFixed(1)}` : ""}</span>
        </div>
        {hasValue ? (
          <div>
            {/* 日均基准虚线 + 标签：图表有用判据②——有参照系才可评价（锚在柱区内同高） */}
            <div className="relative" style={{ height: 120 }}>
              {avgValue > 0 && (
                <>
                  <div
                    className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-ink3/40"
                    style={{ top: `${Math.max(2, 100 - (avgValue / maxTrend) * 100)}%` }}
                  />
                  <span
                    className="absolute right-0 z-10 -translate-y-1/2 rounded bg-surface2/90 px-1.5 py-0.5 text-[10px] text-ink3"
                    style={{ top: `${Math.max(2, 100 - (avgValue / maxTrend) * 100)}%` }}
                    title="近 30 天日均（虚线）"
                  >
                    日均 {avgValue.toFixed(1)}
                  </span>
                </>
              )}
              <div className="flex h-full items-end gap-1">
                {trend.map((t) => {
                  const v = t.total;
                  const picked = pickedDate === t.date;
                  return (
                    <button
                      key={t.date}
                      type="button"
                      className="flex-1 rounded-t transition-all"
                      style={{ height: `${Math.max(1, (v / maxTrend) * 100)}%`, background: picked ? "var(--warm)" : v === 0 ? "var(--surface-2)" : "var(--cat)" }}
                      title={`${t.date}：${t.count} 笔${t.total ? ` / ${t.total}` : ""}`}
                      onClick={() => setPickedDate(picked ? null : t.date)}
                      aria-label={`${t.date} 详情`}
                    />
                  );
                })}
              </div>
            </div>
            {pickedDate !== null && (() => {
              const t = trend.find((x) => x.date === pickedDate)!;
              const v = t.total;
              const ratio = avgValue > 0 ? v / avgValue : 0;
              return (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface2/60 px-3 py-2 text-sm">
                  <span className="num font-medium text-ink">{pickedDate}</span>
                  <span className="num text-ink2">{t.count} 笔{v > 0 ? ` · 合计 ${v}` : ""}</span>
                  {v > 0 && avgValue > 0 && (
                    <span className={`num text-xs ${ratio > 1.5 ? "text-warm" : ratio < 0.5 ? "text-ink3" : "text-accent"}`}>
                      是日均的 {ratio.toFixed(1)} 倍
                    </span>
                  )}
                  <button
                    type="button"
                    className="ml-auto text-xs text-accent transition hover:text-accent2"
                    onClick={() => setPickedDate(null)}
                  >
                    收起
                  </button>
                </div>
              );
            })()}
            <div className="mt-1 flex justify-between text-[10px] text-ink3">
              <span>14 天前</span>
              <span>今天</span>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-end gap-1" style={{ height: 48 }}>
              {trend.map((t) => (
                <div
                  key={t.date}
                  title={`${t.date}：${t.count} 笔`}
                  className="flex-1 rounded-sm"
                  style={{ height: `${Math.max(6, (t.count / maxTrend) * 100)}%`, background: t.count === 0 ? "var(--surface-2)" : "var(--cat)" }}
                />
              ))}
            </div>
          </div>
        )}
      </section>



      {/* 热力图（B4 降级为折叠辅助：回答"坚持得匀不匀"，不与柱状主图抢首屏） */}
      <details className="mb-5 rounded-xl border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          近 30 天热力图 <span className="ml-1 text-xs font-normal text-ink3">坚持匀不匀 · 点开看</span>
        </summary>
        <div className="mt-3">
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
        </div>
      </details>

      {/* 明细（随分类切换；全部视图带分类色标；B4：上期对照 + 归因句 + 点柱过滤当日） */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold text-ink">{PERIODS.find((p) => p.key === period)?.label ?? ""}记录</h2>
          {view && (view.lastPeriod?.count ?? 0) > 0 && (() => {
            const cur = hasValue ? view.total : view.count;
            const lastP = view.lastPeriod!;
            const last = hasValue ? lastP.total : lastP.count;
            const up = cur >= last;
            const deltaPct = last > 0 ? Math.round(((cur - last) / last) * 100) : null;
            // 归因（确定性规则）：涨了且最大一笔占涨幅过半 → 点名它
            let attribution = "";
            if (up && deltaPct !== null && deltaPct > 0 && hasValue && view.flows.length > 0) {
              const rise = cur - last;
              const biggest = view.flows.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a));
              if ((biggest.value ?? 0) >= rise * 0.5 && (biggest.value ?? 0) > 0) {
                attribution = `，主要是「${biggest.note ?? biggest.category}」那笔 ${biggest.value}${biggest.unit ?? ""}`;
              }
            }
            return (
              <span className="num text-xs text-ink3">
                比上一周期 {deltaPct === null ? "新增" : `${up ? "+" : ""}${deltaPct}%${attribution}`}
              </span>
            );
          })()}
          {pickedDate !== null && (
            <button
              className="rounded-full bg-accent3 px-2 py-0.5 text-xs text-accent transition hover:text-accent2"
              onClick={() => setPickedDate(null)}
            >
              只看 {pickedDate} ✕
            </button>
          )}
        </div>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {view && view.flows.length === 0 && <div className="px-4 py-3 text-sm text-ink3">该周期没有记录</div>}
          {view?.flows.filter((f) => pickedDate === null || formatDate(f.time) === pickedDate).map((f) => (
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
