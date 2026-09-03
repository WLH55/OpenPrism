import { useCallback, useEffect, useState } from "react";
import { api2 } from "../api";

const SLOTS: { key: string; label: string; hint: string }[] = [
  { key: "recent", label: "近期动态", hint: "最近发生的事" },
  { key: "profile", label: "画像", hint: "你是谁、在乎什么" },
  { key: "scope", label: "当前主线", hint: "正在推进的事" },
  { key: "preferences", label: "偏好", hint: "你显式表达过的偏好" },
];

export function Memory() {
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<{ lastRunTs?: number; runs: number }>({ runs: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const state = await api2.getMemory();
    setSlots(state.slots);
    setMeta(state.meta);
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const save = async (slot: string, markdown: string) => {
    await api2.putMemorySlot(slot, markdown);
    setMessage(`已保存 ${slot}`);
    await reload();
  };

  const consolidate = async () => {
    setBusy(true);
    setMessage("凝练中（用你配置的模型读近期对话…）");
    try {
      const result = await api2.consolidateMemory();
      setMessage(result.changed ? "凝练完成，槽位已更新" : "凝练完成，但没有可落盘的内容（fail-safe）");
      await reload();
    } catch (e) {
      setMessage(`凝练失败：${(e as Error).message === "model_not_configured" ? "先去设置页配置模型" : (e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <div>
          <h1 style={{ margin: "0 0 4px" }}>长期记忆</h1>
          <p className="muted">
            四槽位 · 全量自动注入所有伙伴的 system prompt（溯源脚注自动剥离）
            {meta.lastRunTs ? ` · 上次凝练 ${new Date(meta.lastRunTs).toLocaleString()}（${meta.runs} 次）` : " · 还没凝练过"}
          </p>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={busy} onClick={consolidate}>
          {busy ? "凝练中…" : "手动凝练"}
        </button>
      </div>
      {message && <p className="muted">{message}</p>}

      {SLOTS.map((slot) => (
        <div key={slot.key} style={{ marginTop: 14 }}>
          <label className="label">
            {slot.label}（{slot.key}）· {slot.hint}
          </label>
          <textarea
            className="input"
            rows={slots[slot.key]?.split("\n").length > 4 ? slots[slot.key].split("\n").length + 1 : 4}
            value={slots[slot.key] ?? ""}
            onChange={(e) => setSlots({ ...slots, [slot.key]: e.target.value })}
          />
          <button className="btn ghost small" style={{ marginTop: 6 }} onClick={() => void save(slot.key, slots[slot.key] ?? "")}>
            保存
          </button>
        </div>
      ))}
      <p className="muted" style={{ marginTop: 14 }}>
        原始层不用维护：对话本身就是日志，记忆永远可从会话日志重建。自动凝练在服务启动时惰性检查（距上次超 20 小时且有新会话）。
      </p>
    </div>
  );
}
