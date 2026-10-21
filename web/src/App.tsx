import { useCallback, useEffect, useRef, useState } from "react";
import { api, api2, api3, type ConversationEntry, type MeLoose } from "./api";
import { Profile } from "./pages/Profile";
import { FaceAvatar } from "./components/FaceEditor";
import { LightboxHost } from "./lightbox";
import { VersionWatch } from "./version-watch";
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
import { IM } from "./pages/IM";
import { BottomTabs, Drawer } from "./components/MobileNav";
import { RepoLinkBar } from "./components/RepoLink";
import {
  AgentsIcon, CategoryIcon, ChatIcon, ChevronDownIcon, ImIcon, LogoutIcon, MemoryIcon,
  MenuIcon, ModelIcon, MoonIcon, Prism, ProgressIcon, SkillsIcon, SunIcon, TaskIcon, TodayIcon,
} from "./icons";

export type View =
  | "chat" | "today" | "category" | "progress"
  | "agents" | "agent-edit" | "task" | "skills" | "memory" | "model" | "im" | "profile";

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("op-theme", next);
  } catch {
    /* 无 localStorage 也无妨 */
  }
}

/** 窄屏顶栏的当前页名 */
function viewTitle(view: View): string {
  switch (view) {
    case "chat": return "对话";
    case "today": return "今天";
    case "category": return "盘面";
    case "progress": return "成长";
    case "agents": return "伙伴";
    case "agent-edit": return "伙伴";
    case "task": return "提醒";
    case "skills": return "技能 / MCP";
    case "memory": return "长期记忆";
    case "model": return "模型接入";
    case "im": return "IM 通道";
    case "profile": return "个人资料";
  }
}

/** 「更多」标签高亮条件：抽屉开着，或当前页是抽屉专属页 */
const MORE_VIEWS: View[] = ["category", "agents", "agent-edit", "task", "skills", "memory", "model", "im", "profile"]; // 2026-09-28 B3：盘面从底部栏下架，归入更多

interface SidebarProps {
  me: MeLoose;
  view: View;
  conversations: ConversationEntry[];
  activeConvId: string | null;
  unread: number;
  convQuery: string;
  setConvQuery: (query: string) => void;
  /** 场景过滤（2026-10-12 工作台化一期）："all" | "untagged" | 场景名 */
  sceneFilter: string;
  setSceneFilter: (scene: string) => void;
  onGo: (view: View) => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: () => void;
  onRemoveConversation: (id: string) => void;
  /** 打标/改标/清标（null = 清除）后刷新会话列表 */
  onSetScene: (id: string, scene: string | null) => Promise<void>;
  onLogout: () => void;
}

