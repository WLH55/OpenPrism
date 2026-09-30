import { useCallback, useEffect, useState } from "react";
import { api, type TodayPlanView, type TodayView, type TopItemLoose } from "../api";
import { catColor } from "../catcolor";
import { daysUntil } from "../days";
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
};

/** 本地日期串（习惯打卡"今天是否已计入"的判断，2026-09-30 习惯化） */
function localYmd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 计划行（2026-09-29 提取为组件以承载行内交互）：打卡/撤销 + 编辑（标题/due，planId 稳定）+ 周期补卡（date ≤ 今天） */
function PlanRow({ plan, viewDate, onChanged }: { plan: TodayPlanView; viewDate: string; onChanged: () => void }) {
  const state = plan.state ?? (plan.done ? "done" : "todo");
  const daysTo = plan.due !== undefined ? daysUntil(plan.due, viewDate) : null;
  // 撤销降级（评审 2026-09-29 簇 A）：无 seq（旧服务端）时完成态不可交互，不给"可取消"的假象——与计划页 MilestoneRow 同规
  const undoable = plan.done && (plan.doneSeqs ?? []).length > 0;
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(plan.title);
  const [dueDraft, setDueDraft] = useState(plan.due ?? "");
  const [backfilling, setBackfilling] = useState(false);
  const [backfillDate, setBackfillDate] = useState("");
  const [busy, setBusy] = useState(false);
  const canBackfill = plan.scope !== "deadline" && !plan.done;
  // 习惯计划（2026-09-30 习惯化）：进度芯片 + 按天计数（week/month/year）的同日二击防护
  const habit = plan.timesPerPeriod !== undefined;
  const progressText = habit ? `${SCOPE_LABEL[plan.scope] ?? "本期"} ${plan.periodCount ?? 0}/${plan.timesPerPeriod}` : null;

  const stateLabel =
    state === "done"
      ? "已完成"
      : state === "overdue"
        ? daysTo !== null && daysTo < 0
          ? `已过期 ${-daysTo} 天`
          : "已过期"
        : state === "dueToday"
          ? "今天截止"
          : state === "doing"
            ? "进行中"
            : state === "upcoming"
              ? daysTo === 1
                ? "明天"
                : daysTo !== null && daysTo > 1 && daysTo <= 30
                  ? `${daysTo} 天后`
                  : (plan.due ?? "未开始")
              : "待做";
  const stateCls = state === "overdue" ? "text-warm" : state === "dueToday" ? "text-accent" : "text-ink3";
  const skip = async () => {
    if (plan.seq === undefined || !window.confirm(`跳过「${plan.title}」？= 作废这条计划（留痕可审计）。`)) return;
    try {
      await api.voidRecord(plan.seq);
    } catch (e) {
      window.alert(String((e as Error).message));
    }
    onChanged();
  };
  const save = async () => {
    if (titleDraft.trim() === "") {
      window.alert("标题不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.updatePlan(plan.planId, { title: titleDraft.trim(), ...(dueDraft !== "" ? { due: dueDraft } : {}) });
      setEditing(false);
    } catch (e) {
      window.alert(String((e as Error).message));
    } finally {
      setBusy(false);
    }
    onChanged();
  };
  const backfill = async () => {
    if (backfillDate === "") {
      window.alert("先选补卡日期");
      return;
    }
    setBusy(true);
    try {
      await api.checkin(plan.planId, true, backfillDate);
      setBackfilling(false);
      setBackfillDate("");
    } catch (e) {
      window.alert(String((e as Error).message));
    } finally {
      setBusy(false);
    }
    onChanged();
  };

  const field = "min-w-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent";
  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <input className={`${field} flex-1`} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="标题" />
        <input className={field} type="date" value={dueDraft} onChange={(e) => setDueDraft(e.target.value)} title="截止日（仅 deadline 型生效）" />
        <button className="rounded bg-accent2 px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button
          className="text-xs text-ink3 transition hover:text-ink"
          onClick={() => {
            setEditing(false);
            setTitleDraft(plan.title);
            setDueDraft(plan.due ?? "");
          }}
        >
          取消
        </button>
      </div>
    );
  }
  if (backfilling) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <span className="text-sm text-ink2">补卡（{plan.title}）：</span>
        <input className={field} type="date" value={backfillDate} max={viewDate} onChange={(e) => setBackfillDate(e.target.value)} />
        <button className="rounded bg-accent2 px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void backfill()}>
          记为当天已做
        </button>
        <button className="text-xs text-ink3 transition hover:text-ink" onClick={() => setBackfilling(false)}>
          取消
        </button>
      </div>
    );
  }
  return (
    <div
      className={`flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition ${
        undoable || !plan.done ? "cursor-pointer hover:bg-surface2/60" : "opacity-90"
      }`}
      onClick={async () => {
        if (plan.done && !undoable) return;
        try {
          if (plan.done) {
            // 撤销 = 作废打卡（deadline=全部存活 done 打卡；周期/习惯=今日打卡），追加 done:false 对两者都无效
            for (const seq of plan.doneSeqs!) await api.voidRecord(seq);
          } else if (habit && plan.scope !== "day" && plan.checkinTs !== undefined) {
            // 按天计数的习惯（每周/月/年 N 天）今天已计入：第二击 = 撤销今天的卡（不新增一天）
            const seqs = (plan.checkins ?? []).filter((c) => localYmd(c.at) === viewDate).map((c) => c.seq);
            if (seqs.length > 0 && window.confirm(`今天这一卡已经算进${progressText}了。撤销今天的打卡吗？`)) {
              for (const seq of seqs) await api.voidRecord(seq);
            }
          } else {
            await api.checkin(plan.planId, true);
          }
        } catch (e) {
          window.alert(String((e as Error).message));
        }
        onChanged();
      }}
      title={
        plan.done
          ? undoable
            ? "点击撤销打卡（作废该打卡记录，历史留痕）"
            : "已完成"
          : habit && plan.scope !== "day" && plan.checkinTs !== undefined
            ? `今天已计入 ${progressText}——点击可撤销今天的卡（按天计数）`
            : "点击打卡（逾期项 = 现在补做）"
      }
    >
      {plan.done ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent2 text-white">
          <CheckSolidIcon className="h-3.5 w-3.5" />
        </span>
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-full border-2 border-line" />
      )}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${plan.done ? "text-ink3 line-through" : "text-ink"}`}>{plan.title}</span>
      </span>
      {plan.due !== undefined && !plan.done && <span className="num shrink-0 text-xs text-ink3">{plan.due.slice(5)}</span>}
      {habit && <span className={`num shrink-0 text-xs ${plan.done ? "text-accent" : "text-ink3"}`}>{progressText}</span>}
      {(!habit || plan.done) && <span className={`num shrink-0 text-xs ${stateCls}`}>{stateLabel}</span>}
      {canBackfill && (
        <button
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink3 transition hover:bg-accent/10 hover:text-accent"
          title="之前做了忘了打：选过去的日期补卡"
          onClick={(e) => {
            e.stopPropagation();
            setBackfilling(true);
          }}
        >
          补卡
        </button>
      )}
      <button
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink3 transition hover:bg-surface2 hover:text-ink"
        title="编辑标题/截止日（planId 不变，历史打卡保留）"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        编辑
      </button>
      {(state === "overdue" || (state === "upcoming" && plan.scope === "deadline")) && (
        <button
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink3 transition hover:bg-warm/10 hover:text-warm"
          title="这事不做了：作废该计划（留痕可审计）——未来的独立待办/孤儿打卡点也可在此取消"
          onClick={(e) => {
            e.stopPropagation();
            void skip();
          }}
        >
          跳过
        </button>
      )}
    </div>
  );
}

/** 今日必做（B3）：确定性折叠的 Top3；可点项打卡后刷新（习惯项带进度、按天计数做同日防护） */
function Top3Card({ items, onCheckin }: { items: TopItemLoose[]; onCheckin: (item: TopItemLoose) => void }) {
  if (items.length === 0) {
    return (
      <div className="mb-5 rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-sm text-ink3">
        今天没有必须推进的事——跟助手说一句想做的事，或往下看看待办
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
            onClick={() => onCheckin(item)}
            title="点击打卡"
          >
            <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface2 text-[11px] font-semibold text-ink2">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-ink">{item.title}</span>
            </span>
            {item.progress !== undefined && (
              <span className="num shrink-0 rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-ink2">{item.progress}</span>
            )}
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

/** 今天页：Top3 + 快速记录 + 三统计卡 + 计划四段范围切换（今天/本周/全部/已完成；计划管理唯一入口，2026-09-30 目标层级下线） */
export function Today() {
  const [view, setView] = useState<TodayView | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [planTab, setPlanTab] = useState<"today" | "week" | "all" | "done">("today");

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

  // 计划四段范围（2026-09-29 B4 + 评审 M1 谓词单源）：数据一次载荷（服务端全量收编+30 天存档窗口），视图谓词前端算
  const ymd = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dow = new Date(`${view.date}T00:00:00`).getDay();
  const sunday = new Date(`${view.date}T00:00:00`);
  sunday.setDate(sunday.getDate() + ((7 - dow) % 7)); // 周一起算的本周日（今天就是周日则为今天）
  const sundayStr = ymd(sunday.getTime());
  const doneToday = (p: TodayView["plans"][number]): boolean => p.doneAt !== undefined && ymd(p.doneAt) === view.date;
  const inToday = (p: TodayView["plans"][number]): boolean => (p.state !== "upcoming" && p.state !== "done") || doneToday(p);
  const done30d = (p: TodayView["plans"][number]): boolean =>
    p.state === "done" && p.doneAt !== undefined && p.doneAt >= Date.now() - 30 * 86400000;
  // 谓词表 = 角标计数与列表过滤的唯一来源（评审 M1：双份维护必漂移）
  const TAB_PRED: Record<typeof planTab, (p: TodayView["plans"][number]) => boolean> = {
    today: inToday,
    week: (p) => inToday(p) || (p.state === "upcoming" && p.due !== undefined && p.due <= sundayStr),
    all: (p) => inToday(p) || p.state === "upcoming",
    done: done30d,
  };
  const tabPlans =
    planTab === "done"
      ? [...view.plans.filter(TAB_PRED.done)].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
      : view.plans.filter(TAB_PRED[planTab]);
  const todayPlans = view.plans.filter(TAB_PRED.today); // 统计卡口径 = 今天视图（全量收编后不宜直接用 view.plans）
  const doneCount = todayPlans.filter((p) => p.done).length;
  // Top3 打卡（2026-09-30 习惯化）：按天计数的习惯今天已计入 → 不再记账（行内可撤销/明天再来）
  const top3Checkin = (item: TopItemLoose) => {
    if (item.planId === undefined) return;
    const plan = view.plans.find((p) => p.planId === item.planId);
    if (plan !== undefined && plan.timesPerPeriod !== undefined && plan.scope !== "day" && plan.checkinTs !== undefined) {
      window.alert("今天这一卡已经算进进度了（按天计数）——明天再来，或在下面计划行里撤销今天的卡");
      return;
    }
    void api.checkin(item.planId).then(reload);
  };
  const PLAN_TABS = (
    [
      { key: "today", label: "今天" },
      { key: "week", label: "本周" },
      { key: "all", label: "全部" },
      { key: "done", label: "已完成" },
    ] as { key: typeof planTab; label: string }[]
  ).map((t) => ({ ...t, count: view.plans.filter(TAB_PRED[t.key]).length }));

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

      {/* 今日必做：先看要做什么，再看记了什么 */}
      <Top3Card items={view.top3 ?? []} onCheckin={top3Checkin} />

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
            <span className="text-sm font-normal text-ink3">/{todayPlans.length}</span>
          </div>
        </div>
        <div className="col-span-2 rounded-xl border border-line bg-surface px-4 py-3 md:col-span-1">
          <div className="text-xs text-ink2">连续打卡</div>
          <div className="num mt-1 text-xl font-semibold text-warm">{view.streakDays} 天</div>
        </div>
      </div>

      {/* 计划四段范围切换（2026-09-29 B4）：今天=今日应做（未来项移出）｜本周=+截止≤周日｜全部=+远期｜已完成=近 30 天存档 */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">计划</h2>
          <div className="flex gap-1">
            {PLAN_TABS.map((t) => (
              <button
                key={t.key}
                className={`rounded-full px-2.5 py-1 text-xs transition ${planTab === t.key ? "bg-accent2 font-medium text-white" : "text-ink3 transition hover:text-ink"}`}
                onClick={() => setPlanTab(t.key)}
              >
                {t.label}
                {t.count > 0 && <span className="num ml-0.5 opacity-70">{t.count}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          {tabPlans.length === 0 && planTab === "today" && (
            <div className="rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-sm text-ink3">
              今天还没有计划——直接跟助手说一句（如"明天背单词""周五前交报告"），它会帮你建好
            </div>
          )}
          {tabPlans.length === 0 && planTab !== "today" && (
            <div className="rounded-xl border border-dashed border-line bg-surface px-4 py-3.5 text-sm text-ink3">
              {planTab === "done" ? "最近 30 天还没有完成的计划" : "这个范围没有计划"}
            </div>
          )}
          {tabPlans.map((plan) => (
            <PlanRow key={plan.planId} plan={plan} viewDate={view.date} onChanged={reload} />
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
