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

type SchedKind = "once" | "hourly" | "daily" | "workday" | "weekly" | "monthly" | "custom";

const SCHEDULE_TYPES: { value: SchedKind; label: string }[] = [
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "workday", label: "每工作日" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "once", label: "单次" },
  { value: "custom", label: "自定义" },
];

/** 自定义重复的频率短语：every=1 → 每天/每周…；>1 → 每 2 天 */
const freqText = (every: number, unit: CustomUnit): string => (every === 1 ? `每${UNIT_CHAR[unit]}` : `每 ${every} ${UNIT_CHAR[unit]}`);
/** 历史数据兜底：unit 缺失/非法按「天」理解 */
const asUnit = (unit: TaskTriggerLoose["unit"]): CustomUnit => (unit !== undefined && CUSTOM_UNITS.includes(unit) ? unit : "day");

const pad = (n: number): string => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const SECONDS = MINUTES; // 秒与分同为 0..59
/** 本地日期串 YYYY-MM-DD（input[type=date] 的值格式） */
const localDateStr = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    case "once": {
      if (!trigger.at) return "单次";
      const d = new Date(trigger.at);
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}${d.getSeconds() !== 0 ? `:${pad(d.getSeconds())}` : ""}`;
    }
    default:
      return "—";
  }
}

/** 模板按钮的图标与顺序（文案/时刻来自服务端投影） */
const TPL_ICONS: [string, string][] = [
  ["daily-brief", "☀️"],
  ["daily-report", "🌙"],
  ["weekly-review", "📈"],
];

const inputCls =
  "rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3";
const selectCls = `${inputCls} w-auto`;

// ── 调度选择器（创建/编辑共用，2026-09-30 任务编辑入口） ──────────────

interface SchedState {
  kind: SchedKind;
  minute: number; // 每小时的第 M 分
  hour: number;
  minuteOfHour: number;
  weekdays: number[];
  monthDay: number;
  onceDate: string;
  onceHour: number;
  onceMinute: number;
  onceSecond: number;
  customEvery: number;
  customUnit: CustomUnit;
  customEnd: "never" | "date";
  customEndDate: string;
}

/** 触发器 → 选择器初值（编辑回填）。hourly cron 认得；其余 cron 表达不了就退化为 daily 初值——
 *  编辑面板只在用户真正动了调度时才上抛新触发器，不动则原样保留 */
function reverseMapTrigger(t: TaskTriggerLoose | undefined): SchedState {
  const base: SchedState = {
    kind: "daily",
    minute: 0,
    hour: 23,
    minuteOfHour: 0,
    weekdays: WORKDAYS,
    monthDay: 1,
    onceDate: localDateStr(new Date(Date.now() + 86400000)),
    onceHour: 9,
    onceMinute: 0,
    onceSecond: 0,
    customEvery: 1,
    customUnit: "day",
    customEnd: "never",
    customEndDate: "",
  };
  if (t === undefined) return base;
  const parts = typeof t.time === "string" && t.time !== "" ? t.time.split(":") : [];
  const hour = parts.length >= 1 ? Number(parts[0]) : base.hour;
  const minuteOfHour = parts.length >= 2 ? Number(parts[1]) : base.minuteOfHour;
  switch (t.kind) {
    case "daily":
      return { ...base, kind: "daily", hour, minuteOfHour };
    case "weekly": {
      const days = t.days ?? [1];
      const isWorkdays = WORKDAYS.every((d) => days.includes(d)) && days.length === WORKDAYS.length;
      return { ...base, kind: isWorkdays ? "workday" : "weekly", weekdays: days, hour, minuteOfHour };
    }
    case "monthly":
      return { ...base, kind: "monthly", monthDay: t.day ?? 1, hour, minuteOfHour };
    case "once": {
      const d = new Date(t.at ?? Date.now() + 86400000);
      return { ...base, kind: "once", onceDate: localDateStr(d), onceHour: d.getHours(), onceMinute: d.getMinutes(), onceSecond: d.getSeconds() };
    }
    case "interval":
      return {
        ...base,
        kind: "custom",
        customEvery: t.every ?? 1,
        customUnit: asUnit(t.unit),
        customEnd: t.endTs !== undefined ? "date" : "never",
        customEndDate: t.endTs !== undefined ? localDateStr(new Date(t.endTs)) : "",
        hour,
        minuteOfHour,
      };
    case "cron": {
      const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(t.expr ?? "");
      return hourly !== null ? { ...base, kind: "hourly", minute: Number(hourly[1]) } : base;
    }
    default:
      return base;
  }
}

/** 选择器状态 → 触发器；无效中间态返回 null（单次缺日期/过去时刻、自定义重复缺结束日） */
function buildSchedTrigger(s: SchedState): TaskTriggerLoose | null {
  const createTime = `${pad(s.hour)}:${pad(s.minuteOfHour)}`;
  switch (s.kind) {
    case "hourly":
      return { kind: "cron", expr: `${pad(s.minute)} * * * *` };
    case "daily":
      return { kind: "daily", time: createTime };
    case "workday":
      return { kind: "weekly", days: WORKDAYS, time: createTime };
    case "weekly":
      return { kind: "weekly", days: s.weekdays.length > 0 ? s.weekdays : [1], time: createTime };
    case "monthly":
      return { kind: "monthly", day: s.monthDay, time: createTime };
    case "once": {
      const at = new Date(`${s.onceDate}T${pad(s.onceHour)}:${pad(s.onceMinute)}:${pad(s.onceSecond)}`).getTime();
      if (s.onceDate === "" || !Number.isFinite(at) || at <= Date.now()) return null;
      return { kind: "once", at };
    }
    case "custom": {
      if (s.customEnd === "date" && s.customEndDate === "") return null;
      const every = Math.max(1, Math.floor(s.customEvery) || 1);
      const timed = isTimedUnit(s.customUnit);
      const start = new Date();
      if (timed) start.setHours(s.hour, s.minuteOfHour, 0, 0); // 天及以上锚今天 HH:mm；分钟/小时从现在起算
      const endTs = s.customEnd === "date" ? new Date(`${s.customEndDate}T23:59:59`).getTime() : undefined; // 含结束日当天
      return {
        kind: "interval",
        every,
        unit: s.customUnit,
        ...(timed ? { time: createTime } : {}),
        startTs: start.getTime(),
        ...(endTs !== undefined && Number.isFinite(endTs) ? { endTs } : {}),
      };
    }
    default:
      return null;
  }
}

/** 选择器当前选择的人话摘要（实时显示在控件行右侧） */
function schedSummary(s: SchedState): string {
  const createTime = `${pad(s.hour)}:${pad(s.minuteOfHour)}`;
  switch (s.kind) {
    case "hourly":
      return `每小时第 ${pad(s.minute)} 分`;
    case "daily":
      return `每天 ${createTime}`;
    case "workday":
      return `每工作日 ${createTime}`;
    case "weekly":
      return `每周${(s.weekdays.length > 0 ? s.weekdays : [1]).map((d) => WEEKDAY[d]).join("、")} ${createTime}`;
    case "monthly":
      return `每月 ${s.monthDay} 号 ${createTime}`;
    case "once":
      return `单次 ${s.onceDate} ${pad(s.onceHour)}:${pad(s.onceMinute)}:${pad(s.onceSecond)}`;
    default: {
      const every = Math.max(1, Math.floor(s.customEvery) || 1);
      const end = s.customEnd === "date" && s.customEndDate !== "" ? ` · 至 ${s.customEndDate}` : " · 永不结束";
      return isTimedUnit(s.customUnit) ? `${freqText(every, s.customUnit)} ${createTime}${end}` : `${freqText(every, s.customUnit)}${end}`;
    }
  }
}

/** 调度选择器：内部持有全部调度状态（挂载时读 initial），用户每改一次就上抛构建好的触发器；
 *  没动过就不上抛——编辑面板据此保留原触发器（表不了的 cron 不会被意外改写） */
function ScheduleFields({ initial, onChange }: { initial?: TaskTriggerLoose; onChange: (trigger: TaskTriggerLoose | null) => void }) {
  const [st, setSt] = useState<SchedState>(() => reverseMapTrigger(initial));
  const [customOpen, setCustomOpen] = useState(false);
  const update = (patch: Partial<SchedState>): void => {
    const next = { ...st, ...patch };
    setSt(next);
    onChange(buildSchedTrigger(next)); // 无效中间态上抛 null，提交侧拦
  };
  const summary = schedSummary(st);
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-ink">调度</div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={st.kind} onChange={(e) => update({ kind: e.target.value as SchedKind })}>
          {SCHEDULE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {st.kind === "hourly" && (
          <>
            <span className="text-sm text-ink2">第</span>
            <select className={selectCls} value={st.minute} onChange={(e) => update({ minute: Number(e.target.value) })}>
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {pad(m)}
                </option>
              ))}
            </select>
            <span className="text-sm text-ink2">分钟</span>
          </>
        )}
        {st.kind === "weekly" && (
          <span className="flex gap-1">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <button
                key={d}
                type="button"
                className={`h-8 w-8 rounded-lg border text-xs transition ${
                  st.weekdays.includes(d) ? "border-accent bg-accent3 font-medium text-accent" : "border-line text-ink3 hover:border-accent hover:text-ink"
                }`}
                onClick={() => update({ weekdays: st.weekdays.includes(d) ? st.weekdays.filter((x) => x !== d) : [...st.weekdays, d].sort((a, b) => a - b) })}
              >
                {WEEKDAY[d]}
              </button>
            ))}
          </span>
        )}
        {st.kind === "monthly" && (
          <select className={selectCls} value={st.monthDay} onChange={(e) => update({ monthDay: Number(e.target.value) })}>
            {DAYS_31.map((d) => (
              <option key={d} value={d}>
                {d} 号
              </option>
            ))}
          </select>
        )}
        {st.kind === "once" && (
          <>
            <input type="date" className={selectCls} value={st.onceDate} onChange={(e) => update({ onceDate: e.target.value })} aria-label="日期" />
            <select className={selectCls} value={st.onceHour} onChange={(e) => update({ onceHour: Number(e.target.value) })} aria-label="小时">
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {pad(h)}
                </option>
              ))}
            </select>
            <select className={selectCls} value={st.onceMinute} onChange={(e) => update({ onceMinute: Number(e.target.value) })} aria-label="分钟">
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {pad(m)}
                </option>
              ))}
            </select>
            <select className={selectCls} value={st.onceSecond} onChange={(e) => update({ onceSecond: Number(e.target.value) })} aria-label="秒">
              {SECONDS.map((s) => (
                <option key={s} value={s}>
                  {pad(s)}
                </option>
              ))}
            </select>
          </>
        )}
        {(st.kind === "daily" || st.kind === "workday" || st.kind === "weekly" || st.kind === "monthly" || (st.kind === "custom" && isTimedUnit(st.customUnit))) && (
          <>
            <span className="text-sm text-ink2">于</span>
            <select className={selectCls} value={st.hour} onChange={(e) => update({ hour: Number(e.target.value) })} aria-label="小时">
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {pad(h)}
                </option>
              ))}
            </select>
            <select className={selectCls} value={st.minuteOfHour} onChange={(e) => update({ minuteOfHour: Number(e.target.value) })} aria-label="分钟">
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {pad(m)}
                </option>
              ))}
            </select>
          </>
        )}
        {st.kind === "custom" && (
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink2 transition hover:border-accent hover:text-ink"
            onClick={() => setCustomOpen(true)}
          >
            自定义重复…<span className="ml-1.5 text-xs text-accent">{summary}</span>
          </button>
        )}
        <span className="ml-auto text-xs text-ink3">{summary}</span>
      </div>
      <p className="text-xs text-ink3">
        按本地时区（UTC{-TZ_OFFSET_MINUTES >= 0 ? "+" : ""}
        {-TZ_OFFSET_MINUTES / 60}）调度；到点提醒会落进该伙伴的定时提醒会话。
      </p>

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
                value={st.customEvery}
                onChange={(e) => update({ customEvery: Number(e.target.value) })}
                aria-label="重复间隔"
              />
              <select className={`${inputCls} flex-1`} value={st.customUnit} onChange={(e) => update({ customUnit: e.target.value as CustomUnit })} aria-label="重复单位">
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
                <input type="radio" checked={st.customEnd === "never"} onChange={() => update({ customEnd: "never" })} /> 永不结束
              </label>
              <label className="flex items-center gap-2 text-sm text-ink2">
                <input type="radio" checked={st.customEnd === "date"} onChange={() => update({ customEnd: "date" })} /> 指定日期
              </label>
              {st.customEnd === "date" && <input type="date" className={inputCls} value={st.customEndDate} onChange={(e) => update({ customEndDate: e.target.value })} />}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-ink3">
                {freqText(Math.max(1, Math.floor(st.customEvery) || 1), st.customUnit)}
                {st.customEnd === "date" && st.customEndDate !== "" ? ` · 至 ${st.customEndDate}` : " · 永不结束"}
              </span>
              <button className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90" onClick={() => setCustomOpen(false)}>
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 任务编辑面板（2026-09-30 任务编辑入口）：标题/指令/调度/通知渠道；内置任务可一键恢复默认文案 */
function TaskEditPanel({
  task,
  templates,
  onClose,
  onSaved,
}: {
  task: TaskLoose;
  templates: { builtin: string; title: string; instruction: string; trigger: TaskTriggerLoose; label: string }[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [instruction, setInstruction] = useState(task.instruction);
  const [notifyChannel, setNotifyChannel] = useState<"inapp" | "wechat">(task.notifyChannel ?? "inapp");
  const [trigger, setTrigger] = useState<TaskTriggerLoose | null>(task.trigger);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tplDef = templates?.find((t) => t.builtin === task.builtin);

  const save = async (): Promise<void> => {
    if (title.trim() === "" || instruction.trim() === "") {
      setMsg("标题和指令都不能为空");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api3.updateTask(task.id, {
        title: title.trim(),
        instruction: instruction.trim(),
        trigger: trigger ?? task.trigger, // 调度没动过（或中间态无效）就保持原触发器
        ...(notifyChannel === "wechat" ? { notifyChannel: "wechat" as const } : { notifyChannel: "inapp" as const }),
      });
      onSaved();
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const resetInstruction = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api3.updateTask(task.id, { resetInstruction: true });
      setInstruction(next.instruction);
      setMsg("已恢复默认文案（并恢复启动同步）");
    } catch (e) {
      setMsg(`恢复失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-xl border border-accent/40 bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="标题" />
        <div className="flex items-center gap-2 text-xs text-ink3">
          {task.builtin !== undefined && task.customized === true && <span className="rounded bg-warm/10 px-1.5 py-0.5 text-[10px] text-warm">文案已自定义</span>}
          {task.builtin !== undefined && <span className="text-ink3">内置任务：改过文案后不再被启动同步覆盖</span>}
        </div>
      </div>
      <textarea
        className={`${inputCls} mt-2 w-full`}
        rows={3}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        aria-label="指令"
      />
      <div className="mt-2">
        <select className={inputCls} value={notifyChannel} onChange={(e) => setNotifyChannel(e.target.value === "wechat" ? "wechat" : "inapp")}>
          <option value="inapp">通知渠道：站内（提醒页）</option>
          <option value="wechat">通知渠道：微信机器人（站内 + 微信推送）</option>
        </select>
      </div>
      <div className="mt-2">
        <ScheduleFields key={task.id} initial={task.trigger} onChange={setTrigger} />
      </div>
      {msg && <p className="mt-2 text-xs text-ink3">{msg}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button className="text-sm text-ink3 transition hover:text-ink" onClick={onClose}>
          收起
        </button>
        {task.builtin !== undefined && tplDef !== undefined && (
          <button className="ml-auto text-xs text-accent hover:underline" disabled={busy} onClick={() => void resetInstruction()} title={`恢复为默认文案：${tplDef.instruction.slice(0, 60)}…`}>
            恢复默认文案
          </button>
        )}
      </div>
    </div>
  );
}

