import { useCallback, useEffect, useRef, useState } from "react";
import { api, api3, type ConversationEntry } from "./api";
import { Login } from "./pages/Login";
import { Chat } from "./pages/Chat";
import { Today } from "./pages/Today";
import { Settings } from "./pages/Settings";
import { Agents, AgentEdit } from "./pages/Agents";
import { Skills } from "./pages/Skills";
import { Memory } from "./pages/Memory";
import { Tasks } from "./pages/Tasks";
import { Panels } from "./pages/Panels";
import { Progress } from "./pages/Progress";
import { NotifyChannels } from "./pages/NotifyChannels";
import {
  AgentsIcon, CategoryIcon, ChatIcon, ChevronDownIcon, LogoutIcon, MemoryIcon,
  ModelIcon, MoonIcon, NotifyIcon, Prism, ProgressIcon, SkillsIcon, SunIcon, TaskIcon, TodayIcon,
} from "./icons";

export type View =
  | "chat" | "today" | "category" | "progress"
  | "agents" | "agent-edit" | "task" | "skills" | "memory" | "model" | "notify";

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("op-theme", next);
  } catch {
    /* 无 localStorage 也无妨 */
  }
}

/** 应用壳：左侧纵向菜单（品牌 / 主导航 / 最近对话 / 头像下拉）+ 内容区，结构照 prototype */
function Shell({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [view, setView] = useState<View>("chat");
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [convQuery, setConvQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  const reloadConversations = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    return list;
  }, []);

  useEffect(() => {
    // 确保至少一个会话并选中最近——集中在壳子做，避免页面各自挂载时竞态建空会话
    void (async () => {
      let list = await api.listConversations();
      if (list.length === 0) {
        await api.createConversation();
        list = await api.listConversations();
      }
      setConversations(list);
      setActiveConvId((cur) => cur ?? list[0]?.id ?? null);
    })().catch(() => undefined);
  }, []);

  // 未读数轮询：徽标挂在「提醒」导航项与提醒页
  useEffect(() => {
    const poll = () => void api3.listNotifications(true).then((n) => setUnread(n.length)).catch(() => undefined);
    poll();
    const timer = setInterval(poll, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!avatarRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const go = (next: View) => {
    setView(next);
    setMenuOpen(false);
  };

  const openConversation = (id: string) => {
    setActiveConvId(id);
    setView("chat");
  };

  const newConversation = async () => {
    const entry = await api.createConversation();
    await reloadConversations();
    setActiveConvId(entry.id);
    setView("chat");
  };

  const removeConversation = async (id: string) => {
    if (!window.confirm("删除这个对话？消息将一并删除，不可恢复。")) return;
    await api.deleteConversation(id);
    const list = await reloadConversations();
    setActiveConvId((cur) => (cur === id ? list[0]?.id ?? null : cur));
  };

  const navItem = (key: View, label: string, Icon: (p: { className?: string }) => JSX.Element, badge?: number) => {
    const active = view === key || (key === "agents" && view === "agent-edit");
    return (
      <button
        onClick={() => (key === "agents" ? (setView("agents"), setEditingAgentId(null)) : go(key))}
        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition hover:bg-surface ${active ? "bg-surface font-medium text-ink" : "text-ink2"}`}
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        {badge !== undefined && badge > 0 && (
          <span className="num rounded-full bg-warm px-2 py-0.5 text-[11px] font-semibold text-white">{badge}</span>
        )}
      </button>
    );
  };

  const menuItem = (key: View, label: string, Icon: (p: { className?: string }) => JSX.Element) => (
    <button
      onClick={() => go(key)}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-[14px] text-ink transition hover:bg-surface2"
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 左侧纵向菜单（固定） */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface2">
        {/* 品牌 */}
        <div className="flex items-center gap-2 px-4 py-5">
          <Prism className="h-6 w-6" />
          <span className="text-lg font-semibold tracking-tight text-ink">OpenPrism</span>
        </div>

        {/* 主导航 */}
        <nav className="space-y-1 px-3">
          {navItem("chat", "对话", ChatIcon)}
          {navItem("today", "今天", TodayIcon)}
          {navItem("category", "盘面", CategoryIcon)}
          {navItem("progress", "成长", ProgressIcon)}
          <div className="mx-3 my-2 border-t border-line" />
          {navItem("agents", "伙伴", AgentsIcon)}
          {navItem("task", "提醒", TaskIcon, unread)}
        </nav>

        {/* 会话记录（置顶在前，其余按时间倒序；支持搜索与删除） */}
        <div className="mx-3 my-2 border-t border-line" />
        <div className="flex min-h-0 flex-1 flex-col px-3">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-[10px] uppercase tracking-wide text-ink3">最近对话</span>
            <button
              onClick={() => void newConversation()}
              className="flex items-center gap-1 text-xs text-accent transition hover:text-accent2"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-7-7v14" /></svg>
              新对话
            </button>
          </div>
          <input
            value={convQuery}
            onChange={(e) => setConvQuery(e.target.value)}
            placeholder="搜索对话…"
            className="mb-1.5 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none transition placeholder:text-ink3 focus:border-accent"
          />
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
            {conversations
              .filter((conv) => conv.title.toLowerCase().includes(convQuery.trim().toLowerCase()))
              .map((conv) => {
              const active = conv.id === activeConvId && view === "chat";
              return (
                <div
                  key={conv.id}
                  onClick={() => openConversation(conv.id)}
                  className={`group w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition hover:bg-surface ${active ? "bg-accent3" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent3 text-[10px] font-semibold text-accent">
                      {conv.title.slice(0, 1)}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-[14px] ${active ? "font-medium text-ink" : "text-ink"}`}>{conv.title}</span>
                    {conv.pinned && (
                      <span className="shrink-0 rounded bg-accent3 px-1 py-0.5 text-[10px] text-accent">定时</span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); void removeConversation(conv.id); }}
                      title="删除对话"
                      className="hidden shrink-0 rounded p-0.5 text-ink3 transition hover:text-warm group-hover:block"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink2">
                    {new Date(conv.createdTs).toLocaleDateString()} · {new Date(conv.createdTs).toTimeString().slice(0, 5)}
                  </p>
                </div>
              );
            })}
            {conversations.length === 0 && <p className="px-2 py-1 text-xs text-ink3">还没有对话</p>}
            {conversations.length > 0 && conversations.every((conv) => !conv.title.toLowerCase().includes(convQuery.trim().toLowerCase())) && (
              <p className="px-2 py-1 text-xs text-ink3">没有匹配的对话</p>
            )}
          </div>
        </div>

        {/* 左下角：个人头像下拉 */}
        <div className="relative px-3 pb-4" ref={avatarRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-surface"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent3 text-sm font-semibold text-accent">
              {username.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-ink">{username}</span>
              <span className="block text-xs text-ink3">本地账户</span>
            </span>
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-ink3" />
          </button>

          {menuOpen && (
            <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <div className="px-3 py-2.5 text-xs text-ink3">设置</div>
              {menuItem("task", "提醒", TaskIcon)}
              {menuItem("skills", "技能 / MCP", SkillsIcon)}
              {menuItem("memory", "长期记忆", MemoryIcon)}
              {menuItem("model", "模型接入", ModelIcon)}
              {menuItem("notify", "通知通道", NotifyIcon)}
              <div className="mx-3 my-1 border-t border-line" />
              <button
                onClick={() => { toggleTheme(); setMenuOpen(false); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-[14px] text-ink transition hover:bg-surface2"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <MoonIcon className="icon-moon h-4 w-4" />
                  <SunIcon className="icon-sun h-4 w-4" />
                </span>
                主题
              </button>
              <button
                onClick={onLogout}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-[14px] text-warm transition hover:bg-surface2"
              >
                <LogoutIcon className="h-4 w-4 shrink-0" />
                退出登录
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* 内容区：聊天页固定视口高内部滚动，其余页可滚动 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {view === "chat" && (
          <Chat
            conversations={conversations}
            reloadConversations={reloadConversations}
            activeConvId={activeConvId}
            setActiveConvId={setActiveConvId}
          />
        )}
        {view !== "chat" && (
          <div className="h-full overflow-y-auto">
            {view === "today" && <Today />}
            {view === "category" && <Panels />}
            {view === "progress" && <Progress />}
            {view === "agents" && (
              <Agents
                onEdit={(id) => { setEditingAgentId(id); setView("agent-edit"); }}
                onCreated={(id) => { setEditingAgentId(id); setView("agent-edit"); }}
              />
            )}
            {view === "agent-edit" && editingAgentId && (
              <AgentEdit agentId={editingAgentId} onBack={() => { setEditingAgentId(null); setView("agents"); }} />
            )}
            {view === "task" && <Tasks unread={unread} onUnreadChange={setUnread} />}
            {view === "skills" && <Skills />}
            {view === "memory" && <Memory />}
            {view === "model" && <Settings />}
            {view === "notify" && <NotifyChannels />}
          </div>
        )}
      </main>
    </div>
  );
}

export function App() {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then((me) => setUsername(me.username))
      .catch(() => setUsername(null));
  }, []);

  if (username === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
        <Login onLoggedIn={setUsername} />
      </div>
    );
  }

  return (
    <Shell
      username={username}
      onLogout={() => {
        void api.logout().catch(() => undefined);
        setUsername(null);
      }}
    />
  );
}
