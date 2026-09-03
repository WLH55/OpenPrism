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
