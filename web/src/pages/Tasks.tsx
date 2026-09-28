import { useCallback, useEffect, useState } from "react";
import { api2, api3, apiIm, type AgentLoose, type NotificationLoose, type TaskLoose, type TaskRunLoose, type TaskTriggerLoose } from "../api";
import { Toggle } from "../ui";

const WEEKDAY = ["", "一", "二", "三", "四", "五", "六", "日"];
const WORKDAYS = [1, 2, 3, 4, 5];
const UNIT_CHAR: Record<"minute" | "hour" | "day" | "week" | "month" | "year", string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
  week: "周",
  month: "个月",
  year: "年",
};
const CUSTOM_UNITS = ["minute", "hour", "day", "week", "month", "year"] as const;
type CustomUnit = (typeof CUSTOM_UNITS)[number];
/** 分钟/小时按固定间隔从创建时刻跑（无时刻）；天及以上锚当日 HH:mm */
const isTimedUnit = (u: CustomUnit): boolean => u === "day" || u === "week" || u === "month" || u === "year";

type SchedKind = "hourly" | "daily" | "workday" | "weekly" | "monthly" | "custom";

const SCHEDULE_TYPES: { value: SchedKind; label: string }[] = [
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "workday", label: "每工作日" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "custom", label: "自定义" },
];

/** 自定义重复的频率短语：every=1 → 每天/每周…；>1 → 每 2 天 */
const freqText = (every: number, unit: CustomUnit): string => (every === 1 ? `每${UNIT_CHAR[unit]}` : `每 ${every} ${UNIT_CHAR[unit]}`);
/** 历史数据兜底：unit 缺失/非法按「天」理解 */
const asUnit = (unit: TaskTriggerLoose["unit"]): CustomUnit => (unit !== undefined && CUSTOM_UNITS.includes(unit) ? unit : "day");

const pad = (n: number): string => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const DAYS_31 = Array.from({ length: 31 }, (_, i) => i + 1);
const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset(); // 本地时区（如 UTC+8 → 480）

function triggerText(trigger: TaskTriggerLoose): string {
  switch (trigger.kind) {
    case "once":
      return `单次 ${trigger.at ? new Date(trigger.at).toLocaleString() : ""}`;
    case "daily":
      return `每天 ${trigger.time}`;
    case "weekly": {
      const days = trigger.days ?? [];
      if (WORKDAYS.every((d) => days.includes(d)) && days.length === WORKDAYS.length) return `每工作日 ${trigger.time}`;
      return `每周${days.map((d) => WEEKDAY[d] ?? d).join("、")} ${trigger.time}`;
    }
    case "monthly":
      return `每月 ${trigger.day} 日 ${trigger.time}`;
    case "yearly":
      return `每年 ${trigger.month}-${trigger.day} ${trigger.time}`;
    case "interval": {
      const end = trigger.endTs ? ` · 至 ${new Date(trigger.endTs).toLocaleDateString()}` : "";
      const time = typeof trigger.time === "string" && trigger.time !== "" ? ` ${trigger.time}` : "";
      return `${freqText(trigger.every ?? 1, asUnit(trigger.unit))}${time}${end}`;
    }
    case "cron": {
      const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(trigger.expr ?? "");
      if (hourly) return `每小时第 ${hourly[1]!.padStart(2, "0")} 分`;
      return `cron ${trigger.expr}`;
    }
    default:
      return "?";
  }
}

function triggerShort(trigger: TaskTriggerLoose): string {
  // 左侧时间列：每日 → HH:mm；每小时 → 每小时；每周 → 周X HH:mm；每月 → N日 HH:mm；其余 → 触发摘要
  switch (trigger.kind) {
    case "daily":
      return trigger.time ?? "";
    case "weekly": {
      const days = trigger.days ?? [];
      const label = WORKDAYS.every((d) => days.includes(d)) && days.length === WORKDAYS.length ? "工作日" : days.map((d) => WEEKDAY[d] ?? d).join("");
      return `${label} ${trigger.time ?? ""}`.trim();
    }
    case "monthly":
      return `${trigger.day}日 ${trigger.time ?? ""}`.trim();
    case "yearly":
      return `${trigger.month}-${trigger.day}`;
    case "interval": {
      const base = freqText(trigger.every ?? 1, asUnit(trigger.unit));
      return typeof trigger.time === "string" && trigger.time !== "" ? `${base} ${trigger.time}` : base;
    }
    case "cron": {
      const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(trigger.expr ?? "");
      if (hourly) return "每小时";
      return "cron";
    }
    default:
      return "—";
  }
}

