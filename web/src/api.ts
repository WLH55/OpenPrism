// API 客户端：fetch（cookie 同源自动带）+ EventSource SSE。类型与服务器路由一一对应。

export interface ConversationEntry {
  id: string;
  title: string;
  createdTs: number;
}

/** 模型供应商（BYOK 多供应商列表视图；Key 永不回传，只有 hasKey） */
export interface ModelProvider {
  id: string;
  platform: string;
  baseURL: string;
  model: string;
  /** 上下文窗口 tokens；null = harness 默认 64K */
  contextWindow: number | null;
  hasKey: boolean;
}

export interface ConversationEntry {
  id: string;
  title: string;
  /** 置顶（定时提醒会话） */
  pinned: boolean;
  createdTs: number;
}

export interface TodayPlanView {
  planId: string;
  title: string;
  scope: string;
  due?: string;
  done: boolean;
  checkinTs?: number;
}

export interface TodayFlowView {
  seq: number;
  time: number;
  category: string;
  note?: string;
  value?: number;
  unit?: string;
}

export interface TodayView {
  date: string;
  flows: TodayFlowView[];
  plans: TodayPlanView[];
  totalByCategory: { category: string; total: number; count: number }[];
  streakDays: number;
}

/** 会话日志事件（harness 九事件）的宽松视图 */
export interface SessionEventLoose {
  type: string;
  seq?: number;
  ts?: number;
  channel?: string;
  message?: { role: string; content: { type: string; text?: string }[]; reasoning?: string; interrupted?: boolean };
  id?: string;
  name?: string;
  args?: unknown;
  isError?: boolean;
  code?: string;
  content?: { type: string; text?: string }[];
  reason?: string;
}

/** AgentLiveEvent 的宽松视图（SSE 载荷） */
export interface LiveEventLoose {
  type: string;
  status?: string;
  text?: string;
  message?: SessionEventLoose["message"];
  id?: string;
  name?: string;
  isError?: boolean;
  content?: { type: string; text?: string }[];
  code?: string;
  reason?: string;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let error = `HTTP ${res.status}`;
    try {
      error = ((await res.json()) as { error?: string }).error ?? error;
    } catch {
      /* 保持状态码文案 */
    }
    throw Object.assign(new Error(error), { status: res.status });
  }
  return (await res.json()) as T;
}