/** 提醒页：统计 + 每日/每周每月/已停用分组 + 最近通知，结构照 prototype 页 6 */
export function Tasks({ unread, onUnreadChange }: { unread: number; onUnreadChange: (n: number) => void }) {
  const [tasks, setTasks] = useState<TaskLoose[]>([]);
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [history, setHistory] = useState<Record<string, TaskRunLoose[] | undefined>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationLoose[]>([]);
  // 内置三件套模板（评审 2026-09-29 #13 单源）：服务端 BUILTIN_TASK_DEFS 投影，模板按钮唯一文案来源
  const [templates, setTemplates] = useState<{ builtin: string; title: string; instruction: string; trigger: TaskTriggerLoose; label: string }[] | null>(null);
  useEffect(() => {
    void api3.taskTemplates().then(setTemplates).catch(() => undefined);
  }, []);
  const applyTemplate = (t: { title: string; instruction: string; trigger: TaskTriggerLoose }): void => {
    setTitle(t.title);
    setInstruction(t.instruction);
    // 调度器只读挂载初值：套模板后重挂（schedKey 自增），让控件回显模板时刻
    setDraftTrigger(t.trigger);
    setSchedKey((k) => k + 1);
  };
  // 新建表单（2026-09-30 任务编辑：调度选择器抽成 ScheduleFields，创建/编辑共用）
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [draftTrigger, setDraftTrigger] = useState<TaskTriggerLoose | null>(null);
  const [schedKey, setSchedKey] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 指令行展开（2026-09-30 用户验收）：长指令截断后点不动看不到全文——点击这行在截断/完整间切换
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
    if (draftTrigger === null) {
      setMessage("调度还没选完整（单次要选未来的日期时刻，自定义重复选了结束日就要挑日期）");
      return;
    }
    try {
      await api3.createTask({
        title,
        instruction,
        trigger: draftTrigger,
        tzOffsetMinutes: TZ_OFFSET_MINUTES,
        ...(agentId !== "" ? { agentId } : {}),
        ...(notifyChannel === "wechat" ? { notifyChannel } : {}),
      });
      setTitle("");
      setInstruction("");
      setDraftTrigger(null);
      setSchedKey((k) => k + 1);
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
  const once = enabled.filter((t) => t.trigger.kind === "once");
  const recurring = enabled.filter((t) => t.trigger.kind !== "daily" && t.trigger.kind !== "once");
  const disabled = tasks.filter((t) => !t.enabled);

  const taskRow = (task: TaskLoose) => (
    <>
      <div className={`flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 ${task.enabled ? "" : "opacity-70"}`}>
        <span className={`num w-20 shrink-0 text-sm font-medium ${task.enabled ? "text-ink" : "text-ink3"}`}>
          {triggerShort(task.trigger)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] text-ink">{task.title}</span>
            {task.builtin !== undefined && (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent" title="内置任务：注册时自动创建，可改可关，删除后可用模板重建">
                内置
              </span>
            )}
            {task.builtin !== undefined && task.customized === true && (
              <span className="shrink-0 rounded bg-warm/10 px-1.5 py-0.5 text-[10px] text-warm" title="指令文案已被你改过：启动时的默认文案同步会跳过这条任务">
                已自定义
              </span>
            )}
          </div>
          <div
            className={`${expandedId === task.id ? "whitespace-pre-wrap break-words" : "truncate"} cursor-pointer text-xs text-ink3`}
            title={expandedId === task.id ? "点击收起" : "点击展开完整指令"}
            onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
          >
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
          <button className="text-xs text-ink3 transition hover:text-ink" onClick={() => setEditingId(editingId === task.id ? null : task.id)}>
            编辑
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
      {/* 编辑面板（2026-09-30 任务编辑入口）：标题/指令/调度/渠道；内置任务可恢复默认文案 */}
      {editingId === task.id && (
        <TaskEditPanel
          task={task}
          templates={templates}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            void reload();
          }}
        />
      )}
    </>
  );

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
          {/* 调度选择器（创建/编辑共用组件，2026-09-30 任务编辑）：模板套用后 schedKey 重挂回显模板时刻 */}
          <div className="mt-2">
            <ScheduleFields key={schedKey} initial={draftTrigger ?? undefined} onChange={setDraftTrigger} />
          </div>
          {/* 模板按钮 = 服务端 BUILTIN_TASK_DEFS 单源投影（评审 2026-09-29 #13）：文案/时刻与种子同源，改指令只改 tasks.ts 一处 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink3">模板：</span>
            {TPL_ICONS.map(([key, icon]) => {
              const t = templates?.find((x) => x.builtin === key);
              if (t === undefined) return null;
              return (
                <button
                  key={key}
                  type="button"
                  className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink2 transition hover:border-accent hover:text-ink"
                  onClick={() => applyTemplate(t)}
                >
                  {icon} {t.title}（{t.label}）
                </button>
              );
            })}
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

      {/* 单次任务（once 触发器：到点跑一次即止，错过 <24h 补跑） */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">单次任务</h2>
        <div className="space-y-1.5">
          {once.length === 0 && <p className="text-sm text-ink3">（无）</p>}
          {once.map((task) => (
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