/** 提醒页：统计 + 每日/每周每月/已停用分组 + 最近通知，结构照 prototype 页 6 */
export function Tasks({ unread, onUnreadChange }: { unread: number; onUnreadChange: (n: number) => void }) {
  const [tasks, setTasks] = useState<TaskLoose[]>([]);
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [history, setHistory] = useState<Record<string, TaskRunLoose[] | undefined>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationLoose[]>([]);
  // 新建表单（结构化调度）
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [schedKind, setSchedKind] = useState<SchedKind>("daily");
  const [minute, setMinute] = useState(0); // 每小时的第 M 分
  const [hour, setHour] = useState(23);
  const [minuteOfHour, setMinuteOfHour] = useState(0);
  const [weekdays, setWeekdays] = useState<number[]>(WORKDAYS);
  const [monthDay, setMonthDay] = useState(1);
  // 自定义重复（interval 触发器）：每 N 天/周/月/年 + 结束条件
  const [customEvery, setCustomEvery] = useState(1);
  const [customUnit, setCustomUnit] = useState<CustomUnit>("day");
  const [customEnd, setCustomEnd] = useState<"never" | "date">("never");
  const [customEndDate, setCustomEndDate] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  // 通知渠道（2026-09-27）：站内（默认）| 微信机器人（站内记录 + 微信推送；未绑定时到点只发站内）
  const [notifyChannel, setNotifyChannel] = useState<"inapp" | "wechat">("inapp");
  const [wechatBound, setWechatBound] = useState(false);

  const reload = useCallback(async () => {
    setTasks(await api3.listTasks());
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
    void api2.listAgents().then(setAgents).catch(() => undefined);
    void apiIm
      .bindState()
      .then((state) => setWechatBound(state.bound && state.state === "active"))
      .catch(() => undefined);
  }, [reload]);

  const reloadNotifications = useCallback(async () => {
    const all = await api3.listNotifications().catch(() => []);
    setNotifications(all);
    onUnreadChange(all.filter((n) => !n.readTs).length);
  }, [onUnreadChange]);
  useEffect(() => {
    void reloadNotifications();
  }, [reloadNotifications]);

  const create = async () => {
    const createTime = `${pad(hour)}:${pad(minuteOfHour)}`;
    let trigger: TaskTriggerLoose;
    switch (schedKind) {
      case "hourly":
        trigger = { kind: "cron", expr: `${pad(minute)} * * * *` };
        break;
      case "daily":
        trigger = { kind: "daily", time: createTime };
        break;
      case "workday":
        trigger = { kind: "weekly", days: WORKDAYS, time: createTime };
        break;
      case "weekly":
        trigger = { kind: "weekly", days: weekdays.length > 0 ? weekdays : [1], time: createTime };
        break;
      case "monthly":
        trigger = { kind: "monthly", day: monthDay, time: createTime };
        break;
      case "custom": {
        if (customEnd === "date" && customEndDate === "") {
          setMessage("自定义重复：选了「指定日期」就要挑一个结束日期");
          return;
        }
        const every = Math.max(1, Math.floor(customEvery) || 1);
        const timed = isTimedUnit(customUnit);
        const start = new Date();
        if (timed) start.setHours(hour, minuteOfHour, 0, 0); // 天及以上：锚今天 HH:mm；分钟/小时：从现在起算
        const endTs = customEnd === "date" ? new Date(`${customEndDate}T23:59:59`).getTime() : undefined; // 含结束日当天
        trigger = {
          kind: "interval",
          every,
          unit: customUnit,
          ...(timed ? { time: createTime } : {}),
          startTs: start.getTime(),
          ...(endTs !== undefined && Number.isFinite(endTs) ? { endTs } : {}),
        };
        break;
      }
      default:
        trigger = { kind: "daily", time: createTime };
    }
    try {
      await api3.createTask({
        title,
        instruction,
        trigger,
        tzOffsetMinutes: TZ_OFFSET_MINUTES,
        ...(agentId !== "" ? { agentId } : {}),
        ...(notifyChannel === "wechat" ? { notifyChannel } : {}),
      });
      setTitle("");
      setInstruction("");
      setCreateOpen(false);
      setMessage("已创建（到点以该伙伴身份跑一次离线回合，提醒落进它的定时提醒会话）");
      await reload();
    } catch (e) {
      setMessage(`创建失败：${(e as Error).message}`);
    }
  };

  const showHistory = async (id: string) => {
    if (history[id]) {
      setHistory({ ...history, [id]: undefined });
      return;
    }
    setHistory({ ...history, [id]: await api3.taskRuns(id) });
  };

  const enabled = tasks.filter((t) => t.enabled);
  const daily = enabled.filter((t) => t.trigger.kind === "daily");
  const recurring = enabled.filter((t) => !["daily"].includes(t.trigger.kind));
  const disabled = tasks.filter((t) => !t.enabled);

  const taskRow = (task: TaskLoose) => (
    <div className={`flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 ${task.enabled ? "" : "opacity-70"}`}>
      <span className={`num w-20 shrink-0 text-sm font-medium ${task.enabled ? "text-ink" : "text-ink3"}`}>
        {triggerShort(task.trigger)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-ink">{task.title}</div>
        <div className="truncate text-xs text-ink3">
          {task.instruction}
          {task.lastRunTs ? ` · 上次 ${new Date(task.lastRunTs).toLocaleString()}` : " · 未跑过"}
        </div>
        {history[task.id] && (
          <div className="mt-1 text-xs text-ink3">
            {history[task.id]!.length === 0 && "（无运行记录）"}
            {history[task.id]!
              .slice(-5)
              .reverse()
              .map((run, i) => (
                <div key={i}>
                  {new Date(run.ts).toLocaleString()} · {run.status}
                  {run.detail ? `（${run.detail}）` : ""}
                </div>
              ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button className="text-xs text-ink3 transition hover:text-ink" onClick={() => void showHistory(task.id)}>
          历史
        </button>
        <button
          className="text-xs text-ink3 transition hover:text-ink"
          onClick={async () => {
            await api3.runTask(task.id);
            setMessage("已触发（离线回合异步执行，稍后看历史与通知）");
          }}
        >
          立即跑
        </button>
        <button
          className="text-xs text-ink3 transition hover:text-warm"
          onClick={async () => {
            await api3.deleteTask(task.id);
            await reload();
          }}
        >
          删除
        </button>
        <Toggle
          checked={task.enabled}
          title={task.enabled ? "停用" : "启用"}
          onChange={async () => {
            await api3.updateTask(task.id, { enabled: !task.enabled });
            await reload();
          }}
        />
      </div>
    </div>
  );

  const inputCls =
    "rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3";

  const createTime = `${pad(hour)}:${pad(minuteOfHour)}`;
  const scheduleSummary = (() => {
    switch (schedKind) {
      case "hourly":
        return `每小时第 ${pad(minute)} 分`;
      case "daily":
        return `每天 ${createTime}`;
      case "workday":
        return `每工作日 ${createTime}`;
      case "weekly":
        return `每周${(weekdays.length > 0 ? weekdays : [1]).map((d) => WEEKDAY[d]).join("、")} ${createTime}`;
      case "monthly":
        return `每月 ${monthDay} 号 ${createTime}`;
      default: {
        const every = Math.max(1, Math.floor(customEvery) || 1);
        const end = customEnd === "date" && customEndDate !== "" ? ` · 至 ${customEndDate}` : " · 永不结束";
        return isTimedUnit(customUnit) ? `${freqText(every, customUnit)} ${createTime}${end}` : `${freqText(every, customUnit)}${end}`;
      }
    }
  })();

  const selectCls = `${inputCls} w-auto`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">到点，伙伴主动来找你</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">提醒</h1>
        </div>
        <button
          className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
          onClick={() => setCreateOpen(!createOpen)}
        >
          ＋ 新建任务
        </button>
      </header>

      {/* 新建任务（按钮展开） */}
      {createOpen && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4">
          <div className="grid grid-cols-2 gap-2">
            <input className={inputCls} placeholder="标题（如：23点睡觉提醒）" value={title} onChange={(e) => setTitle(e.target.value)} />
            <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">伙伴：默认助手</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  伙伴：{a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2">
            <select className={inputCls} value={notifyChannel} onChange={(e) => setNotifyChannel(e.target.value === "wechat" ? "wechat" : "inapp")}>
              <option value="inapp">通知渠道：站内（提醒页）</option>
              <option value="wechat">通知渠道：微信机器人（站内 + 微信推送）</option>
            </select>
            {notifyChannel === "wechat" && !wechatBound && (
              <p className="mt-1 text-xs text-warm">还没绑定微信机器人——到菜单「IM 通道」扫码绑定前，到点只发站内。</p>
            )}
          </div>
          <div className="mt-2 space-y-2">
            <div className="text-sm font-medium text-ink">调度</div>
            <div className="flex flex-wrap items-center gap-2">
              <select className={selectCls} value={schedKind} onChange={(e) => setSchedKind(e.target.value as SchedKind)}>
                {SCHEDULE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {schedKind === "hourly" && (
                <>
                  <span className="text-sm text-ink2">第</span>
                  <select className={selectCls} value={minute} onChange={(e) => setMinute(Number(e.target.value))}>
                    {MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {pad(m)}
                      </option>
                    ))}
                  </select>
                  <span className="text-sm text-ink2">分钟</span>
                </>
              )}
              {schedKind === "weekly" && (
                <span className="flex gap-1">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`h-8 w-8 rounded-lg border text-xs transition ${
                        weekdays.includes(d)
                          ? "border-accent bg-accent3 font-medium text-accent"
                          : "border-line text-ink3 hover:border-accent hover:text-ink"
                      }`}
                      onClick={() =>
                        setWeekdays(weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort((a, b) => a - b))
                      }
                    >
                      {WEEKDAY[d]}
                    </button>
                  ))}
                </span>
              )}
              {schedKind === "monthly" && (
                <select className={selectCls} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>
                  {DAYS_31.map((d) => (
                    <option key={d} value={d}>
                      {d} 号
                    </option>
                  ))}
                </select>
              )}
              {(schedKind === "daily" || schedKind === "workday" || schedKind === "weekly" || schedKind === "monthly" || (schedKind === "custom" && isTimedUnit(customUnit))) && (
                <>
                  <span className="text-sm text-ink2">于</span>
                  <select className={selectCls} value={hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="小时">
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {pad(h)}
                      </option>
                    ))}
                  </select>
                  <select className={selectCls} value={minuteOfHour} onChange={(e) => setMinuteOfHour(Number(e.target.value))} aria-label="分钟">
                    {MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {pad(m)}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {schedKind === "custom" && (
                <button
                  type="button"
                  className="rounded-lg border border-line px-3 py-2 text-sm text-ink2 transition hover:border-accent hover:text-ink"
                  onClick={() => setCustomOpen(true)}
                >
                  自定义重复…<span className="ml-1.5 text-xs text-accent">{scheduleSummary}</span>
                </button>
              )}
              <span className="ml-auto text-xs text-ink3">{scheduleSummary}</span>
            </div>
            <p className="text-xs text-ink3">
              按本地时区（UTC{-TZ_OFFSET_MINUTES >= 0 ? "+" : ""}
              {-TZ_OFFSET_MINUTES / 60}）调度；到点提醒会落进该伙伴的定时提醒会话。
            </p>
          </div>
          <textarea
            className={`${inputCls} mt-2 w-full`}
            rows={2}
            placeholder="指令（每次到点投给伙伴的话，如：提醒用户准备睡觉，结合今日打卡温和劝）"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              onClick={() => void create()}
            >
              创建
            </button>
          </div>
        </div>
      )}
      {message && <p className="mb-4 text-sm text-ink3">{message}</p>}

      {/* 自定义重复弹窗：每 N 天/周/月/年 + 结束条件（落 interval 触发器） */}
      {customOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setCustomOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-ink">自定义重复</h3>
              <button className="text-lg leading-none text-ink3 transition hover:text-ink" onClick={() => setCustomOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <div className="mt-4 text-sm font-medium text-ink">重复频率</div>
            <div className="mt-2 flex gap-2">
              <input
                type="number"
                min={1}
                className={`${inputCls} w-24`}
                value={customEvery}
                onChange={(e) => setCustomEvery(Number(e.target.value))}
                aria-label="重复间隔"
              />
              <select className={`${inputCls} flex-1`} value={customUnit} onChange={(e) => setCustomUnit(e.target.value as CustomUnit)} aria-label="重复单位">
                {CUSTOM_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_CHAR[u]}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-4 text-sm font-medium text-ink">结束</div>
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-sm text-ink2">
                <input type="radio" checked={customEnd === "never"} onChange={() => setCustomEnd("never")} /> 永不结束
              </label>
              <label className="flex items-center gap-2 text-sm text-ink2">
                <input type="radio" checked={customEnd === "date"} onChange={() => setCustomEnd("date")} /> 指定日期
              </label>
              {customEnd === "date" && (
                <input type="date" className={inputCls} value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} />
              )}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-ink3">
                {freqText(Math.max(1, Math.floor(customEvery) || 1), customUnit)}
                {customEnd === "date" && customEndDate !== "" ? ` · 至 ${customEndDate}` : " · 永不结束"}
              </span>
              <button className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90" onClick={() => setCustomOpen(false)}>
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 统计行 */}
      <div className="mb-5 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink2">
        共 <span className="num font-semibold text-ink">{tasks.length}</span> 个任务 ·{" "}
        <span className="text-accent">{enabled.length} 启用</span> / <span className="text-ink3">{disabled.length} 停用</span>
        <span className="ml-2 text-xs text-ink3">错过不足 24h 补跑，更久跳过留痕</span>
      </div>

      {/* 每日任务 */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">每日任务</h2>
        <div className="space-y-1.5">
          {daily.length === 0 && <p className="text-sm text-ink3">（无）</p>}
          {daily.map((task) => (
            <div key={task.id}>{taskRow(task)}</div>
          ))}
        </div>
      </section>

      {/* 周期任务（每小时/每周/每月/自定义重复等） */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">周期任务</h2>
        <div className="space-y-1.5">
          {recurring.length === 0 && <p className="text-sm text-ink3">（无）</p>}
          {recurring.map((task) => (
            <div key={task.id}>{taskRow(task)}</div>
          ))}
        </div>
      </section>

      {/* 已停用 */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">已停用</h2>
        <div className="space-y-1.5">
          {disabled.length === 0 && <p className="text-sm text-ink3">（无）</p>}
          {disabled.map((task) => (
            <div key={task.id}>{taskRow(task)}</div>
          ))}
        </div>
      </section>

      {/* 最近通知（站内通道落地处；未读徽标同步到左侧导航） */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            最近通知 {unread > 0 && <span className="ml-1 rounded-full bg-warm px-2 py-0.5 text-[11px] font-semibold text-white">{unread} 未读</span>}
          </h2>
          <button
            className="text-xs text-accent hover:underline"
            onClick={async () => {
              await api3.markAllRead().catch(() => undefined);
              await reloadNotifications();
            }}
          >
            全部已读
          </button>
        </div>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {notifications.length === 0 && <div className="px-4 py-3 text-sm text-ink3">暂无通知</div>}
          {notifications
            .slice()
            .reverse()
            .slice(0, 30)
            .map((n) => (
              <div key={n.seq} className="px-4 py-3 text-sm" style={{ opacity: n.readTs ? 0.6 : 1 }}>
                <div className="whitespace-pre-wrap leading-relaxed text-ink">{n.text}</div>
                <div className="mt-1 text-[11px] text-ink3">
                  {new Date(n.ts).toLocaleString()}
                  {n.readTs ? "" : " · 未读"}
                </div>
              </div>
            ))}
        </div>
      </section>

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        也可以直接在对话里说「每晚 23 点提醒我睡觉」，伙伴会用 create_task 工具帮你建。
      </p>
    </div>
  );
}
