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
  /** 提供方用途：chat=对话/提取，embedding=记忆向量（2026-09-18） */
  kind: string;
  /** 该模型是否支持图片识别（多模态）：对话里发图的前提 */
  multimodal: boolean;
}

/** 用户形象（头像图片 data URL / emoji / 色盘） */
export interface FaceLoose {
  avatar: string;
  emoji: string;
  color: string;
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
  /** 确定性状态：overdue/dueToday/doing/todo/upcoming/done（旧服务端无此字段 → 用 done 兜底） */
  state?: "overdue" | "dueToday" | "doing" | "todo" | "upcoming" | "done";
  /** 当前可撤销的打卡 seq：deadline 型完成=全部存活 done 打卡；周期型今日 done=今日打卡——撤销=逐条作废（与计划页同规） */
  doneSeqs?: number[];
  /** 最近 10 条存活 done 打卡（倒序，含非今日）——撤历史卡凭据 */
  checkins?: { seq: number; at: number }[];
  /** 挂目标树的计划带顶层方向标题——独立待办没有此字段 */
  goalTitle?: string;
  /** 账本 seq：逾期「跳过」= 作废该 plan 记录 */
  seq?: number;
  /** 完成时刻（最新存活 done 打卡）——已完成视图按它倒序/过滤近 30 天 */
  doneAt?: number;
  /** 今天完成的确定性标记（评审 #14）：周期型=今日打过卡；deadline 型=最新完成打卡在今天（上周完成的里程碑 state=done 但 doneToday=false） */
  doneToday?: boolean;
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
  /** B1（2026-09-28）：今日必做 + 计划卡 */
  top3: TopItemLoose[];
  goalCard: {
    directions: { goalId: string; title: string; progress: { done: number; total: number; rate: number }; updatedAt: number }[];
    phases: { goalId: string; title: string; due?: string; nextStep?: string }[];
    warning?: string;
  };
}

/** 今日必做条目（确定性折叠：逾期 > 今日截止 > 覆盖今天 > 阶段下一步补位） */
export interface TopItemLoose {
  kind: "overdue" | "dueToday" | "today" | "nextStep";
  title: string;
  planId?: string;
  due?: string;
  goalTitle?: string;
}

export type GoalLevel = "direction" | "phase" | "project";

/** 目标节点（服务端 goalView 的层级树成员） */
export interface GoalNodeLoose {
  goalId: string;
  level: GoalLevel;
  title: string;
  status: "active" | "paused" | "done" | "archived";
  parentId?: string;
  why?: string;
  outcome?: string;
  metric?: string;
  due?: string;
  nextStep?: string;
  updatedAt: number;
  children: GoalNodeLoose[];
  /** 子树里程碑进度（deadline 型 plan） */
  progress: { done: number; total: number; rate: number };
  /** 子树周期计划今日执行 */
  recurring: { doneToday: number; total: number };
}

export interface GoalViewLoose {
  directions: GoalNodeLoose[];
  activeDirectionCount: number;
  activePhaseCount: number;
  warning?: string;
}

/** 里程碑明细（deadline 型 plan，挂目标树；计划页打卡按钮用） */
export interface MilestoneLoose {
  planId: string;
  title: string;
  due: string;
  goalId: string;
  done: boolean;
  /** 存活 done 打卡的 seq；撤销打卡 = 逐条作废（旧版服务端无此字段 → undefined，UI 降级为不可撤销） */
  doneSeqs?: number[];
}

export type GoalsPageLoose = GoalViewLoose & { milestones: MilestoneLoose[] };

export interface GoalInput {
  level: GoalLevel;
  title: string;
  parentId?: string;
  why?: string;
  outcome?: string;
  metric?: string;
  due?: string;
  nextStep?: string;
}

/** 会话日志事件（harness 九事件）的宽松视图 */
/** 内容块宽松视图：文本 / 图片（base64）/ 文本附件 / 工具调用 */
export interface BlockLoose {
  type: string;
  text?: string;
  mediaType?: string;
  data?: string;
  name?: string;
}

export interface SessionEventLoose {
  type: string;
  seq?: number;
  ts?: number;
  channel?: string;
  message?: { role: string; content: BlockLoose[]; reasoning?: string; interrupted?: boolean };
  id?: string;
  name?: string;
  args?: unknown;
  isError?: boolean;
  code?: string;
  content?: BlockLoose[];
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
  content?: BlockLoose[];
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
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      error = body.error ?? error;
      code = body.code;
    } catch {
      /* 保持状态码文案 */
    }
    throw Object.assign(new Error(error), { status: res.status, code });
  }
  return (await res.json()) as T;
}

