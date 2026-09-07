import { useCallback, useEffect, useState } from "react";
import { api2, type L1DetailLoose, type L2EntryLoose, type MemoryOverviewLoose } from "../api";

const SURFACE_HINT: Record<string, string> = { chat: "对话会话快照", ledger: "流水/计划/打卡", tasks: "提醒任务" };
const SLOT_LABEL: Record<string, string> = { recent: "近期动态", profile: "画像", scope: "当前主线", preferences: "偏好" };

function pendingText(p: { added: number; modified: number; removed: number }): string {
  const parts: string[] = [];
  if (p.added > 0) parts.push(`+${p.added} 新`);
  if (p.modified > 0) parts.push(`~${p.modified} 改`);
  if (p.removed > 0) parts.push(`-${p.removed} 删`);
  return parts.join(" · ");
}

/** 长期记忆页（三层，对齐 DeepTutor）：L1 工作区镜像 → L2 模块事实 → L3 跨模块知识；注入对话的只有 L3。 */
export function Memory() {
  const [ov, setOv] = useState<MemoryOverviewLoose | null>(null);
  const [expand, setExpand] = useState<"l1" | "l2" | "l3" | null>(null);
  const [l1, setL1] = useState<Record<string, L1DetailLoose | undefined>>({});
  const [l2, setL2] = useState<Record<string, L2EntryLoose[] | undefined>>({});
  const [openSurface, setOpenSurface] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setOv(await api2.getMemory());
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const fetchLayer = (layer: "l1" | "l2") => {
    const surfaces = layer === "l1" ? (ov?.l1.surfaces ?? []) : (ov?.l2.surfaces ?? []);
    for (const s of surfaces) {
      if (layer === "l1") void api2.listL1(s.key).then((d) => setL1((p) => ({ ...p, [s.key]: d }))).catch(() => undefined);
      else void api2.listL2(s.key).then((d) => setL2((p) => ({ ...p, [s.key]: d.entries }))).catch(() => undefined);
    }
  };
  const toggle = (layer: "l1" | "l2" | "l3") => {
    const next = expand === layer ? null : layer;
    setExpand(next);
    if (next) fetchLayer(next as "l1" | "l2");
  };

  const runAll = async () => {
    setBusy(true);
    setMessage("全链跑批中：L1 记录变化 → L2 抽事实 → L3 综合（用你配置的模型）…");
    try {
      const r = await api2.runMemory();
      const facts = r.l2.chat.added + r.l2.ledger.added + r.l2.tasks.added;
      const changed = [r.l3.recent, r.l3.profile, r.l3.scope].filter((x) => x.changed).length;
      setMessage(`完成：L1 新增 ${r.l1.chat.added + r.l1.ledger.added + r.l1.tasks.added} 实体，L2 新增 ${facts} 条事实，L3 更新 ${changed} 个槽`);
      await reload();
      if (expand === "l1" || expand === "l2") fetchLayer(expand);
    } catch (e) {
      setMessage(`跑批失败：${(e as Error).message === "model_not_configured" ? "先去「模型接入」页配置模型" : (e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshSurface = async (key: string) => {
    setBusy(true);
    try {
      const r = await api2.refreshL1(key);
      setMessage(`${key} 镜像已更新：+${r.added} 新 / ~${r.modified} 改 / -${r.removed} 删`);
      setL1({ ...l1, [key]: await api2.listL1(key) });
      await reload();
    } catch (e) {
      setMessage(`更新失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const updateSurface = async (key: string) => {
    setBusy(true);
    try {
      const r = await api2.updateL2(key);
      setMessage(
        r.skipped === "no_new_input"
          ? `${key}：没有新实体可抽取`
          : r.skipped === "bad_output"
            ? `${key}：模型输出无法解析（未落盘，可重试）`
            : r.skipped === "no_valid_facts"
              ? `${key}：模型输出的事实都没带有效出处（未落盘，可重试或换模型）`
              : `${key}：新增 ${r.added} 条事实`,
      );
      setL2({ ...l2, [key]: (await api2.listL2(key)).entries });
      await reload();
    } catch (e) {
      setMessage(`抽取失败：${(e as Error).message === "model_not_configured" ? "先去「模型接入」页配置模型" : (e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const updateSlot = async (key: string) => {
    setBusy(true);
    try {
      const r = await api2.updateL3(key);
      setMessage(r.changed ? `${SLOT_LABEL[key]}：综合完成` : r.skipped === "no_new_input" ? `${SLOT_LABEL[key]}：没有新的 L2 事实可综合` : `${SLOT_LABEL[key]}：模型输出为空（未落盘）`);
      await reload();
    } catch (e) {
      setMessage(`综合失败：${(e as Error).message === "model_not_configured" ? "先去「模型接入」页配置模型" : (e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const [editingEntry, setEditingEntry] = useState<{ surface: string; id: string } | null>(null);
  const [entryText, setEntryText] = useState("");
  const saveEntry = async () => {
    if (!editingEntry) return;
    setBusy(true);
    try {
      await api2.editL2Entry(editingEntry.surface, editingEntry.id, { text: entryText });
      setL2({ ...l2, [editingEntry.surface]: (await api2.listL2(editingEntry.surface)).entries });
      setEditingEntry(null);
      await reload();
    } catch (e) {
      setMessage(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (surface: string, id: string) => {
    if (!window.confirm("删除这条事实？（L3 下次综合不再引用它）")) return;
    await api2.removeL2Entry(surface, id);
    setL2({ ...l2, [surface]: (await api2.listL2(surface)).entries });
    await reload();
  };

  if (!ov) return <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-ink3">加载中…</div>;
  const l1Total = ov.l1.surfaces.reduce((n, s) => n + s.live, 0);
  const l2Total = ov.l2.surfaces.reduce((n, s) => n + s.entries, 0);
  const l3Bullets = ov.l3.slots.reduce((n, s) => n + s.bullets, 0);

  const card = (layer: "l1" | "l2" | "l3", icon: string, tag: string, title: string, count: React.ReactNode, desc: string) => (
    <button
      className={`flex-1 rounded-xl border bg-surface p-4 text-left transition ${expand === layer ? "border-accent" : "border-line hover:border-accent"}`}
      onClick={() => toggle(layer)}
    >
      <div className="flex items-center justify-between">
        <span className="text-base">{icon}</span>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink3">{tag}</span>
      </div>
      <div className="mt-3 text-[15px] font-semibold text-ink">{title}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{count}</div>
      <p className="mt-2 text-xs leading-relaxed text-ink3">{desc}</p>
    </button>
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">🧠 关于你的全部记忆，分为三层组织</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">记忆</h1>
        </div>
        <button
          className="rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-ink2 transition hover:text-ink disabled:opacity-60"
          disabled={busy}
          onClick={() => void runAll()}
        >
          ⟳ 全链跑批
        </button>
      </header>
      {message && <p className="mb-4 text-sm text-ink3">{message}</p>}
      {ov.meta.lastRunTs && (
        <p className="mb-4 text-xs text-ink3">
          上次全链 {new Date(ov.meta.lastRunTs).toLocaleString()} · 累计 {ov.meta.runs} 次 · 只有 L3 注入对话（溯源脚注自动剥离），L1/L2 供你查看与策展
        </p>
      )}

      {/* 三层卡 */}
      <div className="flex gap-3">
        {card(
          "l1",
          "🗂",
          "实时",
          "L1 · 工作区镜像",
          <>{l1Total} <span className="text-sm font-normal text-ink3">条实体 · 共 {ov.l1.surfaces.length} 个 surface</span></>,
          "对话 / 账本 / 提醒的实时快照。「全链跑批」或单表「记录变化」会把增删改写进变更日志。",
        )}
        {card(
          "l2",
          "📌",
          "整理后",
          "L2 · 各模块摘要",
          <>{l2Total} <span className="text-sm font-normal text-ink3">条事实 · 共 {ov.l2.surfaces.length} 个 surface</span></>,
          "由模型从 L1 新实体抽取的事实，每条都带出处引用；支持更新 / 编辑 / 删除。",
        )}
        {card(
          "l3",
          "🧩",
          "综合",
          "L3 · 跨模块知识",
          <>{l3Bullets} <span className="text-sm font-normal text-ink3">条命题 · 共 {ov.l3.slots.length + 1} 个 slot</span></>,
          "跨 surface 综合：近期动态、画像、当前主线。每条判断都有 L2 证据（脚注）。",
        )}
      </div>

      {/* L1 面板 */}
      {expand === "l1" && (
        <section className="mt-4 space-y-2 rounded-xl border border-line bg-surface p-4">
          <div className="text-sm font-semibold text-ink">L1 · 工作区镜像</div>
          {ov.l1.surfaces.map((s) => {
            const detail = l1[s.key];
            const pending = pendingText(s.pending);
            return (
              <div key={s.key} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpenSurface(openSurface === s.key ? null : s.key)}>
                    <span className="text-[15px] font-medium text-ink">{s.label}</span>
                    <span className="ml-2 text-xs text-ink3">{s.live} 条 · {SURFACE_HINT[s.key]}</span>
                    {pending && <span className="ml-2 rounded-full bg-accent3 px-2 py-0.5 text-[11px] text-accent">{pending}</span>}
                  </button>
                  <button className="shrink-0 text-xs text-accent hover:underline disabled:opacity-60" disabled={busy} onClick={() => void refreshSurface(s.key)}>
                    记录变化
                  </button>
                </div>
                {openSurface === s.key && detail && (
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    {detail.entities.length === 0 && <p className="text-xs text-ink3">（空）</p>}
                    {detail.entities.slice(-20).reverse().map((e) => (
                      <div key={e.ref} className="flex items-baseline gap-2 text-xs">
                        <span className="shrink-0 text-ink3">{new Date(e.ts).toLocaleDateString()}</span>
                        <span className="truncate text-ink">{e.label}</span>
                        <span className="shrink-0 font-mono text-[10px] text-ink3">{e.ref}</span>
                      </div>
                    ))}
                    {detail.changes.length > 0 && (
                      <p className="pt-1 text-[11px] text-ink3">最近变更：{detail.changes.slice(0, 5).map((c) => `${c.kind === "added" ? "+" : c.kind === "modified" ? "~" : "-"} ${c.label || c.ref}`).join(" · ")}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* L2 面板 */}
      {expand === "l2" && (
        <section className="mt-4 space-y-2 rounded-xl border border-line bg-surface p-4">
          <div className="text-sm font-semibold text-ink">L2 · 各模块摘要（每条事实都有 L1 出处）</div>
          {ov.l2.surfaces.map((s) => {
            const entries = l2[s.key];
            const sections = [...new Set((entries ?? []).map((e) => e.section))];
            return (
              <div key={s.key} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpenSurface(openSurface === s.key ? null : s.key)}>
                    <span className="text-[15px] font-medium text-ink">{s.label}</span>
                    <span className="ml-2 text-xs text-ink3">{s.entries} 条事实</span>
                  </button>
                  <button className="shrink-0 text-xs text-accent hover:underline disabled:opacity-60" disabled={busy} onClick={() => void updateSurface(s.key)}>
                    更新
                  </button>
                </div>
                {openSurface === s.key && entries && (
                  <div className="mt-2 space-y-2 border-t border-line pt-2">
                    {entries.length === 0 && <p className="text-xs text-ink3">（还没有事实——点「更新」从 L1 抽取）</p>}
                    {sections.map((sec) => (
                      <div key={sec}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-ink3">{sec}</div>
                        {entries.filter((e) => e.section === sec).map((e) => (
                          <div key={e.id} className="group flex items-baseline gap-2 py-0.5 text-sm text-ink">
                            <span className="text-ink3">·</span>
                            {editingEntry?.id === e.id ? (
                              <span className="flex min-w-0 flex-1 items-center gap-2">
                                <input
                                  className="min-w-0 flex-1 rounded border border-accent bg-surface px-2 py-1 text-sm text-ink outline-none"
                                  value={entryText}
                                  onChange={(ev) => setEntryText(ev.target.value)}
                                  onKeyDown={(ev) => ev.key === "Enter" && void saveEntry()}
                                />
                                <button className="shrink-0 text-[11px] text-accent" disabled={busy} onClick={() => void saveEntry()}>
                                  保存
                                </button>
                                <button className="shrink-0 text-[11px] text-ink3" onClick={() => setEditingEntry(null)}>
                                  取消
                                </button>
                              </span>
                            ) : (
                              <>
                                <span
                                  className="min-w-0 flex-1 cursor-text transition hover:text-accent"
                                  title="点击编辑"
                                  onClick={() => {
                                    setEditingEntry({ surface: s.key, id: e.id });
                                    setEntryText(e.text);
                                  }}
                                >
                                  {e.text}
                                </span>
                                <span className="hidden shrink-0 font-mono text-[10px] text-ink3 group-hover:inline">{e.refs.join(" ")}</span>
                                <button className="shrink-0 text-[11px] text-warm opacity-0 transition group-hover:opacity-100" onClick={() => void removeEntry(s.key, e.id)}>
                                  删除
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* L3 面板 */}
      {expand === "l3" && (
        <section className="mt-4 space-y-2 rounded-xl border border-line bg-surface p-4">
          <div className="text-sm font-semibold text-ink">L3 · 跨模块知识（注入对话的层）</div>
          {ov.l3.slots.map((s) => (
            <div key={s.key} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[15px] font-medium text-ink">{SLOT_LABEL[s.key]}</span>
                  <span className="ml-2 text-xs text-ink3">{s.bullets} 条命题</span>
                  {s.hasNew && <span className="ml-2 rounded-full bg-accent3 px-2 py-0.5 text-[11px] text-accent">有新 L2 证据</span>}
                </div>
                <button className="shrink-0 text-xs text-accent hover:underline disabled:opacity-60" disabled={busy} onClick={() => void updateSlot(s.key)}>
                  综合
                </button>
              </div>
              {(ov.slots[s.key] ?? "").trim() !== "" && (
                <ul className="mt-1.5 space-y-1">
                  {(ov.slots[s.key] ?? "").split("\n").filter((l) => l.trim() !== "" && !/^\[\^\d+\]/.test(l)).map((line, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink">
                      <span className="text-ink3">·</span>
                      <span>{line.replace(/\[\^\d+\]/g, "")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div className="rounded-lg border border-line p-3">
            <span className="text-[15px] font-medium text-ink">{SLOT_LABEL.preferences}</span>
            <span className="ml-2 text-xs text-ink3">{ov.l3.preferences.bullets} 条 · 工具直写，永不自动综合</span>
            <ul className="mt-1.5 space-y-1">
              {(ov.slots.preferences ?? "").split("\n").filter((l) => l.trim() !== "").map((line, i) => (
                <li key={i} className="flex gap-2 text-sm text-ink">
                  <span className="text-ink3">·</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        流转链路：L1（实时可见）→「更新」→ L2 模块事实 →「综合」→ L3 跨模块知识。「全链跑批」一次走完；每天凌晨 2–5 点自动全链维护一次（服务常驻也生效），启动时距上次超 20 小时会补跑。
        偏好槽只能由对话中的 save_preference 工具写入。原始层不用维护：记忆永远可从会话/账本/任务重建。
      </p>
    </div>
  );
}
