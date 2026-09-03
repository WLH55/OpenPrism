// API 客户端：fetch（cookie 同源自动带）+ EventSource SSE。类型与服务器路由一一对应。

export interface ConversationEntry {
  id: string;
  title: string;
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

  getModel: () => request<{ baseURL: string; model: string; hasKey: boolean }>("/api/model"),
  putModel: (input: { baseURL: string; apiKey?: string; model: string }) =>
    request<{ ok: boolean }>("/api/model", { method: "PUT", body: JSON.stringify(input) }),
  testModel: () => request<{ ok: boolean; error?: string }>("/api/model/test", { method: "POST" }),

  listConversations: () => request<ConversationEntry[]>("/api/conversations"),
  createConversation: (title?: string) =>
    request<ConversationEntry>("/api/conversations", { method: "POST", body: JSON.stringify(title ? { title } : {}) }),
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
export interface AgentLoose {
  id: string;
  name: string;
  createdTs: number;
  binding: AgentBindingLoose;
  persona?: string;
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
  switches: { ts: number; agentId: string }[];
}

export const api2 = {
  listAgents: () => request<AgentLoose[]>("/api/agents"),
  createAgent: (persona: string, binding?: AgentBindingLoose) =>
    request<AgentLoose>("/api/agents", { method: "POST", body: JSON.stringify({ persona, ...(binding ? { binding } : {}) }) }),
  getAgent: (id: string) => request<AgentLoose & { persona: string }>(`/api/agents/${id}`),
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

  getMemory: () => request<{ slots: Record<string, string>; meta: { lastRunTs?: number; runs: number } }>("/api/memory"),
  putMemorySlot: (slot: string, markdown: string) =>
    request<{ ok: boolean }>(`/api/memory/${slot}`, { method: "PUT", body: JSON.stringify({ markdown }) }),
  consolidateMemory: () => request<{ changed: boolean }>("/api/memory/consolidate", { method: "POST" }),

  convMeta: (cid: string) => request<ConversationMetaLoose>(`/api/conversations/${cid}/meta`),
  switchAgent: (cid: string, agentId: string) =>
    request<{ ok: boolean }>(`/api/conversations/${cid}/agent`, { method: "PUT", body: JSON.stringify({ agentId }) }),
};

// ── 批次 3：定时任务 / 通知 ──────────────────────────────
export interface TaskTriggerLoose {
  kind: "once" | "daily" | "weekly" | "monthly" | "yearly" | "cron";
  at?: number;
  time?: string;
  days?: number[];
  day?: number;
  month?: number;
  expr?: string;
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