export interface MeLoose {
  username: string;
  face: FaceLoose;
  /** 用户档案时区（分钟；缺省 = 未上报，前端静默补报） */
  tzOffsetMinutes?: number;
}

/** 一条待发附件（浏览器加工后的形态） */
export interface AttachmentInput {
  kind: "image" | "file";
  name: string;
  mediaType: string;
  /** kind=image：base64 裸数据 */
  dataBase64?: string;
  /** kind=file：正文 */
  text?: string;
}

export const api = {
  register: (username: string, password: string) =>
    request<{ uid: string; username: string }>("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request<{ uid: string; username: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<MeLoose>("/api/auth/me"),
  updateProfile: (patch: { avatar?: string; emoji?: string; color?: string; tzOffsetMinutes?: number }) =>
    request<MeLoose>("/api/auth/profile", { method: "PUT", body: JSON.stringify(patch) }),

  // ── 模型接入（BYOK 多供应商） ──────────────────────────
  getModels: () => request<{ activeId: string | null; providers: ModelProvider[] }>("/api/models"),
  addModel: (input: { baseURL: string; apiKey?: string; model: string; contextWindow?: number | null; platform?: string; kind?: string; multimodal?: boolean }) =>
    request<{ id: string }>("/api/models", { method: "POST", body: JSON.stringify(input) }),
  updateModel: (id: string, input: { baseURL?: string; apiKey?: string; model?: string; contextWindow?: number | null; kind?: string; multimodal?: boolean }) =>
    request<{ ok: boolean }>(`/api/models/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}`, { method: "DELETE" }),
  activateModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}/active`, { method: "PUT" }),
  testModel: (id: string) => request<{ ok: boolean; error?: string }>(`/api/models/${id}/test`, { method: "POST" }),

  listConversations: () => request<ConversationEntry[]>("/api/conversations"),
  createConversation: (title?: string) =>
    request<ConversationEntry>("/api/conversations", { method: "POST", body: JSON.stringify(title ? { title } : {}) }),
  deleteConversation: (cid: string) => request<{ ok: boolean }>(`/api/conversations/${cid}`, { method: "DELETE" }),
  autoTitle: (cid: string) => request<{ ok: boolean; title?: string }>(`/api/conversations/${cid}/title`, { method: "POST" }),
  /** 分段加载（2026-09-23）：limit = 最近 N 条；before = seq 游标（取更早一段）；都不传 = 全量 */
  conversationEvents: (cid: string, options?: { before?: number; limit?: number }): Promise<SessionEventLoose[]> => {
    const params = new URLSearchParams();
    if (options?.before !== undefined) params.set("before", String(options.before));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return request<SessionEventLoose[]>(`/api/conversations/${cid}/events${query ? `?${query}` : ""}`);
  },
  sendMessage: (cid: string, text: string, attachments: AttachmentInput[] = []) =>
    request<{ ok: boolean }>(`/api/conversations/${cid}/messages`, {
      method: "POST",
      body: JSON.stringify(attachments.length > 0 ? { text, attachments } : { text }),
    }),
  /** 手动中止当前回合（2026-09-27 打断）：部分输出保留为 interrupted 消息 */
  stopConversation: (cid: string) => request<{ ok: boolean }>(`/api/conversations/${cid}/stop`, { method: "POST" }),

  today: () => request<TodayView>(`/api/today?tz=${-new Date().getTimezoneOffset()}`),
  quickFlow: (input: { category: string; note?: string; value?: number; unit?: string }) =>
    request<{ seq: number }>("/api/flows", { method: "POST", body: JSON.stringify(input) }),
  voidRecord: (seq: number) => request<{ ok: boolean }>("/api/void", { method: "POST", body: JSON.stringify({ seq }) }),
  checkin: (planId: string, done = true, date?: string) =>
    request<{ ok: boolean }>("/api/checkin", {
      method: "POST",
      body: JSON.stringify({ planId, done, ...(date !== undefined ? { date } : {}) }),
    }),

  // ── 目标层级（B3，2026-09-28）：方向/阶段/项目树 + UI 写入（修订=追加快照） ──
  goals: () => request<GoalsPageLoose>(`/api/goals?tz=${-new Date().getTimezoneOffset()}`),
  createGoal: (input: GoalInput) =>
    request<{ goalId: string; ts: number }>("/api/goals", { method: "POST", body: JSON.stringify(input) }),
  updateGoal: (goalId: string, patch: Omit<Partial<GoalInput>, "level"> & { status?: string }) =>
    request<{ ok: boolean }>(`/api/goals/${encodeURIComponent(goalId)}`, { method: "PUT", body: JSON.stringify(patch) }),
  /** 真删目标（#B）：作废该 goalId 全部存活快照留痕；有存活子目标时服务端 400 */
  deleteGoal: (goalId: string) =>
    request<{ ok: boolean; voided: number }>(`/api/goals/${encodeURIComponent(goalId)}`, { method: "DELETE" }),
  /** UI 建计划/里程碑（挂目标树）；对话建计划走 agent 工具，同一账本 */
  createPlan: (input: { title: string; scope: string; due?: string; goalId?: string }) =>
    request<{ planId: string }>("/api/plans", { method: "POST", body: JSON.stringify(input) }),
  /** UI 修订计划（2026-09-29）：与 update_plan 工具同源（mergePlanUpdate）——追加新版本+void 旧记录，planId 稳定 */
  updatePlan: (planId: string, patch: { title?: string; scope?: string; due?: string; ndays?: number; goalId?: string }) =>
    request<{ ok: boolean; planId: string; title: string }>(`/api/plans/${encodeURIComponent(planId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
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
  listMemoryItems: (query: { kind?: string; status?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.status) params.set("status", query.status);
    params.set("limit", String(query.limit ?? 200));
    return request<{ items: MemoryItemLoose[] }>(`/api/memory/items?${params.toString()}`);
  },
  addMemoryItem: (payload: { kind: string; content: string; importance?: number; topic?: string }) =>
    request<{ item: MemoryItemLoose }>("/api/memory/items", { method: "POST", body: JSON.stringify(payload) }),
  clearMemoryItems: () => request<{ removed: number }>("/api/memory/items", { method: "DELETE", body: JSON.stringify({ confirm: "clear" }) }),
  editMemoryItem: (id: string, patch: { content?: string; importance?: number; topic?: string }) =>
    request<{ item: MemoryItemLoose }>(`/api/memory/items/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  removeMemoryItem: (id: string) => request<{ ok: boolean }>(`/api/memory/items/${id}`, { method: "DELETE" }),
  confirmMemoryItem: (id: string) => request<{ ok: boolean }>(`/api/memory/items/${id}/confirm`, { method: "POST" }),
  rejectMemoryItem: (id: string) => request<{ ok: boolean }>(`/api/memory/items/${id}/reject`, { method: "POST" }),
  extractMemory: () => request<{ segments: number; added: number; updated: number; deleted: number; skipped?: string }>("/api/memory/extract", { method: "POST" }),
  consolidateMemory: () =>
    request<{ reviewed: number; expired: number; demoted: number; merged: number; skipped?: string }>("/api/memory/consolidate", { method: "POST" }),
  exportMemoryUrl: () => "/api/memory/export",

  // ── 主题计数与向量召回（2026-09-18） ──────────────────
  listMemoryTopics: () =>
    request<{ topics: MemoryTopicLoose[]; total: number; threshold: number }>("/api/memory/topics"),
  promoteMemoryTopic: (key: string) =>
    request<{ ok: boolean; topic: string }>(`/api/memory/topics/${encodeURIComponent(key)}/promote`, { method: "POST" }),
  forgetMemoryTopic: (key: string) =>
    request<{ ok: boolean }>(`/api/memory/topics/${encodeURIComponent(key)}`, { method: "DELETE" }),
  restoreMemoryTopic: (key: string) =>
    request<{ ok: boolean }>(`/api/memory/topics/${encodeURIComponent(key)}/restore`, { method: "POST" }),
  patchMemoryConfig: (patch: { interestThreshold?: number | null; embeddingProviderId?: string | null }) =>
    request<{ ok: boolean; config: MemoryConfigLoose }>("/api/memory/config", { method: "PATCH", body: JSON.stringify(patch) }),

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
  /** 通知渠道（2026-09-27）：inapp 站内（默认）| wechat 站内记录+微信机器人推送 */
  notifyChannel?: "inapp" | "wechat";
  /** 内置任务标记（2026-09-29）：daily-brief | daily-report | weekly-review——UI 带「内置」徽标 */
  builtin?: string;
  lastRunTs?: number;
}
// ── 记忆三层（对齐 DeepTutor：L1 工作区镜像 / L2 模块事实 / L3 跨模块知识） ──
export interface MemoryOverviewLoose {
  counts: Record<string, number>;
  meta: { runs: number; lastExtractTs?: number; consolidatedTs?: number; scheduledTs?: number };
  config?: MemoryConfigLoose;
}
export interface MemoryConfigLoose {
  interestThreshold: number;
  embeddingProviderId: string | null;
}
/** 未晋升主题（主题计数，2026-09-18）：hits 达 threshold 自动变兴趣记忆 */
export interface MemoryTopicLoose {
  id: string;
  topic: string;
  aliases: string[];
  hits: number;
  lastSeenTs: number;
}
export interface MemoryItemLoose {
  id: string;
  kind: string;
  status: string;
  origin: string;
  topic: string;
  content: string;
  importance: number;
  sourceRef?: string;
  validFrom: number;
  invalidAt?: number;
  supersededBy?: string;
  expiresAt?: number;
  useCount: number;
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
  createTask: (input: { title: string; instruction: string; trigger: TaskTriggerLoose; tzOffsetMinutes?: number; agentId?: string; notifyChannel?: "inapp" | "wechat" }) =>    request<TaskLoose>("/api/tasks", { method: "POST", body: JSON.stringify({ tzOffsetMinutes: -new Date().getTimezoneOffset(), ...input }) }),
  updateTask: (id: string, patch: Partial<Pick<TaskLoose, "enabled" | "instruction" | "title" | "notifyChannel">> & { trigger?: TaskTriggerLoose }) =>
    request<TaskLoose>(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  /** 内置三件套模板投影（评审 #13 单源）：与服务端 BUILTIN_TASK_DEFS 同源，提醒页模板按钮取此文案 */
  taskTemplates: () => request<{ builtin: string; title: string; instruction: string; trigger: TaskTriggerLoose; label: string }[]>("/api/tasks/templates"),
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
  /** B4（2026-09-28）：上一同长周期对照（归因句数据源） */
  lastPeriod: { count: number; total: number };
}
export interface ProgressLoose {
  streakDays: number;
  completion: { done: number; total: number; rate: number };
  weekOverWeek: { category: string; thisWeek: number; lastWeek: number; deltaPct: number | null }[];
  trend14: { date: string; count: number }[];
  /** B4（2026-09-28）：基准锚点 + 行为模式 */
  bestStreak: number;
  weeklyDone8w: { weekStart: string; done: number }[];
  hourBuckets: { morning: number; afternoon: number; evening: number; night: number };
  topCategory: { category: string; count: number } | null;
  voidedFlows: number;
  insights: string[];
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

// ── 微信桥（2026-09-27）：iLink 扫码绑定 ──────────────────
export interface WechatBindState {
  bound: boolean;
  state: "active" | "expired";
  ilinkBotId?: string;
}

export const apiIm = {
  /** 申请登录二维码（content = 要编码成二维码图形的 URL——真机实证它本身不是图片，前端用 QR 组件渲染） */
  bindQRCode: () => request<{ qrcode: string; content: string }>("/api/wechat/bind/qrcode", { method: "POST" }),
  /** 扫码状态长轮询（~35s 一轮；confirmed 即完成绑定） */
  bindStatus: (qrcode: string) => request<{ status: "wait" | "scaned" | "confirmed" | "expired" }>(`/api/wechat/bind/status?qrcode=${encodeURIComponent(qrcode)}`),
  bindState: () => request<WechatBindState>("/api/wechat/bind"),
  unbind: () => request<{ ok: boolean }>("/api/wechat/bind", { method: "DELETE" }),
  /** 「微信对话」会话当前绑定的伙伴（2026-09-28 增补）：null = 默认助手 */
  bindAgentState: () => request<{ agentId: string | null }>("/api/wechat/bind/agent"),
  /** 切换伙伴（null = 默认助手）；web 与微信同一会话，同步生效 */
  bindAgent: (agentId: string | null) =>
    request<{ ok: boolean }>("/api/wechat/bind/agent", { method: "PUT", body: JSON.stringify({ agentId }) }),
};