/** 场景打标编辑器（2026-10-12 工作台化一期）：已有场景一键选 + 新场景输入 + 清除；点击内部不触发选会话 */
function SceneEditor({ conv, scenes, onSet, onClose }: { conv: ConversationEntry; scenes: string[]; onSet: (scene: string | null) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(conv.scene ?? "");
  const [busy, setBusy] = useState(false);
  const apply = async (scene: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await onSet(scene);
    } catch (e) {
      window.alert(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 rounded-lg border border-line bg-surface p-2" onClick={(e) => e.stopPropagation()}>
      {scenes.filter((s) => s !== conv.scene).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {scenes.filter((s) => s !== conv.scene).map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => void apply(s)}
              className="rounded-full bg-accent3 px-2 py-0.5 text-[11px] text-accent transition hover:bg-accent hover:text-white disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void apply(value.trim() === "" ? null : value.trim());
            if (e.key === "Escape") onClose();
          }}
          placeholder="场景名（如：装修）…"
          maxLength={32}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface2 px-2 py-1 text-xs text-ink outline-none focus:border-accent"
        />
        <button
          disabled={busy}
          onClick={() => void apply(value.trim() === "" ? null : value.trim())}
          className="rounded-md bg-accent px-2 py-1 text-xs text-white transition hover:bg-accent2 disabled:opacity-50"
        >
          {value.trim() === "" ? "清除" : "设置"}
        </button>
      </div>
    </div>
  );
}

/**
 * 侧栏内容（2026-09-23 抽出成件）：桌面 = 固定左栏的内身，窄屏 = 抽屉内身，两处装同一份。
 * 头像下拉的开合状态自持——两处不会同时可见，各自持有互不串线。
 */
function SidebarContent({
  me, view, conversations, activeConvId, unread, convQuery, setConvQuery, sceneFilter, setSceneFilter,
  onGo, onOpenConversation, onNewConversation, onRemoveConversation, onSetScene, onLogout,
}: SidebarProps) {
  const username = me.username;
  const [menuOpen, setMenuOpen] = useState(false);
  const [tagEditingId, setTagEditingId] = useState<string | null>(null);
  const avatarRef = useRef<HTMLDivElement>(null);

  // 场景目录（零预设）：从已打标会话动态长出，最近打过的排前（列表本身置顶/时间倒序，这里保序去重）
  const scenes = [...new Set(conversations.map((c) => c.scene).filter((s): s is string => typeof s === "string" && s !== ""))];

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!avatarRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const navItem = (key: View, label: string, Icon: (p: { className?: string }) => JSX.Element, badge?: number) => {
    const active = view === key || (key === "agents" && view === "agent-edit");
    return (
      <button
        onClick={() => onGo(key)}
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
      onClick={() => onGo(key)}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-[14px] text-ink transition hover:bg-surface2"
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );

  return (
    <>
      {/* 品牌 */}
      <div className="flex items-center gap-2 px-4 py-5">
        <Prism className="h-6 w-6" />
        <span className="text-lg font-semibold tracking-tight text-ink">OpenPrism</span>
      </div>

      {/* 主导航 */}
      <nav className="space-y-1 px-3">
        {navItem("chat", "对话", ChatIcon)}
        {navItem("today", "今天", TodayIcon)}
        {navItem("progress", "成长", ProgressIcon)}
        <div className="mx-3 my-2 border-t border-line" />
        {navItem("category", "盘面", CategoryIcon)}
        {navItem("agents", "伙伴", AgentsIcon)}
        {navItem("task", "提醒", TaskIcon, unread)}
      </nav>

      {/* 会话记录（置顶在前，其余按时间倒序；支持搜索与删除） */}
      <div className="mx-3 my-2 border-t border-line" />
      <div className="flex min-h-0 flex-1 flex-col px-3">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] uppercase tracking-wide text-ink3">最近对话</span>
          <button
            onClick={onNewConversation}
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
        {/* 场景 chip 行（2026-10-12 工作台化一期）：全部/未打标/从会话动态长出的场景；横滑不换行（盘面同款） */}
        {scenes.length > 0 && (
          <div className="mb-1.5 flex gap-1 overflow-x-auto pb-0.5">
            {(["all", "untagged", ...scenes] as const).map((scene) => {
              const active = sceneFilter === scene;
              return (
                <button
                  key={scene}
                  onClick={() => setSceneFilter(scene)}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] transition ${active ? "bg-accent text-white" : "bg-surface text-ink2 hover:bg-accent3 hover:text-accent"}`}
                >
                  {scene === "all" ? "全部" : scene === "untagged" ? "未打标" : scene}
                </button>
              );
            })}
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
          {conversations
            .filter((conv) => {
              const byScene = sceneFilter === "all" ? true : sceneFilter === "untagged" ? !conv.scene : conv.scene === sceneFilter;
              return byScene && conv.title.toLowerCase().includes(convQuery.trim().toLowerCase());
            })
            .map((conv) => {
              const active = conv.id === activeConvId && view === "chat";
              return (
                <div
                  key={conv.id}
                  onClick={() => onOpenConversation(conv.id)}
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
                    {conv.scene && (
                      <span className="shrink-0 rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-ink2">{conv.scene}</span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setTagEditingId(tagEditingId === conv.id ? null : conv.id); }}
                      title="场景标签"
                      className="shrink-0 rounded p-0.5 text-ink3 transition hover:text-accent md:hidden md:group-hover:block"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h.01M7 3h5a1.99 1.99 0 0 1 1.41.59l7 7a2 2 0 0 1 0 2.82l-7 7a2 2 0 0 1-2.82 0l-7-7A1.99 1.99 0 0 1 3 12V7a4 4 0 0 1 4-4z" /></svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemoveConversation(conv.id); }}
                      title="删除对话"
                      className="shrink-0 rounded p-0.5 text-ink3 transition hover:text-warm md:hidden md:group-hover:block"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink2">
                    {new Date(conv.createdTs).toLocaleDateString()} · {new Date(conv.createdTs).toTimeString().slice(0, 5)}
                  </p>
                  {/* 打标编辑器（2026-10-12）：已有场景一键选 + 新场景输入 + 清除 */}
                  {tagEditingId === conv.id && (
                    <SceneEditor
                      conv={conv}
                      scenes={scenes}
                      onSet={async (scene) => {
                        await onSetScene(conv.id, scene);
                        setTagEditingId(null);
                      }}
                      onClose={() => setTagEditingId(null)}
                    />
                  )}
                </div>
              );
            })}
          {conversations.length === 0 && <p className="px-2 py-1 text-xs text-ink3">还没有对话</p>}
          {conversations.length > 0 && conversations.every((conv) => {
            const byScene = sceneFilter === "all" ? true : sceneFilter === "untagged" ? !conv.scene : conv.scene === sceneFilter;
            return !byScene || !conv.title.toLowerCase().includes(convQuery.trim().toLowerCase());
          }) && (
            <p className="px-2 py-1 text-xs text-ink3">没有匹配的对话</p>
          )}
        </div>
      </div>

      {/* 左下角：GitHub 开源入口 + 个人头像下拉 */}
      <RepoLinkBar />
      <div className="relative px-3 pb-4" ref={avatarRef}>
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-surface"
        >
          <FaceAvatar name={username} face={me.face} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium text-ink">{username}</span>
            <span className="block text-xs text-ink3">本地账户</span>
          </span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-ink3" />
        </button>

        {menuOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
            <div className="px-3 py-2.5 text-xs text-ink3">设置</div>
            {menuItem("profile", "个人资料", AgentsIcon)}
            {menuItem("task", "提醒", TaskIcon)}
            {menuItem("skills", "技能 / MCP", SkillsIcon)}
            {menuItem("memory", "长期记忆", MemoryIcon)}
            {menuItem("model", "模型接入", ModelIcon)}
            {menuItem("im", "IM 通道", ImIcon)}
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
    </>
  );
}

/**
 * 应用壳（2026-09-23 窄屏重排）：桌面 = 左侧固定菜单 + 内容区（原样）；
 * 窄屏 = 顶栏（菜单按钮 + 页名）+ 内容区 + 底部五项标签栏，菜单收进抽屉。
 */
function Shell({ me, onFaceSaved, onLogout }: { me: MeLoose; onFaceSaved: (next: MeLoose) => void; onLogout: () => void }) {
  const [view, setView] = useState<View>("chat");
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [convQuery, setConvQuery] = useState("");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const reloadConversations = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    return list;
  }, []);

  // 技能卡片「使用」→ 预填 /技能名 并跳回对话（2026-10-21 技能系统）
  useEffect(() => {
    const goChat = (): void => setView("chat");
    window.addEventListener("op-go-chat", goChat);
    return () => window.removeEventListener("op-go-chat", goChat);
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

  // 未读数轮询：徽标挂在「提醒」导航项、窄屏顶栏与「更多」标签上
  useEffect(() => {
    const poll = () => void api3.listNotifications(true).then((n) => setUnread(n.length)).catch(() => undefined);
    poll();
    const timer = setInterval(poll, 15000);
    return () => clearInterval(timer);
  }, []);

  // 场景过滤兜底（2026-10-12）：过滤中的场景被清到最后一个会话后目录自然消失——过滤名失效时回落"全部"，
  // 否则侧栏卡在"没有匹配的对话"且 chip 行已隐藏、无可见出口（评审 P1）
  useEffect(() => {
    if (sceneFilter === "all" || sceneFilter === "untagged") return;
    const live = conversations.some((c) => c.scene === sceneFilter);
    if (!live) setSceneFilter("all");
  }, [conversations, sceneFilter]);

  // 窄屏抽屉的安卓返回键：打开时压一条历史，返回键只关抽屉，不退出页面
  useEffect(() => {
    if (!drawerOpen) return;
    const onPop = () => setDrawerOpen(false);
    window.addEventListener("popstate", onPop);
    history.pushState({ opDrawer: true }, "");
    return () => {
      window.removeEventListener("popstate", onPop);
      // 经遮罩/关闭按钮收起（而非返回键）时，弹掉本效果压入的那条历史
      if ((history.state as { opDrawer?: boolean } | null)?.opDrawer === true) history.back();
    };
  }, [drawerOpen]);

  const go = (next: View) => {
    setView(next);
    if (next === "agents") setEditingAgentId(null); // 从抽屉回伙伴列表时清掉编辑态
    setDrawerOpen(false);
  };

  const openConversation = (id: string) => {
    setActiveConvId(id);
    setView("chat");
    setDrawerOpen(false);
  };

  const newConversation = async () => {
    const entry = await api.createConversation();
    await reloadConversations();
    setActiveConvId(entry.id);
    setView("chat");
    setDrawerOpen(false);
  };

  const removeConversation = async (id: string) => {
    if (!window.confirm("删除这个对话？消息将一并删除，不可恢复。")) return;
    await api.deleteConversation(id);
    const list = await reloadConversations();
    setActiveConvId((cur) => (cur === id ? list[0]?.id ?? null : cur));
  };

  // 场景打标（2026-10-12 工作台化一期）：落库后刷新列表；当前过滤场景被清空到无人使用时目录自然消失
  const setConversationScene = async (id: string, scene: string | null) => {
    await api2.setConversationScene(id, scene);
    await reloadConversations();
  };

  const sidebarProps = {
    me,
    view,
    conversations,
    activeConvId,
    unread,
    convQuery,
    setConvQuery,
    sceneFilter,
    setSceneFilter,
    onGo: go,
    onOpenConversation: openConversation,
    onNewConversation: () => void newConversation(),
    onRemoveConversation: (id: string) => void removeConversation(id),
    onSetScene: setConversationScene,
    onLogout,
  };
  const moreActive = drawerOpen || MORE_VIEWS.includes(view);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* 桌面：左侧固定菜单（窄屏隐藏，内容进抽屉） */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface2 md:flex">
        <SidebarContent {...sidebarProps} />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 窄屏顶栏：菜单按钮 + 当前页名 */}
        <header className="flex items-center gap-2 border-b border-line bg-surface2 px-2 py-2 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="打开菜单"
            className="rounded-lg p-2 text-ink2 transition hover:bg-surface"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <span className="flex-1 truncate text-[15px] font-semibold text-ink">{viewTitle(view)}</span>
          {unread > 0 && view !== "task" && (
            <span className="num rounded-full bg-warm px-2 py-0.5 text-[11px] font-semibold text-white">{unread}</span>
          )}
        </header>

        {/* 内容区：聊天页固定视口高内部滚动，其余页可滚动 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "chat" && (
            <Chat
              conversations={conversations}
              reloadConversations={reloadConversations}
              activeConvId={activeConvId}
              setActiveConvId={setActiveConvId}
              username={me.username}
              userFace={me.face}
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
              {view === "im" && <IM />}
              {view === "profile" && <Profile me={me} onSaved={onFaceSaved} />}
            </div>
          )}
        </main>

        {/* 窄屏底部标签栏：四主页面 + 更多（开抽屉） */}
        <BottomTabs view={view} moreActive={moreActive} unread={unread} onPick={go} onMore={() => setDrawerOpen(true)} />
      </div>

      {/* 窄屏抽屉：遮罩 + 左滑面板，装同一份侧栏内容 */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <SidebarContent {...sidebarProps} />
      </Drawer>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<MeLoose | null>(null);

  useEffect(() => {
    api
      .me()
      .then((loaded) => {
        setMe(loaded);
        // 时区静默上报（2026-09-29，幂等）：浏览器偏移 ≠ 档案值才写库——档案是 agent 工具层/微信/定时任务的统一钟面，DST 靠下次打开覆盖
        const browserTz = -new Date().getTimezoneOffset();
        if (loaded.tzOffsetMinutes !== browserTz) {
          void api.updateProfile({ tzOffsetMinutes: browserTz }).catch(() => undefined);
        }
      })
      .catch(() => setMe(null));
  }, []);

  if (me === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
        <Login
          onLoggedIn={(username) => {
            // 先用用户名起壳，形象随后从 /api/auth/me 取（登录页不必等它）
            setMe({ username, face: { avatar: "", emoji: "", color: "" } });
            void api.me().then(setMe).catch(() => undefined);
          }}
        />
      </div>
    );
  }

  return (
    <LightboxHost>
      <VersionWatch />
      <Shell
        me={me}
        onFaceSaved={setMe}
        onLogout={() => {
          void api.logout().catch(() => undefined);
          setMe(null);
        }}
      />
    </LightboxHost>
  );
}