export const api = {
  register: (username: string, password: string) =>
    request<{ uid: string; username: string }>("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request<{ uid: string; username: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ uid: string; username: string }>("/api/auth/me"),

  // ── 模型接入（BYOK 多供应商） ──────────────────────────
  getModels: () => request<{ activeId: string | null; providers: ModelProvider[] }>("/api/models"),
  addModel: (input: { baseURL: string; apiKey?: string; model: string; contextWindow?: number | null; platform?: string }) =>
    request<{ id: string }>("/api/models", { method: "POST", body: JSON.stringify(input) }),
  updateModel: (id: string, input: { baseURL?: string; apiKey?: string; model?: string; contextWindow?: number | null }) =>
    request<{ ok: boolean }>(`/api/models/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}`, { method: "DELETE" }),
  activateModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}/active`, { method: "PUT" }),
  testModel: (id: string) => request<{ ok: boolean; error?: string }>(`/api/models/${id}/test`, { method: "POST" }),

  listConversations: () => request<ConversationEntry[]>("/api/conversations"),
  createConversation: (title?: string) =>
    request<ConversationEntry>("/api/conversations", { method: "POST", body: JSON.stringify(title ? { title } : {}) }),
  deleteConversation: (cid: string) => request<{ ok: boolean }>(`/api/conversations/${cid}`, { method: "DELETE" }),
  autoTitle: (cid: string) => request<{ ok: boolean; title?: string }>(`/api/conversations/${cid}/title`, { method: "POST" }),
  conversationEvents: (cid: string) => request<SessionEventLoose[]>(`/api/conversations/${cid}/events`),
  sendMessage: (cid: string, text: string) =>
    request<{ ok: boolean }>(`/api/conversations/${cid}/messages`, { method: "POST", body: JSON.stringify({ text }) }),

  today: () => request<TodayView>(`/api/today?tz=${-new Date().getTimezoneOffset()}`),
  quickFlow: (input: { category: string; note?: string; value?: number; unit?: string }) =>
    request<{ seq: number }>("/api/flows", { method: "POST", body: JSON.stringify(input) }),
  voidRecord: (seq: number) => request<{ ok: boolean }>("/api/void", { method: "POST", body: JSON.stringify({ seq }) }),
  checkin: (planId: string, done = true) =>
    request<{ ok: boolean }>("/api/checkin", { method: "POST", body: JSON.stringify({ planId, done }) }),
};

export function openConversationStream(cid: string, onEvent: (event: LiveEventLoose) => void): () => void {
  const source = new EventSource(`/api/conversations/${cid}/stream`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as LiveEventLoose);
    } catch {
      /* 坏帧忽略 */
    }
  };
  return () => source.close();
}

// ── 批次 2：伙伴 / 技能 / MCP / 记忆 ────────────────────
export interface AgentBindingLoose {
  tools?: string[];
  skills: string[];
  mcps: string[];
}
export interface AgentIdentityLoose {
  description: string;
  emoji: string;
  color: string;
  avatar?: string;
  language: string; // ''=自动跟随 | zh | en
  modelProviderId?: string;
}
export interface AgentLoose {
  id: string;
  name: string;
  createdTs: number;
  identity: AgentIdentityLoose;
  binding: AgentBindingLoose;
  persona?: string;
}
export interface AgentCreatePayload {
  name: string;
  persona: string;
  description?: string;
  emoji?: string;
  color?: string;
  avatar?: string;
  language?: string;
  modelProviderId?: string | null;
  binding?: AgentBindingLoose;
}
export interface SkillLoose {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
}
export interface McpLoose {
  id: string;
  name: string;
  url: string;
}
export interface ConversationMetaLoose {
  agentId?: string;
  modelProviderId?: string;
  switches: { ts: number; agentId: string }[];
}

export const api2 = {
  listAgents: () => request<AgentLoose[]>("/api/agents"),
  createAgent: (payload: AgentCreatePayload) => request<AgentLoose>("/api/agents", { method: "POST", body: JSON.stringify(payload) }),
  getAgent: (id: string) => request<AgentLoose & { persona: string }>(`/api/agents/${id}`),
  updateAgentIdentity: (id: string, patch: Partial<AgentIdentityLoose & { name: string }>) =>
    request<{ name: string }>(`/api/agents/${id}/identity`, { method: "PUT", body: JSON.stringify(patch) }),
  updatePersona: (id: string, markdown: string) =>
    request<{ name: string }>(`/api/agents/${id}/persona`, { method: "PUT", body: JSON.stringify({ markdown }) }),
  updateBinding: (id: string, binding: AgentBindingLoose) =>
    request<{ ok: boolean }>(`/api/agents/${id}/binding`, { method: "PUT", body: JSON.stringify({ binding }) }),
  deleteAgent: (id: string) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),

  listSkills: () => request<SkillLoose[]>("/api/skills"),
  installSkill: (content: string) => request<SkillLoose>("/api/skills", { method: "POST", body: JSON.stringify({ content }) }),
  skillBody: (id: string) => request<{ body: string }>(`/api/skills/${id}/body`),
  deleteSkill: (id: string) => request<{ ok: boolean }>(`/api/skills/${id}`, { method: "DELETE" }),

  listMcps: () => request<McpLoose[]>("/api/mcps"),
  addMcp: (name: string, url: string) => request<McpLoose>("/api/mcps", { method: "POST", body: JSON.stringify({ name, url }) }),
  deleteMcp: (id: string) => request<{ ok: boolean }>(`/api/mcps/${id}`, { method: "DELETE" }),
  mcpTools: (id: string) => request<{ tools: string[] }>(`/api/mcps/${id}/tools`, { method: "POST" }),

  getMemory: () => request<MemoryOverviewLoose>("/api/memory"),
  putMemorySlot: (slot: string, markdown: string) =>
    request<{ ok: boolean }>(`/api/memory/${slot}`, { method: "PUT", body: JSON.stringify({ markdown }) }),
  runMemory: () => request<MemoryRunSummaryLoose>("/api/memory/run", { method: "POST" }),
  listL1: (surface: string) => request<L1DetailLoose>(`/api/memory/l1/${surface}`),
  refreshL1: (surface: string) => request<{ added: number; modified: number; removed: number }>(`/api/memory/l1/${surface}/refresh`, { method: "POST" }),
  listL2: (surface: string) => request<{ entries: L2EntryLoose[] }>(`/api/memory/l2/${surface}`),
  updateL2: (surface: string) => request<{ added: number; skipped?: string }>(`/api/memory/l2/${surface}/update`, { method: "POST" }),
  editL2Entry: (surface: string, id: string, patch: { text?: string; section?: string }) =>
    request<{ ok: boolean }>(`/api/memory/l2/${surface}/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  removeL2Entry: (surface: string, id: string) => request<{ ok: boolean }>(`/api/memory/l2/${surface}/${id}`, { method: "DELETE" }),
  updateL3: (slot: string) => request<{ changed: boolean; skipped?: string }>(`/api/memory/l3/${slot}/update`, { method: "POST" }),

  convMeta: (cid: string) => request<ConversationMetaLoose>(`/api/conversations/${cid}/meta`),
  setConversationModel: (cid: string, providerId: string | null) =>
    request<{ ok: boolean }>(`/api/conversations/${cid}/model`, { method: "PUT", body: JSON.stringify({ providerId }) }),
  switchAgent: (cid: string, agentId: string) =>
    request<{ ok: boolean }>(`/api/conversations/${cid}/agent`, { method: "PUT", body: JSON.stringify({ agentId }) }),
};

