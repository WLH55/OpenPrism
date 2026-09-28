import { useCallback, useEffect, useState } from "react";
import { api, type TodayView, type TopItemLoose } from "../api";
import { catColor } from "../catcolor";
import { CheckSolidIcon } from "../icons";

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

const TOP_KIND_LABEL: Record<TopItemLoose["kind"], string> = {
  overdue: "逾期",
  dueToday: "今日截止",
  today: "今日",
  nextStep: "下一步",
};

/** 今日必做（B3）：确定性折叠的 Top3；可点项打卡后刷新 */
function Top3Card({ items, onCheckin, onOpenPlans }: { items: TopItemLoose[]; onCheckin: () => void; onOpenPlans: () => void }) {
  if (items.length === 0) {
    return (
      <div className="mb-5 rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-sm text-ink3">
        今天没有必须推进的事——去<span className="text-accent transition hover:text-accent2 cursor-pointer" onClick={onOpenPlans}>计划页</span>看看方向的下一步
      </div>
    );
  }
  return (
    <section className="mb-5 rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold text-ink">今日必做</h2>
      <div className="space-y-1.5">
        {items.map((item, index) => (
          <button
            key={`${item.kind}-${item.planId ?? item.title}-${index}`}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-surface2/60"
            onClick={() => {
              if (item.planId !== undefined) void api.checkin(item.planId).then(onCheckin);
              else onOpenPlans();
            }}
            title={item.planId !== undefined ? "点击打卡" : "去计划页推进"}
          >
            <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface2 text-[11px] font-semibold text-ink2">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-ink">{item.title}</span>
              {item.goalTitle !== undefined && <span className="block truncate text-xs text-ink3">属于：{item.goalTitle}</span>}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                item.kind === "overdue" ? "bg-warm/10 text-warm" : item.kind === "dueToday" ? "bg-accent3 text-accent" : "bg-surface2 text-ink3"
              }`}
            >
              {TOP_KIND_LABEL[item.kind]}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** 计划卡（B3）：3 方向 + 3 阶段 + 软约束提示；点击进计划页 */
function GoalCard({
  goalCard,
  onOpenPlans,
}: {
  goalCard: TodayView["goalCard"];
  onOpenPlans: () => void;
}) {
  if (goalCard.directions.length === 0 && goalCard.phases.length === 0) {
    return (
      <div className="mb-5 rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-sm text-ink3">
        还没有长期方向——
        <span className="cursor-pointer text-accent transition hover:text-accent2" onClick={onOpenPlans}>
          建立第一个方向
        </span>
        ，让今天的行动连上去
      </div>
    );
  }
  return (
    <section className="mb-5 rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">计划与方向</h2>
        <button className="text-xs text-ink3 transition hover:text-ink" onClick={onOpenPlans}>
          查看 →
        </button>
      </div>
      {goalCard.warning !== undefined && <p className="mb-2 text-xs text-warm">{goalCard.warning}</p>}
      <div className="flex flex-wrap gap-2">
        {goalCard.directions.map((d) => (
          <button
            key={d.goalId}
            onClick={onOpenPlans}
            className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs text-ink2 transition hover:border-accent hover:text-ink"
            title={d.progress.total > 0 ? `里程碑 ${d.progress.done}/${d.progress.total}` : "进计划页看详情"}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {d.title}
            {d.progress.total > 0 && (
              <span className="num text-ink3">
                {d.progress.done}/{d.progress.total}
              </span>
            )}
          </button>
        ))}
      </div>
      {goalCard.phases.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {goalCard.phases.map((p) => (
            <button key={p.goalId} onClick={onOpenPlans} className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left transition hover:bg-surface2/60">
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                阶段「{p.title}」
                {p.nextStep !== undefined && <span className="text-ink3"> · 下一步：{p.nextStep}</span>}
              </span>
              {p.due !== undefined && <span className="num shrink-0 text-xs text-ink3">{p.due}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** 今天页：Top3 + 计划卡 + 快速记录 + 三统计卡 + 计划/流水（B3 增补，结构照 prototype 页 3） */
export function Today({ onOpenPlans }: { onOpenPlans: () => void }) {
  const [view, setView] = useState<TodayView | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
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
    setQuickOpen(false);
    reload();
  };

  if (!view) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <p className="text-sm text-ink3">{error ?? "加载中…"}</p>
      </div>
    );
  }

  const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date().getDay()];
  const doneCount = view.plans.filter((p) => p.done).length;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* 头部 */}
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">
            {new Date().getFullYear()} 年 {new Date().getMonth() + 1} 月 {new Date().getDate()} 日 · 星期{weekday}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">今天</h1>
        </div>
        <button
          className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
          onClick={() => setQuickOpen(!quickOpen)}
        >
          ＋ 快速记录
        </button>
      </header>

      {/* 快速记录（按钮展开；不经模型直接落账） */}
      {quickOpen && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 text-sm text-ink2">快速记录 · 不经模型，直接落账</div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              placeholder="分类（必填，如：餐饮）"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <input
              className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              placeholder="备注（如：午餐）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <input
              className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              placeholder="数值"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <input
              className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              placeholder="单位（¥/分钟…）"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              onClick={() => void quickRecord()}
            >
              记一笔
            </button>
            <button className="text-sm text-ink3 transition hover:text-ink" onClick={() => setQuickOpen(false)}>
              收起
            </button>
            {error && <span className="text-sm text-warm">{error}</span>}
          </div>
        </div>
      )}

      {/* 今日必做 + 计划与方向（B3）：先看要做什么，再看记了什么 */}
      <Top3Card items={view.top3 ?? []} onCheckin={reload} onOpenPlans={onOpenPlans} />
      <GoalCard goalCard={view.goalCard ?? { directions: [], phases: [] }} onOpenPlans={onOpenPlans} />

      {/* 三统计卡（窄屏两列，第三张跨满行） */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="text-xs text-ink2">今日笔数</div>
          <div className="num mt-1 text-xl font-semibold text-ink">{view.flows.length}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="text-xs text-ink2">计划完成</div>
          <div className="num mt-1 text-xl font-semibold text-ink">
            {doneCount}
            <span className="text-sm font-normal text-ink3">/{view.plans.length}</span>
          </div>
        </div>
        <div className="col-span-2 rounded-xl border border-line bg-surface px-4 py-3 md:col-span-1">
          <div className="text-xs text-ink2">连续打卡</div>
          <div className="num mt-1 text-xl font-semibold text-warm">{view.streakDays} 天</div>
        </div>
      </div>

      {/* 今日计划 */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">今日计划</h2>
        <div className="space-y-1.5">
          {view.plans.length === 0 && (
            <button
              className="w-full rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-left text-sm text-accent transition hover:border-accent"
              onClick={onOpenPlans}
            >
              今天还没有计划——去计划页给阶段加个里程碑，或直接跟助手说一句
            </button>
          )}
          {view.plans.map((plan) => (
            <button
              key={plan.planId}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition hover:bg-surface2/60"
              onClick={async () => {
                await api.checkin(plan.planId, !plan.done);
                reload();
              }}
              title={plan.done ? "点击取消打卡" : "点击打卡"}
            >
              {plan.done ? (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent2 text-white">
                  <CheckSolidIcon className="h-3.5 w-3.5" />
                </span>
              ) : (
                <span className="h-5 w-5 shrink-0 rounded-full border-2 border-line" />
              )}
              <span className={`flex-1 text-[15px] ${plan.done ? "text-ink3 line-through" : "text-ink"}`}>{plan.title}</span>
              <span className={`num text-xs ${plan.done ? "text-ink3" : "text-warm"}`}>
                {plan.done ? "已完成" : "未开始"}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 今日记录 */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">今日记录</h2>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {view.flows.length === 0 && (
            <button
              className="w-full px-4 py-3.5 text-left text-sm text-accent transition hover:text-accent2"
              onClick={() => setQuickOpen(true)}
            >
              今天还没有记录——记第一笔，哪怕只是一句心情
            </button>
          )}
          {view.flows.map((flow) => (
            <div key={flow.seq} className="group flex items-center gap-3 px-4 py-3">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: catColor(flow.category) }}
                title={flow.category}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] text-ink">{flow.note ?? flow.category}</div>
                <div className="text-xs text-ink3">
                  {flow.category} · {hhmm(flow.time)}
                </div>
              </div>
              {flow.value !== undefined && (
                <span className="num text-[15px] font-medium text-ink">
                  {flow.value}
                  {flow.unit ?? ""}
                </span>
              )}
              <button
                className="shrink-0 text-xs text-ink3 opacity-0 transition group-hover:opacity-100 hover:text-warm"
                title="作废这一笔（留痕可审计）"
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
        {view.totalByCategory.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink3">
            {view.totalByCategory.map((c) => (
              <span key={c.category} className="rounded-md bg-surface2 px-2 py-1">
                {c.category} 合计 <b className="num">{c.total}</b> · {c.count} 笔
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
