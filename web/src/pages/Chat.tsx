import { useCallback, useEffect, useRef, useState } from "react";
import { api, api2, openConversationStream, type AgentLoose, type ConversationEntry, type ConversationMetaLoose, type LiveEventLoose, type SessionEventLoose } from "../api";

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

export function Chat() {
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<RenderItem[]>([]);
  // 流式中的增量（turn 结束后以日志为准清空）
  const [stream, setStream] = useState<{ reasoning: string; text: string } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showReasoning, setShowReasoning] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const agentName = useCallback(
    (id: string): string => agents.find((a) => a.id === id)?.name ?? "新伙伴",
    [agents],
  );

  const reloadConversations = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    return list;
  }, []);

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

  useEffect(() => {
    void (async () => {
      let list = await reloadConversations();
      if (list.length === 0) {
        await api.createConversation();
        list = await reloadConversations();
      }
      if (list[0]) setActiveId(list[0].id);
    })().catch(() => setBanner("加载会话失败"));
  }, [reloadConversations]);

  useEffect(() => {
    if (!activeId) return;
    void loadEvents(activeId).catch(() => undefined);
    const close = openConversationStream(activeId, (event: LiveEventLoose) => {
      if (activeIdRef.current !== activeId) return;
      if (event.type === "reasoning-delta") {
        setStream((s) => ({ reasoning: (s?.reasoning ?? "") + (event.text ?? ""), text: s?.text ?? "" }));
      } else if (event.type === "text-delta") {
        setStream((s) => ({ reasoning: s?.reasoning ?? "", text: (s?.text ?? "") + (event.text ?? "") }));
      } else if (event.type === "assistant") {
        // 最终消息以日志为准，先把增量清掉；turn-end 时统一重放
        setStream(null);
      } else if (event.type === "turn-end" || event.type === "error" || event.type === "budget-exhausted") {
        setStream(null);
        if (event.type === "error" && event.error === "model_not_configured") {
          setBanner("还没有配置模型——去「设置」页填 baseURL / API Key / 模型");
        } else {
          setBanner(null);
          void loadEvents(activeId).catch(() => undefined);
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
  }, [activeId, loadEvents]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, stream]);

  const send = async () => {
    const text = input.trim();
    if (!text || !activeId) return;
    setInput("");
    setItems((prev) => [...prev, { kind: "user", key: `local-${Date.now()}`, text }]);
    try {
      await api.sendMessage(activeId, text);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) setBanner("还没有配置模型——去「设置」页填 baseURL / API Key / 模型");
      else setBanner(`发送失败：${(e as Error).message}`);
    }
  };

  const newConversation = async () => {
    const entry = await api.createConversation();
    await reloadConversations();
    setActiveId(entry.id);
    setItems([]);
  };

  return (
    <div className="chat-layout">
      <aside className="conv-list">
        <button className="btn ghost small" style={{ width: "100%", marginBottom: 8 }} onClick={newConversation}>
          ＋ 新对话
        </button>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`conv-item${conv.id === activeId ? " active" : ""}`}
            onClick={() => setActiveId(conv.id)}
          >
            <div className="t">{conv.title}</div>
          </div>
        ))}
      </aside>

      <main className="chat-main">
        {banner && (
          <div className="banner" style={{ marginTop: 10 }}>
            {banner}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
          <span className="muted">当前伙伴</span>
          <select
            className="input"
            style={{ width: "auto", padding: "4px 10px" }}
            value={currentAgentId ?? ""}
            onChange={async (e) => {
              const value = e.target.value;
              if (!activeId) return;
              try {
                if (value === "") {
                  // 切回默认助手：后端 meta.agentId 置空语义暂以"新建默认会话代替"——直接不处理
                  return;
                }
                await api2.switchAgent(activeId, value);
                setCurrentAgentId(value);
                await loadEvents(activeId);
              } catch (err) {
                setBanner(`切换失败：${(err as Error).message}`);
              }
            }}
          >
            <option value="">默认助手</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            切换后下一条消息由新伙伴接话，历史不丢
          </span>
        </div>
        <div className="chat-scroll" ref={scrollRef}>
          {items.map((item) =>
            item.kind === "switch" ? (
              <div key={item.key} style={{ alignSelf: "center", fontSize: 12, color: "var(--ink-3)", borderTop: "1px dashed var(--line)", paddingTop: 6, width: "100%", textAlign: "center" }}>
                {item.label}
              </div>
            ) : item.kind === "user" ? (
              <div key={item.key} className="bubble-user">
                {item.text}
              </div>
            ) : item.kind === "assistant" ? (
              <div key={item.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {showReasoning && item.reasoning !== "" && (
                  <details className="reasoning">
                    <summary>思考过程</summary>
                    <div className="body">{item.reasoning}</div>
                  </details>
                )}
                <div className="bubble-assistant">{item.text}</div>
              </div>
            ) : (
              <div key={item.key} className="receipt">
                <span className={item.ok ? "ok" : "err"}>{item.ok ? "✓" : "✕"}</span>
                <span>{item.name}</span>
                <span style={{ opacity: 0.8 }}>{item.text}</span>
              </div>
            ),
          )}

          {stream && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {stream.reasoning !== "" && (
                <details className="reasoning" open>
                  <summary>思考中…</summary>
                  <div className="body">{stream.reasoning}</div>
                </details>
              )}
              {stream.text !== "" && <div className="bubble-assistant">{stream.text}</div>}
            </div>
          )}
        </div>

        <div className="chat-input">
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}>
            <input type="checkbox" checked={showReasoning} onChange={(e) => setShowReasoning(e.target.checked)} />
            思维链
          </label>
          <textarea
            className="input"
            rows={1}
            placeholder="说点什么，或随手记一笔…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn" onClick={send}>
            发送
          </button>
        </div>
      </main>
    </div>
  );
}
