import { useCallback, useEffect, useState } from "react";
import { api2, api3, type AgentLoose, type TaskLoose, type TaskRunLoose, type TaskTriggerLoose } from "../api";

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

export function Tasks() {
  const [tasks, setTasks] = useState<TaskLoose[]>([]);
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [history, setHistory] = useState<Record<string, TaskRunLoose[] | undefined>>({});
  const [message, setMessage] = useState<string | null>(null);
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

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: "0 0 4px" }}>提醒</h1>
      <p className="muted">任务 = 伙伴 + 时刻 + 指令 + 开关；到点跑一次离线回合（读账本、可落账、可追问）；错过不足 24h 补跑，更久跳过留痕</p>

      <div className="card" style={{ marginTop: 16 }}>
        <label className="label">新建任务</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input className="input" placeholder="标题（如：23点睡觉提醒）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">伙伴：默认助手</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                伙伴：{a.name}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="input"
          style={{ marginTop: 8 }}
          rows={2}
          placeholder="指令（每次到点投给伙伴的话，如：提醒用户准备睡觉，结合今日打卡温和劝）"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="input" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as TaskTriggerLoose["kind"])}>
            {Object.entries(TRIGGER_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {kind === "daily" && (
            <input className="input" style={{ width: 110 }} value={time} onChange={(e) => setTime(e.target.value)} placeholder="23:00" />
          )}
          {kind === "weekly" && (
            <>
              <span style={{ display: "flex", gap: 4 }}>
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <label key={d} className="muted" style={{ fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={days.includes(d)}
                      onChange={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}
                    />{" "}
                    {WEEKDAY[d]}
                  </label>
                ))}
              </span>
              <input className="input" style={{ width: 110 }} value={time} onChange={(e) => setTime(e.target.value)} placeholder="08:00" />
            </>
          )}
          {kind === "cron" && (
            <input className="input" style={{ width: 200 }} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
          )}
          <button className="btn small" onClick={create}>
            创建
          </button>
        </div>
        {message && <p className="muted" style={{ margin: "8px 0 0" }}>{message}</p>}
      </div>

      <div className="section-title">任务列表（{tasks.length}）</div>
      <div className="card" style={{ padding: 0 }}>
        {tasks.length === 0 && <div className="flow-row muted">还没有定时任务</div>}
        {tasks.map((task) => (
          <div key={task.id} className="flow-row">
            <button
              className={`check${task.enabled ? " done" : ""}`}
              title={task.enabled ? "暂停" : "启用"}
              onClick={async () => {
                await api3.updateTask(task.id, { enabled: !task.enabled });
                await reload();
              }}
            >
              {task.enabled ? "▶" : ""}
            </button>
            <div className="meta">
              <div>
                {task.title}
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  {triggerText(task.trigger)}
                </span>
              </div>
              <div className="sub">
                {task.instruction}
                {task.lastRunTs ? ` · 上次 ${new Date(task.lastRunTs).toLocaleString()}` : " · 未跑过"}
              </div>
              {history[task.id] && (
                <div className="sub" style={{ marginTop: 4 }}>
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
            <button className="btn ghost small" onClick={() => void showHistory(task.id)}>
              历史
            </button>
            <button
              className="btn ghost small"
              onClick={async () => {
                await api3.runTask(task.id);
                setMessage("已触发（离线回合异步执行，稍后看历史与通知）");
              }}
            >
              立即跑
            </button>
            <button
              className="btn ghost small"
              onClick={async () => {
                await api3.deleteTask(task.id);
                await reload();
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        也可以直接在对话里说「每晚 23 点提醒我睡觉」，伙伴会用 create_task 工具帮你建。
      </p>
    </div>
  );
}
