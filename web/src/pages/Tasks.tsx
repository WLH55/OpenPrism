import { useCallback, useEffect, useState } from "react";
import { api2, api3, type AgentLoose, type NotificationLoose, type TaskLoose, type TaskRunLoose, type TaskTriggerLoose } from "../api";
import { Toggle } from "../ui";

const TRIGGER_LABEL: Record<string, string> = {
  once: "单次",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
  cron: "cron",
};
const WEEKDAY = ["", "一", "二", "三", "四", "五", "六", "日"];

function triggerText(trigger: TaskTriggerLoose): string {
  switch (trigger.kind) {
    case "once":
      return `单次 ${trigger.at ? new Date(trigger.at).toLocaleString() : ""}`;
    case "daily":
      return `每天 ${trigger.time}`;
    case "weekly":
      return `每周${(trigger.days ?? []).map((d) => WEEKDAY[d] ?? d).join("、")} ${trigger.time}`;
    case "monthly":
      return `每月 ${trigger.day} 日 ${trigger.time}`;
    case "yearly":
      return `每年 ${trigger.month}-${trigger.day} ${trigger.time}`;
    case "cron":
      return `cron ${trigger.expr}`;
    default:
      return "?";
  }
}

function triggerShort(trigger: TaskTriggerLoose): string {
  // 左侧时间列：每日 → HH:mm；每周 → 周X HH:mm；每月 → N日 HH:mm；其余 → 触发摘要
  switch (trigger.kind) {
    case "daily":
      return trigger.time ?? "";
    case "weekly":
      return `${(trigger.days ?? []).map((d) => WEEKDAY[d] ?? d).join("")} ${trigger.time ?? ""}`.trim();
    case "monthly":
      return `${trigger.day}日 ${trigger.time ?? ""}`.trim();
    case "yearly":
      return `${trigger.month}-${trigger.day}`;
    case "cron":
      return "cron";
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
  // 新建表单
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<TaskTriggerLoose["kind"]>("daily");
  const [time, setTime] = useState("23:00");
  const [days, setDays] = useState<number[]>([1]);
  const [cron, setCron] = useState("0 9 * * *");
  const [agentId, setAgentId] = useState("");

  const reload = useCallback(async () => {
    setTasks(await api3.listTasks());
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
    void api2.listAgents().then(setAgents).catch(() => undefined);
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
    const trigger: TaskTriggerLoose =
      kind === "daily"
        ? { kind: "daily", time }
        : kind === "weekly"
          ? { kind: "weekly", days, time }
          : kind === "cron"
            ? { kind: "cron", expr: cron }
            : { kind: "daily", time };
    try {
      await api3.createTask({ title, instruction, trigger, ...(agentId !== "" ? { agentId } : {}) });
      setTitle("");
      setInstruction("");
      setCreateOpen(false);
      setMessage("已创建（到点以该伙伴身份跑一次离线回合）");
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
          <textarea
            className={`${inputCls} mt-2`}
            rows={2}
            placeholder="指令（每次到点投给伙伴的话，如：提醒用户准备睡觉，结合今日打卡温和劝）"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className={`${inputCls} w-auto`} value={kind} onChange={(e) => setKind(e.target.value as TaskTriggerLoose["kind"])}>
              {Object.entries(TRIGGER_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {kind === "daily" && (
              <input className={`${inputCls} w-28`} value={time} onChange={(e) => setTime(e.target.value)} placeholder="23:00" />
            )}
            {kind === "weekly" && (
              <>
                <span className="flex gap-3 text-sm text-ink2">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <label key={d} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={days.includes(d)}
                        onChange={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}
                      />
                      {WEEKDAY[d]}
                    </label>
                  ))}
                </span>
                <input className={`${inputCls} w-28`} value={time} onChange={(e) => setTime(e.target.value)} placeholder="08:00" />
              </>
            )}
            {kind === "cron" && (
              <input className={`${inputCls} w-48 font-mono`} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
            )}
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

      {/* 每周/每月 */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">每周 / 每月</h2>
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
