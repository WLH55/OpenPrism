import { useCallback, useEffect, useState } from "react";
import { api2 } from "../api";
import { Toggle } from "../ui";

const SLOTS: { key: string; label: string; hint: string }[] = [
  { key: "profile", label: "画像", hint: "你是谁、在乎什么" },
  { key: "preferences", label: "偏好", hint: "你显式表达过的偏好" },
  { key: "recent", label: "近期", hint: "最近发生的事（自动凝练主战场）" },
  { key: "scope", label: "当前主线", hint: "正在推进的事" },
];

/** 长期记忆页：槽位卡 + 手动重跑凝练，结构照 prototype 页 10 */
export function Memory() {
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<{ lastRunTs?: number; runs: number }>({ runs: 0 });
  const [editing, setEditing] = useState<string | null>(null);
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
    setEditing(null);
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
      setMessage(`凝练失败：${(e as Error).message === "model_not_configured" ? "先去「模型接入」页配置模型" : (e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">三层记忆 · 自动凝练 + 你可随时改</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">长期记忆</h1>
        </div>
        <button
          className="rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-ink2 transition hover:text-ink"
          disabled={busy}
          onClick={() => void consolidate()}
        >
          {busy ? "凝练中…" : "手动重跑凝练"}
        </button>
      </header>
      {message && <p className="mb-4 text-sm text-ink3">{message}</p>}
      {meta.lastRunTs && (
        <p className="mb-4 text-xs text-ink3">
          上次凝练 {new Date(meta.lastRunTs).toLocaleString()} · 累计 {meta.runs} 次
        </p>
      )}

      {/* 槽位卡 */}
      <div className="space-y-3">
        {SLOTS.map((slot) => {
          const text = slots[slot.key] ?? "";
          return (
            <section key={slot.key} className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">
                  {slot.label} <span className="text-ink3">{slot.key}</span>
                </h2>
                <button
                  className="text-xs text-accent hover:underline"
                  onClick={() => setEditing(editing === slot.key ? null : slot.key)}
                >
                  {editing === slot.key ? "取消" : "编辑"}
                </button>
              </div>
              {editing === slot.key ? (
                <div>
                  <textarea
                    rows={Math.max(4, text.split("\n").length + 1)}
                    className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] leading-relaxed text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent3"
                    value={text}
                    onChange={(e) => setSlots({ ...slots, [slot.key]: e.target.value })}
                  />
                  <button
                    className="mt-2 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                    onClick={() => void save(slot.key, text)}
                  >
                    保存
                  </button>
                </div>
              ) : text.trim() === "" ? (
                <p className="text-sm text-ink3">（空——凝练或手动编辑后出现在这里）</p>
              ) : (
                <ul className="space-y-1.5 text-[15px] leading-relaxed text-ink">
                  {text.split("\n").filter((l) => l.trim() !== "").map((line, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-ink3">·</span>
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-ink3">{slot.hint}</p>
            </section>
          );
        })}
      </div>

      {/* 自动凝练 */}
      <section className="mt-5 rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <div className="text-[15px] text-ink">自动凝练</div>
            <div className="text-xs text-ink3">服务启动时惰性检查（距上次超 20 小时且有会话），从会话日志提炼新记忆</div>
          </div>
          <Toggle checked onChange={() => undefined} title="随服务自动跑，无需配置" />
        </div>
      </section>

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        四槽位全量自动注入所有伙伴的 system prompt（溯源脚注自动剥离）。原始层不用维护：对话本身就是日志，记忆永远可从会话日志重建。
      </p>
    </div>
  );
}
