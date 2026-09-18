import { useCallback, useEffect, useState } from "react";
import { api2, type MemoryItemLoose, type MemoryOverviewLoose, type MemoryTopicLoose } from "../api";

const KIND_LABEL: Record<string, string> = { profile: "画像", preference: "偏好", fact: "事实", task: "任务", interest: "兴趣" };
const ORIGIN_LABEL: Record<string, string> = { explicit: "显式", extracted: "后台", manual: "手动" };
const STATUS_TABS: { key: string; label: string; icon: string }[] = [
  { key: "active", label: "生效中", icon: "✅" },
  { key: "pending", label: "待确认", icon: "❓" },
  { key: "superseded", label: "已被更新", icon: "🕐" },
  { key: "archived", label: "已归档", icon: "📁" },
];
const KIND_TABS: { key: string; label: string }[] = [
  { key: "", label: "全部类型" },
  { key: "profile", label: "画像" },
  { key: "preference", label: "偏好" },
  { key: "fact", label: "事实" },
  { key: "task", label: "任务" },
  { key: "interest", label: "兴趣" },
];

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 长期记忆页（条目化，2026-09-10 WeKnora 化重构）：状态标签 + 计数、添加/导出/整理/清空、pending 确认/拒绝、supersede 审计链。 */
export function Memory() {
  const [ov, setOv] = useState<MemoryOverviewLoose | null>(null);
  const [status, setStatus] = useState("active");
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<MemoryItemLoose[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ kind: "fact", content: "", importance: 3, topic: "" });
  const [editing, setEditing] = useState<{ id: string; content: string; importance: number; topic: string } | null>(null);
  const [topics, setTopics] = useState<MemoryTopicLoose[]>([]);
  const [threshold, setThreshold] = useState(3);

  const reload = useCallback(async () => {
    const overview = await api2.getMemory();
    setOv(overview);
    if (overview.config) setThreshold(overview.config.interestThreshold);
  }, []);
  const reloadTopics = useCallback(async () => {
    setTopics((await api2.listMemoryTopics()).topics);
  }, []);
  const reloadItems = useCallback(async () => {
    const r = await api2.listMemoryItems({ ...(status ? { status } : {}), ...(kind ? { kind } : {}), limit: 200 });
    setItems(r.items);
  }, [status, kind]);
  useEffect(() => {
    void reload().catch(() => undefined);
    void reloadTopics().catch(() => undefined);
  }, [reload, reloadTopics]);
  useEffect(() => {
    void reloadItems().catch(() => undefined);
  }, [reloadItems]);

  const act = (fn: () => Promise<string>) => async () => {
    setBusy(true);
    try {
      setMessage(await fn());
      await Promise.all([reload(), reloadItems(), reloadTopics()]);
    } catch (e) {
      const msg = (e as Error).message;
      setMessage(msg === "model_not_configured" ? "先去「模型接入」页配置模型" : msg === "已取消" ? "" : `操作失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const extract = act(async () => {
    const r = await api2.extractMemory();
    if (r.skipped === "no_new_input") return "没有新内容可提取";
    return `提取完成：处理 ${r.segments} 段，+${r.added} 新增 / ~${r.updated} 更新 / -${r.deleted} 删除${r.skipped === "model_error" ? "（部分段失败，稍后自动重试）" : ""}`;
  });
  const consolidate = act(async () => {
    const r = await api2.consolidateMemory();
    if (r.skipped === "too_soon") return "整理太频繁，稍后再试";
    if (r.skipped === "too_few_items") return "条目还太少，没什么可整理";
    return `整理完成：检查 ${r.reviewed} 条，过期 ${r.expired} · 降级 ${r.demoted} · 合并 ${r.merged}`;
  });
  const clearAll = act(async () => {
    if (!window.confirm("清空全部记忆？此操作不可恢复（已删除内容不会被后台再学回来）。")) throw new Error("已取消");
    const r = await api2.clearMemoryItems();
    return `已清空 ${r.removed} 条记忆`;
  });
  const removeItem = (id: string) =>
    void act(async () => {
      if (!window.confirm("删除这条记忆？后台不会再把它学回来。")) throw new Error("已取消");
      await api2.removeMemoryItem(id);
      return "已删除";
    })();

  const counts = ov?.counts ?? {};
  const total = counts.total ?? 0;
  const nextExtract = ov?.meta.scheduledTs ? ` · 下次提取 ${fmtTime(ov.meta.scheduledTs)}` : "";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">🧠 关于你的全部记忆，一条一条</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">记忆列表 · 共 {total} 条</h1>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink2 transition hover:text-ink disabled:opacity-60"
            disabled={busy}
            onClick={() => {
              setAddForm({ kind: "fact", content: "", importance: 3, topic: "" });
              setAdding(true);
            }}
          >
            ＋ 添加
          </button>
          <a
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink2 transition hover:text-ink"
            href={api2.exportMemoryUrl()}
            download
          >
            导出
          </a>
          <button
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink2 transition hover:text-ink disabled:opacity-60"
            disabled={busy}
            onClick={() => void consolidate()}
          >
            整理
          </button>
          <button
            className="rounded-lg border border-warm/40 bg-surface px-3 py-2 text-sm text-warm transition hover:border-warm disabled:opacity-60"
            disabled={busy || total === 0}
            onClick={() => void clearAll()}
          >
            清空
          </button>
        </div>
      </header>
      {message && <p className="mb-4 text-sm text-ink3">{message}</p>}

      {/* 主题计数（同一主题被多次谈起 → 自动变成长期兴趣） */}
      {topics.length > 0 && (
        <section className="mb-4 rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <div className="text-sm font-semibold text-ink">关注中的主题</div>
            <div className="text-[11px] text-ink3">谈满 {threshold} 次自动成为兴趣记忆</div>
          </div>
          <ul className="space-y-1.5">
            {topics.map((topic) => (
              <li key={topic.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium text-ink">{topic.topic}</span>
                <span className="text-[11px] text-ink3">
                  {topic.hits}/{threshold}
                  {topic.hits >= threshold ? " · 可晋升" : ""}
                  {topic.aliases.length > 0 ? ` · 别名 ${topic.aliases.length}` : ""}
                </span>
                <span className="ml-auto flex gap-2 text-[12px]">
                  <button
                    className="text-accent hover:underline disabled:opacity-60"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api2.promoteMemoryTopic(topic.id);
                        return `已把「${topic.topic}」加入兴趣记忆`;
                      })()
                    }
                  >
                    成为兴趣
                  </button>
                  <button
                    className="text-warm hover:underline disabled:opacity-60"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        if (!window.confirm(`不再追踪「${topic.topic}」？此后不会再自动计数或晋升。`)) throw new Error("已取消");
                        await api2.forgetMemoryTopic(topic.id);
                        return "已不再追踪";
                      })()
                    }
                  >
                    不再追踪
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 添加弹层 */}
      {adding && (
        <section className="mb-4 space-y-2 rounded-xl border border-accent bg-surface p-4">
          <div className="text-sm font-semibold text-ink">手动记一条</div>
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              value={addForm.kind}
              onChange={(e) => setAddForm({ ...addForm, kind: e.target.value })}
            >
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              placeholder="主题（可选，如「在用的数据库」）"
              value={addForm.topic}
              onChange={(e) => setAddForm({ ...addForm, topic: e.target.value })}
            />
            <select
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              value={addForm.importance}
              onChange={(e) => setAddForm({ ...addForm, importance: Number(e.target.value) })}
            >
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  重要性 {n}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="min-h-20 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
            placeholder="一句话内容（≤300 字）"
            value={addForm.content}
            onChange={(e) => setAddForm({ ...addForm, content: e.target.value })}
          />
          <div className="flex justify-end gap-2 text-sm">
            <button className="text-ink3" onClick={() => setAdding(false)}>
              取消
            </button>
            <button
              className="text-accent disabled:opacity-60"
              disabled={busy || addForm.content.trim() === ""}
              onClick={() =>
                void act(async () => {
                  await api2.addMemoryItem(addForm);
                  setAdding(false);
                  return "已添加";
                })()
              }
            >
              保存
            </button>
          </div>
        </section>
      )}

      {/* 状态标签栏 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            className={`rounded-full border px-3 py-1 text-[13px] transition ${status === tab.key ? "border-accent bg-accent3 text-accent" : "border-line text-ink3 hover:text-ink"}`}
            onClick={() => setStatus(tab.key)}
          >
            {tab.icon} {tab.label} {counts[tab.key] ?? 0}
          </button>
        ))}
        <select
          className="ml-auto rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-ink3"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {KIND_TABS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* 条目列表 */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface px-4 py-12 text-center">
          <p className="text-sm font-medium text-ink">还没有记忆</p>
          <p className="mt-1 text-xs text-ink3">和伙伴聊天时多说说自己，记忆会自动积累；也可以点右上角「添加」手动记一条。</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={`rounded-xl border bg-surface p-3 ${item.status === "pending" ? "border-warm/50" : "border-line"}`}
            >
              {editing?.id === item.id ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
                      placeholder="主题（可选）"
                      value={editing.topic}
                      onChange={(e) => setEditing({ ...editing, topic: e.target.value })}
                    />
                    <select
                      className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
                      value={editing.importance}
                      onChange={(e) => setEditing({ ...editing, importance: Number(e.target.value) })}
                    >
                      {[5, 4, 3, 2, 1].map((n) => (
                        <option key={n} value={n}>
                          重要性 {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    className="min-h-16 w-full rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
                    value={editing.content}
                    onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                  />
                  <div className="flex justify-end gap-2 text-sm">
                    <button className="text-ink3" onClick={() => setEditing(null)}>
                      取消
                    </button>
                    <button
                      className="text-accent disabled:opacity-60"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api2.editMemoryItem(item.id, editing);
                          setEditing(null);
                          return "已保存（此后后台不再覆盖这条）";
                        })()
                      }
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="text-[15px] leading-relaxed text-ink">{item.content}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink3">
                    <span className="rounded-full border border-line px-1.5 py-0.5">{KIND_LABEL[item.kind] ?? item.kind}</span>
                    {item.topic !== "" && <span className="rounded-full bg-accent3 px-1.5 py-0.5 text-accent">{item.topic}</span>}
                    <span>{"●".repeat(item.importance)}{"○".repeat(5 - item.importance)}</span>
                    <span>{ORIGIN_LABEL[item.origin] ?? item.origin}</span>
                    <span>{fmtTime(item.validFrom)}</span>
                    {item.status === "pending" && <span className="font-medium text-warm">待你确认</span>}
                    {item.status === "superseded" && <span>已被更新于 {item.invalidAt ? fmtTime(item.invalidAt) : "—"}</span>}
                    {item.status === "archived" && <span>已归档</span>}
                    <span className="ml-auto flex gap-2">
                      {item.status === "pending" && (
                        <>
                          <button
                            className="text-accent hover:underline disabled:opacity-60"
                            disabled={busy}
                            onClick={() => void act(async () => {
                              await api2.confirmMemoryItem(item.id);
                              return "已确认，开始生效";
                            })()}
                          >
                            确认
                          </button>
                          <button
                            className="text-warm hover:underline disabled:opacity-60"
                            disabled={busy}
                            onClick={() => void act(async () => {
                              await api2.rejectMemoryItem(item.id);
                              return "已拒绝（不会再学回来）";
                            })()}
                          >
                            拒绝
                          </button>
                        </>
                      )}
                      {(item.status === "active" || item.status === "pending") && (
                        <>
                          <button
                            className="hover:text-accent hover:underline"
                            onClick={() => setEditing({ id: item.id, content: item.content, importance: item.importance, topic: item.topic })}
                          >
                            编辑
                          </button>
                          <button className="text-warm hover:underline" disabled={busy} onClick={() => removeItem(item.id)}>
                            删除
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        对话中自动注入：画像、偏好与兴趣常驻，事实与任务按当前话题临时召回（配置了语义召回提供方时，字面不同的说法也能召回）。
        每轮对话后约 90 秒后台自动提取，每晚自动整理（合并重复、过期归档、补算向量）。
        {ov?.meta.lastExtractTs ? ` 上次提取 ${fmtTime(ov.meta.lastExtractTs)}${nextExtract}。` : ""}
        删除的记忆不会再被后台学回来；你手动编辑过的条目后台也不会覆盖。
      </p>
    </div>
  );
}