// ── 批次 3：定时任务 / 通知 ──────────────────────────────
export interface TaskTriggerLoose {
  kind: "once" | "daily" | "weekly" | "monthly" | "yearly" | "interval" | "cron";
  at?: number;
  time?: string;
  days?: number[];
  day?: number;
  month?: number;
  expr?: string;
  every?: number; // interval：每 N 个单位
  unit?: "minute" | "hour" | "day" | "week" | "month" | "year";
  startTs?: number;
  endTs?: number; // 结束日当天末尾（含当天）
}
export interface TaskLoose {
  id: string;
  title: string;
  instruction: string;
  trigger: TaskTriggerLoose;
  enabled: boolean;
  agentId?: string;
  lastRunTs?: number;
}
// ── 记忆三层（对齐 DeepTutor：L1 工作区镜像 / L2 模块事实 / L3 跨模块知识） ──
export interface MemoryOverviewLoose {
  slots: Record<string, string>;
  meta: { lastRunTs?: number; runs: number };
  l1: { surfaces: { key: string; label: string; live: number; pending: { added: number; modified: number; removed: number } }[] };
  l2: { surfaces: { key: string; label: string; entries: number }[] };
  l3: { slots: { key: string; chars: number; bullets: number; hasNew: boolean }[]; preferences: { chars: number; bullets: number; toolOnly: boolean } };
}
export interface MemoryRunSummaryLoose {
  l1: Record<string, { added: number; modified: number; removed: number }>;
  l2: Record<string, { added: number; skipped?: string }>;
  l3: Record<string, { changed: boolean; skipped?: string }>;
}
export interface L1DetailLoose {
  entities: { ref: string; label: string; ts: number; fingerprint: string }[];
  changes: { kind: string; ref: string; label: string; ts: number }[];
  pending: { added: number; modified: number; removed: number };
}
export interface L2EntryLoose {
  id: string;
  section: string;
  text: string;
  refs: string[];
  createdTs: number;
  updatedTs?: number;
}
export interface TaskRunLoose {
  ts: number;
  status: "ran" | "skipped" | "failed";
  detail?: string;
}
export interface NotificationLoose {
  seq: number;
  ts: number;
  kind: string;
  taskId?: string;
  text: string;
  readTs?: number;
}

export const api3 = {
  listTasks: () => request<TaskLoose[]>("/api/tasks"),
  createTask: (input: { title: string; instruction: string; trigger: TaskTriggerLoose; tzOffsetMinutes?: number; agentId?: string }) =>
    request<TaskLoose>("/api/tasks", { method: "POST", body: JSON.stringify({ tzOffsetMinutes: -new Date().getTimezoneOffset(), ...input }) }),
  updateTask: (id: string, patch: Partial<Pick<TaskLoose, "enabled" | "instruction" | "title">> & { trigger?: TaskTriggerLoose }) =>
    request<TaskLoose>(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  runTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/run`, { method: "POST" }),
  taskRuns: (id: string) => request<TaskRunLoose[]>(`/api/tasks/${id}/runs`),

  listNotifications: (unreadOnly = false) =>
    request<NotificationLoose[]>(`/api/notifications${unreadOnly ? "?unread=1" : ""}`),
  markAllRead: () => request<{ ok: boolean }>("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }),
  markRead: (seq: number) => request<{ ok: boolean }>("/api/notifications/read", { method: "POST", body: JSON.stringify({ seq }) }),
};

// ── 批次 4：盘面 / 成长 ──────────────────────────────────
export interface CategoryStatLoose { category: string; lastTs: number; count: number; }
export interface CategoryPeriodLoose {
  period: "today" | "week" | "month" | "year";
  category: string;
  count: number;
  total: number;
  daily: { date: string; count: number; total: number }[];
  flows: TodayFlowView[];
}
export interface ProgressLoose {
  streakDays: number;
  completion: { done: number; total: number; rate: number };
  weekOverWeek: { category: string; thisWeek: number; lastWeek: number; deltaPct: number | null }[];
  trend14: { date: string; count: number }[];
}

export const api4 = {
  panels: () => request<{ categories: CategoryStatLoose[]; archived: string[] }>("/api/panels"),
  categoryPanel: (name: string, period: string) =>
    request<CategoryPeriodLoose>(`/api/panels/category/${encodeURIComponent(name)}?period=${period}`),
  progress: () => request<ProgressLoose>("/api/panels/progress"),
  mergeCategory: (from: string, to: string) =>
    request<{ moved: number }>("/api/panels/merge", { method: "POST", body: JSON.stringify({ from, to }) }),
  archiveCategory: (name: string) => request<{ archived: string[] }>("/api/panels/archive", { method: "POST", body: JSON.stringify({ name }) }),
  unarchiveCategory: (name: string) => request<{ archived: string[] }>("/api/panels/unarchive", { method: "POST", body: JSON.stringify({ name }) }),
};
