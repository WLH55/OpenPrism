import { useCallback, useEffect, useRef, useState } from "react";
import { api, api2, openConversationStream, type AgentLoose, type ConversationEntry, type ConversationMetaLoose, type LiveEventLoose, type SessionEventLoose } from "../api";
import { CheckSolidIcon, ChevronDownIcon, SwitchPartnerIcon } from "../icons";

/** 渲染项：从会话日志事件折叠出的 UI 气泡/回执/切换分割线 */
type RenderItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; reasoning: string }
  | { kind: "receipt"; key: string; name: string; ok: boolean; text: string }
  | { kind: "switch"; key: string; label: string };

function foldEvents(events: SessionEventLoose[], switches: { ts: number; agentId: string }[] = [], agentName: (id: string) => string): RenderItem[] {
  const items: RenderItem[] = [];
  for (const event of events) {
    // 切换分割线：插到第一条晚于切换时刻的事件前（D4.2 消息归属可视）
    for (const sw of switches) {
      if ((event.ts ?? 0) >= sw.ts && !items.some((i) => i.kind === "switch" && i.key === `sw-${sw.ts}`)) {
        items.push({ kind: "switch", key: `sw-${sw.ts}`, label: `${agentName(sw.agentId)} 加入对话` });
      }
    }
    if (event.type === "user/message") {
      const text = (event.message?.content ?? []).map((b) => b.text ?? "").join("");
      items.push({ kind: "user", key: `u${event.seq}`, text });
    } else if (event.type === "assistant/message") {
      const text = (event.message?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      items.push({
        kind: "assistant",
        key: `a${event.seq}`,
        text: text || "…",
        reasoning: event.message?.reasoning ?? "",
      });
    } else if (event.type === "tool/call") {
      items.push({ kind: "receipt", key: `t${event.id}`, name: event.name ?? "?", ok: true, text: "执行中…" });
    } else if (event.type === "tool/result") {
      const pending = [...items].reverse().find((i) => i.kind === "receipt" && i.key === `t${event.id}`);
      if (pending && pending.kind === "receipt") {
        pending.ok = !event.isError;
        pending.text = (event.content ?? []).map((b) => b.text ?? "").join("") || (event.isError ? "失败" : "完成");
      }
    }
  }
  return items;
}

export function Chat({
  conversations,
  reloadConversations,
  activeConvId,
  setActiveConvId,
}: {
  conversations: ConversationEntry[];
  reloadConversations: () => Promise<ConversationEntry[]>;
  activeConvId: string | null;
  setActiveConvId: (id: string | null) => void;
}) {
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<RenderItem[]>([]);
  // 流式中的增量（turn 结束后以日志为准清空）
  const [stream, setStream] = useState<{ reasoning: string; text: string } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showReasoning, setShowReasoning] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeConvId;

  const agentName = useCallback(
    (id: string): string => agents.find((a) => a.id === id)?.name ?? "新伙伴",
    [agents],
  );
  const currentAgent = agents.find((a) => a.id === currentAgentId);

  const loadEvents = useCallback(
    async (cid: string) => {
      const [events, meta] = await Promise.all([api.conversationEvents(cid), api2.convMeta(cid).catch(() => ({ switches: [] as { ts: number; agentId: string }[] }) as ConversationMetaLoose)]);
      setItems(foldEvents(events, meta.switches, agentName));
      setCurrentAgentId(meta.agentId);
    },
    [agentName],
  );

  useEffect(() => {
    void api2
      .listAgents()
      .then(setAgents)
      .catch(() => undefined);
  }, []);

  // 会话的确保与选中在壳子完成；此处只订阅当前会话
  useEffect(() => {
    if (!activeConvId) return;
    void loadEvents(activeConvId).catch(() => undefined);
    const close = openConversationStream(activeConvId, (event: LiveEventLoose) => {
      if (activeIdRef.current !== activeConvId) return;
      if (event.type === "reasoning-delta") {
        setStream((s) => ({ reasoning: (s?.reasoning ?? "") + (event.text ?? ""), text: s?.text ?? "" }));
      } else if (event.type === "text-delta") {
        setStream((s) => ({ reasoning: (s?.reasoning ?? ""), text: (s?.text ?? "") + (event.text ?? "") }));
      } else if (event.type === "assistant") {
        // 最终消息以日志为准，先把增量清掉；turn-end 时统一重放
        setStream(null);
      } else if (event.type === "turn-end" || event.type === "error" || event.type === "budget-exhausted") {
        setStream(null);
        if (event.type === "error" && event.error === "model_not_configured") {
          setBanner("还没有配置模型——去左下角菜单「模型接入」填 baseURL / API Key / 模型");
        } else {
          setBanner(null);
          void loadEvents(activeConvId).catch(() => undefined);
        }
      } else if (event.type === "tool-call") {
        setItems((prev) => [
          ...prev,
          { kind: "receipt", key: `live-${event.id}`, name: event.name ?? "?", ok: true, text: "执行中…" },
        ]);
      } else if (event.type === "tool-result") {
        setItems((prev) =>
          prev.map((item) =>
            item.kind === "receipt" && (item.key === `live-${event.id}` || item.key === `t${event.id}`)
              ? {
                  ...item,
                  ok: !event.isError,
                  text: (event.content ?? []).map((b) => b.text ?? "").join("") || (event.isError ? "失败" : "完成"),
                }
              : item,
          ),
        );
      }
    });
    return close;
  }, [activeConvId, loadEvents]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, stream]);

  // 点外部收起伙伴下拉
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || !activeConvId) return;
    setInput("");
    setItems((prev) => [...prev, { kind: "user", key: `local-${Date.now()}`, text }]);
    try {
      await api.sendMessage(activeConvId, text);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) setBanner("还没有配置模型——去左下角菜单「模型接入」填 baseURL / API Key / 模型");
      else setBanner(`发送失败：${(e as Error).message}`);
    }
  };

  const pickPartner = async (id: string) => {
    setPickerOpen(false);
    if (!activeConvId || id === (currentAgentId ?? "")) return;
    if (id === "") {
      // 切回默认助手：后端 meta.agentId 置空语义暂缺——与旧实现一致 no-op
      setBanner("会话中途切回默认助手暂不支持——请新建一个对话");
      return;
    }
    try {
      await api2.switchAgent(activeConvId, id);
      setCurrentAgentId(id);
      await loadEvents(activeConvId);
    } catch (err) {
      setBanner(`切换失败：${(err as Error).message}`);
    }
  };

  const partnerAvatar = (name: string, warm = false) => (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${warm ? "bg-warm2 text-warm" : "bg-accent3 text-accent"}`}>
      {name.slice(0, 1)}
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-surface">
      {/* 聊天主区（会话列表在壳子左侧栏） */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 头部：当前伙伴 + 思维链开关 + 切换伙伴 */}
        <header className="relative flex items-center justify-between border-b border-line px-4 py-3" ref={headerRef}>
          <button
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-surface2"
            onClick={(e) => { e.stopPropagation(); setPickerOpen(!pickerOpen); }}
          >
            {partnerAvatar(currentAgent?.name ?? "助")}
            <div className="text-left">
              <div className="flex items-center gap-1 text-sm font-semibold text-ink">
                <span>{currentAgent?.name ?? "默认助手"}</span>
                <ChevronDownIcon className="h-3.5 w-3.5 text-ink3" />
              </div>
              <div className="text-xs text-ink3">陪你谈心 · 也盯着你进步</div>
            </div>
          </button>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink2">
              <span>思维链</span>
              <span className="relative inline-block h-5 w-9">
                <input type="checkbox" className="peer sr-only" checked={showReasoning} onChange={(e) => setShowReasoning(e.target.checked)} />
                <span className="absolute inset-0 rounded-full bg-ink3/40 transition peer-checked:bg-accent2" />
                <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition peer-checked:translate-x-4" />
              </span>
            </label>
            <button
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-surface2"
              onClick={(e) => { e.stopPropagation(); setPickerOpen(!pickerOpen); }}
            >
              <SwitchPartnerIcon className="h-4 w-4 text-ink2" />
              切换伙伴
            </button>
          </div>

          {/* 伙伴切换下拉 */}
          {pickerOpen && (
            <div className="absolute right-4 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <div className="px-3 py-2.5 text-xs text-ink3">切换伙伴</div>
              <button
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface2"
                onClick={() => void pickPartner("")}
              >
                {partnerAvatar("助")}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">默认助手</span>
                  <span className="block text-xs text-ink3">不带人设的基线伙伴</span>
                </span>
                {!currentAgentId && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
              </button>
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface2"
                  onClick={() => void pickPartner(agent.id)}
                >
                  {partnerAvatar(agent.name, true)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{agent.name}</span>
                    <span className="block text-xs text-ink3">自定义伙伴</span>
                  </span>
                  {currentAgentId === agent.id && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                </button>
              ))}
            </div>
          )}
        </header>

        {banner && (
          <div className="bg-warm2 px-4 py-2 text-sm text-warm">{banner}</div>
        )}

        {/* 消息流 */}
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5" ref={scrollRef}>
          {items.map((item) =>
            item.kind === "switch" ? (
              <div key={item.key} className="flex items-center gap-3 text-xs text-ink3">
                <span className="h-px flex-1 bg-line" />
                {item.label}
                <span className="h-px flex-1 bg-line" />
              </div>
            ) : item.kind === "user" ? (
              <div key={item.key} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-accent2 px-4 py-3 text-[15px] leading-relaxed text-white">
                  {item.text}
                </div>
              </div>
            ) : item.kind === "assistant" ? (
              <div key={item.key} className="flex max-w-[85%] flex-col gap-1.5">
                {showReasoning && item.reasoning !== "" && (
                  <details className="group">
                    <summary className="cursor-pointer list-none text-xs text-ink3 transition hover:text-ink">思考过程 · 点击展开</summary>
                    <div className="mt-1.5 rounded-lg border-l-2 border-accent bg-accent3/60 px-3 py-2 text-xs leading-relaxed text-ink2">
                      {item.reasoning}
                    </div>
                  </details>
                )}
                <div className="whitespace-pre-wrap rounded-2xl rounded-tl-md bg-surface2 px-4 py-3 text-[15px] leading-relaxed text-ink">
                  {item.text}
                </div>
              </div>
            ) : (
              <div key={item.key} className="flex gap-2.5">
                <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${item.ok ? "bg-accent3 text-accent" : "bg-warm2 text-warm"}`}>
                  {item.ok ? <CheckSolidIcon className="h-4 w-4" /> : <span className="text-xs font-bold">✕</span>}
                </div>
                <div className="rounded-xl border border-line bg-accent3/50 px-3 py-2 text-sm">
                  <div className="font-medium text-ink">{item.name}</div>
                  <div className="text-ink2">{item.text}</div>
                </div>
              </div>
            ),
          )}

          {stream && (
            <div className="flex max-w-[85%] flex-col gap-1.5">
              {stream.reasoning !== "" && (
                <details open className="group">
                  <summary className="cursor-pointer list-none text-xs text-ink3">思考中…</summary>
                  <div className="mt-1.5 rounded-lg border-l-2 border-accent bg-accent3/60 px-3 py-2 text-xs leading-relaxed text-ink2">
                    {stream.reasoning}
                  </div>
                </details>
              )}
              {stream.text !== "" && (
                <div className="rounded-2xl rounded-tl-md bg-surface2 px-4 py-3 text-[15px] leading-relaxed text-ink">{stream.text}</div>
              )}
            </div>
          )}
        </div>

        {/* 输入区 */}
        <footer className="border-t border-line px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              rows={1}
              placeholder="说点什么，或随手记一笔…"
              className="max-h-32 flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="rounded-xl bg-accent2 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
              onClick={() => void send()}
            >
              发送
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}
