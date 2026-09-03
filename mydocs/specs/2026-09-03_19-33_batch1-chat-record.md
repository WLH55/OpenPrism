# SDD Spec: 批次 1「能聊能记」（最小闭环）

> 状态：`[PLAN]` · `[LOCKED]`（未收到 "Plan Approved" 不写代码）
> 真相源优先级：本 spec > 聊天 > 代码记忆；冲突以本 spec 为准。

## 0. Open Questions

- [x] ~~OQ-1 服务器技术栈~~ → **已裁决（2026-09-03 用户选定）**：Node 原生 `node:http` + SSE 单向流式，零运行时依赖（scrypt/AES 用 `node:crypto`）。
- [x] ~~OQ-2 Web 客户端工程~~ → **已裁决（2026-09-03 用户选定）**：React + Vite，独立 `web/` 子包（自己的 package.json，不污染根 harness 库依赖）。
- [x] ~~OQ-3 依赖策略~~ → **已裁决**：服务器零运行时依赖（Node 内置）；客户端 React/Vite 仅 devDependencies + 打包产物，自部署由服务器静态托管 `web/dist`。

## 1. Requirements (Context)

- **Goal**: 实现批次 1「能聊能记」最小闭环——注册 → 登录 → 聊天（流式、思维链显隐）→ 记账 → 今天页看见数据。对应设计 KR3「闭环端到端可用」。
- **Acceptance（验收）**：
  1. `pnpm test` 与 `pnpm typecheck` 全绿（含 app 层新测试）；
  2. E2E 手工冒烟：注册 → 登录 → 设置页配模型 → 聊天中说"中午吃面花了28" → 聊天流式返回 + 工具回执可见 → 今天页出现该笔流水（0 token 折叠）→ 快速记录/作废可用；
  3. `users/{uid}/life.jsonl` 只追加；作废以 void 事件表达，无原地改写；
  4. Key 落盘为 AES-256-GCM 密文，任何 API 不回传明文 Key；会话日志/账本不含 Key。
- **In-Scope**（批次 1 详单，设计纪要 §D3）：
  1. 服务器核心：Node 进程装 harness + 每用户账本（`users/{uid}/` 隔离），HTTP API + SSE 流式；
  2. 登录注册：用户名/密码慢哈希，注册即建用户沙盒；
  3. Web 客户端工程版：登录页 + 聊天页 + 今天页 + 模型设置页（极简）；
  4. 内置默认助手 + 四录入工具（记流水 / 建计划 / 打卡 / 查询）——模型只能经工具写账本；
  5. 模型接入：设置页配 baseURL + Key（BYOK 自部署），Key 服务端加密落盘。
- **Out-of-Scope**（后续批次，禁止本 spec 混入）：多智能体（三段配置）、技能/MCP、长期记忆（三层）、定时任务（离线回合）、通知通道、分类页/进步页面板成品化、公网 Key 政策、记忆注入。

## 1.1 Context Sources

- Requirement Source: `docs/design/2026-09-app.md`（§D3 批次 1 详单、§D2 数据原语、§D2b 存储裁决、§D7 面板）
- Design Refs: `docs/design/2026-09-harness.md`（harness 设计）、`docs/adr/0007-multi-user-self-hostable.md`
- Glossary: `CONTEXT.md`
- UI Prototype: `prototype/index.html`（登录/聊天/今天页视觉基准，工程版复刻）
- Harness API: `src/harness/index.ts`（公共出口）

## 1.5 Codemap Used

- Codemap Mode: `feature`（app 层消费 harness 公共面；harness 内部 79 测试全绿，不重画）
- 关键索引（已逐一核实源码）：
  - **循环机器** `createAgent(config: AgentConfig): Agent` — `followup/steer/inject/cancel/whenIdle/compact/subscribe`；`AgentConfig` = `{ env, sessionLog?, adapter, model, systemPrompt(), tools?, maxStepsPerTurn?, retry?, compaction?, onRequest?, onTurnStopping? }`。
  - **会话日志** `SessionLog { append(payload, ts?) → SessionEvent; readAll(); subscribe(cb) }`；`JsonlSessionLog.open(fileIO, path, now?)`（seq 从盘上最后一条续排）；`InMemorySessionLog`。
  - **事件词表** `SessionEventPayload` 九事件（turn/start|end、user/message、assistant/message、tool/call、tool/result、llm/retry、compaction/summary、request/header）。
  - **适配器** `createOpenAICompatAdapter(env, { baseURL, apiKey, stream?, idleTimeoutMs?, extraHeaders? })`；`createMockLlmAdapter(script)`。
  - **工具契约** `ToolDefinition { name, description, parameters: JsonSchema, output: { schema, render(args, value): ContentBlock[] }, execute(args, ctx): Promise<unknown>, timeoutMs?, isConcurrencySafe?, concludeTurn? }`——execute 返回 canonical JSON value，registry 负责校验与渲染。
  - **平台缝** `PlatformEnv { fetch, now(), randomUUID() }`、`FileIO { appendLine(path, line), readAll(path) }`——app 层提供 Node 实现。
  - **活体事件** `AgentLiveEvent`（status/text-delta/reasoning-delta/assistant/tool-call/tool-result/retry/compaction/budget-exhausted/turn-end/error）——SSE 直接序列化此类型。

## 2. Research Findings

- **F1 分工边界**：`src/harness/` 铁律零平台依赖不动；app 层新建 `src/app/`（可用 Node fs/crypto/http）。客户端独立 `web/` 子包。
- **F2 数据原语（§D2）**：五原语——流水(event)/计划(plan)/打卡(check-in)/对话(conversation)/记忆(memory)。批次 1 用：流水/计划/打卡 + 更正(void)；对话原语 = 会话日志本身（已由 harness 承担）；记忆留批次 2。**流水记"发生了什么"，打卡认证"计划做了没"**，不混。
- **F3 账本形态（§D2b）**：`users/{uid}/life.jsonl` 只追加；单进程串行写队列；启动全量载入内存；面板 = 确定性折叠（0 token）。
- **F4 登录注册（§D2b/ADR 0007）**：scrypt 慢哈希 + 常量时间比较；注册即建 `users/{uid}/` 沙盒；会话 cookie（httpOnly）。
- **F5 BYOK（§Q8）**：Key 只发往用户配置的 baseURL；落盘 AES-256-GCM 密文（主密钥 `data/secret.key` 自动生成，`data/` 已在 .gitignore）；API 永不回传明文。
- **F6 四工具（§D3.4）**：模型只能经工具写账本（同源铁律）；UI 是另一写入方（`source: "ui"`）。
- **F7 流式**：`AgentLiveEvent` 已有 text/reasoning delta；SSE 逐事件 JSON 推送；思维链只展示不回传（harness 保证）。
- **F8 依赖现状**：根 `package.json` 零运行时依赖、`type: module`、仅 typescript+vitest devDeps；`data/`、`*.local` 已被 .gitignore 覆盖。
- **F9 会话归属**：每会话一个 `JsonlSessionLog`（`users/{uid}/conversations/{cid}/session.jsonl`）；批次 1 单默认助手，`systemPrompt()` = 内置人设 + 当前日期 + 工具纪律说明。

## 2.1 Next Actions

1. ~~技术选型~~ 已收口（§0）。
2. ~~进入 PLAN~~ 本节即 Plan（§4）。

## 3. Innovate (Optional: Options & Decision)

### Skip

- Skipped: true
- Reason: 架构选项已在设计阶段逐项裁决（存储=JSONL 引擎可换 ADR 0007；BYOK=Q8；数据原语=D2；工具同源铁律=D3.4；技术栈=OQ-1/2/3 用户拍板），本任务无遗留方案权衡，直接 Plan。

## 4. Plan (Contract)

### 4.0 架构总览

```
浏览器 (web/ React+Vite)
  │  HTTP JSON + SSE
  ▼
src/app/server.ts (node:http, 零运行时依赖)
  ├─ auth.ts      注册/登录（scrypt + cookie 会话）
  ├─ secretbox.ts BYOK Key 加密（AES-256-GCM）
  ├─ ledger.ts    users/{uid}/life.jsonl（串行追加 + 全量内存镜像）
  ├─ fold.ts      今天页确定性折叠（0 token）
  ├─ tools.ts     四录入工具（ToolDefinition）
  ├─ persona.ts   默认助手 systemPrompt()
  ├─ conversations.ts  会话管理（Agent 实例池 + JsonlSessionLog）
  └─ env.ts/store.ts   Node PlatformEnv/FileIO + 数据目录布局
全部经 src/harness/ 公共出口复用循环机器。
```

数据目录布局（根 `data/`，已 gitignore）：

```
data/
  secret.key                     # 32B 主密钥（首次启动生成）
  users.jsonl                    # 追加式用户注册记录
  users/{uid}/
    life.jsonl                   # 账本（只追加）
    model.json                   # { baseURL, model, keyEnc }（keyEnc = AES-GCM 密文）
    conversations/{cid}/session.jsonl   # 会话日志（harness 九事件）
```

### 4.1 File Changes

**服务器（`src/app/`，全部新文件）**

- `src/app/env.ts`：Node 平台缝实现。
- `src/app/store.ts`：数据目录布局与用户沙盒创建。
- `src/app/auth.ts`：密码哈希与会话令牌。
- `src/app/secretbox.ts`：Key 加密封解。
- `src/app/ledger.ts`：账本（事件模型 + 串行写队列）。
- `src/app/fold.ts`：今天页折叠。
- `src/app/tools.ts`：四录入工具。
- `src/app/persona.ts`：默认助手人设。
- `src/app/conversations.ts`：会话池与 Agent 装配。
- `src/app/server.ts`：HTTP 路由 + SSE + 静态托管 `web/dist`。
- `src/app/index.ts`：app 层出口（供测试 import）。
- `package.json`：scripts 增 `dev:server` / `build:web` / `start`。

**测试（`test/`，新文件）**

- `test/app-auth.test.ts`、`test/app-secretbox.test.ts`、`test/app-ledger.test.ts`、`test/app-fold.test.ts`、`test/app-tools.test.ts`、`test/app-server.test.ts`（HTTP 集成：mock adapter 注入）。

**客户端（`web/` 子包，全部新文件）**

- `web/package.json`、`web/vite.config.ts`（dev 代理 `/api` → `http://localhost:8787`）、`web/tsconfig.json`、`web/index.html`。
- `web/src/main.tsx`、`web/src/App.tsx`（登录门 + 页切换）、`web/src/api.ts`（fetch + SSE 封装）、`web/src/theme.css`（深林墨绿 token，自 prototype 移植）。
- `web/src/pages/Login.tsx`、`web/src/pages/Chat.tsx`、`web/src/pages/Today.tsx`、`web/src/pages/Settings.tsx`。

### 4.2 Signatures

**`src/app/env.ts`**

```ts
export const nodeEnv: PlatformEnv;                    // fetch: 全局 fetch；now: Date.now；randomUUID: crypto.randomUUID
export const nodeFileIO: FileIO;                      // appendLine: fs.appendFile；readAll: fs.readFile 按行拆
```

**`src/app/store.ts`**

```ts
export interface AppPaths { dataRoot: string; usersFile: string; userDir(uid: string): string;
  lifeFile(uid: string): string; modelFile(uid: string): string; convDir(uid: string, cid: string): string; }
export function appPaths(dataRoot: string): AppPaths;
export async function ensureUserSandbox(fileIO: FileIO, paths: AppPaths, uid: string): Promise<void>;
```

**`src/app/auth.ts`**（时钟/随机注入，确定性测试铁律 5）

```ts
export interface PasswordRecord { salt: string; hash: string; }   // hex；scrypt N=16384,r=8,p=1,keylen=64
export function hashPassword(password: string, salt?: string): Promise<PasswordRecord>;
export function verifyPassword(password: string, record: PasswordRecord): Promise<boolean>;  // timingSafeEqual
export interface UserRecord { uid: string; username: string; password: PasswordRecord; createdTs: number; }
export function loadUsers(fileIO: FileIO, usersFile: string): Promise<Map<string, UserRecord>>;  // key=username
export function appendUser(fileIO: FileIO, usersFile: string, user: UserRecord): Promise<void>;
export class SessionStore {
  constructor(now: () => number, ttlMs?: number);     // 默认 30 天
  issue(uid: string): string;                        // 48hex 随机令牌
  verify(token: string | undefined): string | null;  // → uid（过期/未知 → null）
  revoke(token: string): void;
}
```

**`src/app/secretbox.ts`**

```ts
export async function loadOrCreateMasterKey(dataRoot: string): Promise<Buffer>;  // 32B；data/secret.key
export function seal(master: Buffer, plain: string): string;   // base64(iv[12] ‖ tag[16] ‖ cipher) AES-256-GCM
export function open(master: Buffer, sealed: string): string;  // 篡改/损坏 → throw
export interface ModelConfig { baseURL: string; model: string; keyEnc?: string; }
export async function readModelConfig(fileIO: FileIO, path: string): Promise<ModelConfig | null>;
export async function writeModelConfig(fileIO: FileIO, path: string, config: ModelConfig): Promise<void>;  // 原子写（tmp+rename）
```

**`src/app/ledger.ts`**（账本事件模型 = 可折叠骨架定死、内容自由）

```ts
export type LedgerSource = "agent" | "ui";
export type FlowKind = "event" | "plan" | "checkin" | "void";
export interface LedgerEventBase { seq: number; ts: number; source: LedgerSource;
  actor?: { conversationId?: string; agentName?: string }; }
export interface FlowRecord   extends LedgerEventBase { kind: "event";   time: number; category: string;
  note?: string; value?: number; unit?: string; attrs?: Record<string, string | number>; }
export interface PlanRecord   extends LedgerEventBase { kind: "plan";   planId: string; title: string;
  scope: "day" | "week" | "month" | "year" | "ndays" | "deadline"; due?: string; ndays?: number; }
export interface CheckinRecord extends LedgerEventBase { kind: "checkin"; planId: string; at: number; done: boolean; }
export interface VoidRecord    extends LedgerEventBase { kind: "void";  targetSeq: number; reason?: string; }
export type LedgerRecord = FlowRecord | PlanRecord | CheckinRecord | VoidRecord;

export class Ledger {
  static async open(fileIO: FileIO, path: string): Promise<Ledger>;  // 全量载入 + nextSeq 续排
  append(record: Omit<LedgerRecord, "seq" | "ts">, ts?: number): Promise<LedgerRecord>;  // 内部串行队列
  readAll(): LedgerRecord[];
  activeRecords(): LedgerRecord[];   // 折叠入口：剔除被 void 的 targetSeq
}
```

**`src/app/fold.ts`**（确定性纯函数，0 token）

```ts
export interface TodayPlanView { planId: string; title: string; scope: PlanRecord["scope"]; due?: string;
  done: boolean; checkinTs?: number; }
export interface TodayFlowView { seq: number; time: number; category: string; note?: string;
  value?: number; unit?: string; }
export interface TodayView { date: string; flows: TodayFlowView[]; plans: TodayPlanView[];
  totalByCategory: { category: string; total: number; count: number }[]; streakDays: number; }
export function todayView(records: LedgerRecord[], now: number, tzOffsetMinutes?: number): TodayView;
// plans：scope 覆盖今天且未被 void；done = 存在 planId 匹配且 at 在今天且 done=true 的 checkin
// streakDays：按自然日（用户时区）连续有流水的天数，含今天
export function planScopeCoversToday(plan: PlanRecord, now: number, tzOffsetMinutes?: number): boolean;
```

**`src/app/tools.ts`**（四工具，全部 bind 到 Ledger；execute 返回 canonical value）

```ts
export function createLedgerTools(deps: { ledger: Ledger; now: () => number;
  actor?: () => { conversationId?: string; agentName?: string } }): ToolDefinition[];
// 工具 1  record_flow   { time?: string(ISO HH:mm), category: string, note?: string, value?: number, unit?: string }
//        → { seq, time, category }；缺 time 用 now
// 工具 2  create_plan   { title, scope, due?(YYYY-MM-DD), ndays? } → { planId, title }
// 工具 3  checkin_plan  { planId, done? = true } → { planId, done, at }；planId 不存在 → isError（schema 校验外由 execute 抛错）
// 工具 4  query_ledger  { what: "today" | "plans" | "flows", category?, from?, to? }
//        → 复用 fold 的确定性结果（query 是 read，不写账）
```

**`src/app/persona.ts`**

```ts
export function defaultAssistantPrompt(deps: { now: () => number; tzOffsetMinutes?: number }): string;
// 内置默认助手（批次 1 无自定义人设）：身份=生活记录助理；日期注入（防模型日期算术错）；
// 工具纪律=写账只能调工具、金额单位谨慎、不确定就问；零预设（不举任何默认分类）。
```

**`src/app/conversations.ts`**

```ts
export interface ConversationDeps { env: PlatformEnv; fileIO: FileIO; paths: AppPaths;
  ledgerFor(uid: string): Ledger; modelConfigFor(uid: string): Promise<ModelConfig | null>;
  adapterFactory(uid: string, config: ModelConfig): LlmAdapter;  // 测试注 mock；生产 openai-compat + open()
  now(): number; }
export interface ConversationEntry { id: string; title: string; createdTs: number; }
export class ConversationStore {
  constructor(deps: ConversationDeps);
  list(uid: string): Promise<ConversationEntry[]>;        // 读 users/{uid}/conversations/index.jsonl
  create(uid: string, title?: string): Promise<ConversationEntry>;  // 首条用户消息后定标题
  async agent(uid: string, cid: string): Promise<Agent>;   // 池化：Map<uid:cid, Agent> 惰性装配
  // 装配 = JsonlSessionLog.open + createLedgerTools(ledger, actor=cid) + defaultAssistantPrompt
  //        + adapterFactory + createAgent({ maxStepsPerTurn: 24 })
  send(uid: string, cid: string, text: string): Promise<void>;  // agent.followup
}
```

**`src/app/server.ts`**

```ts
export interface ServerDeps { env: PlatformEnv; fileIO: FileIO; paths: AppPaths;
  conversationsFor: (deps: ConversationDeps) => ConversationStore;  // 生产实现；测试换 mock adapterFactory
  staticDir?: string; port?: number; }
export function createAppServer(deps: ServerDeps): http.Server;
// 路由（全部挂 /api；未登录 → 401 JSON）：
//   POST /api/auth/register { username, password }        → 建沙盒 + 发 cookie（用户名冲突 409）
//   POST /api/auth/login    { username, password }        → 发 cookie
//   POST /api/auth/logout                                  → revoke
//   GET  /api/auth/me                                      → { uid, username }
//   GET  /api/model            → { baseURL, model, hasKey }   （永不回 keyEnc/明文）
//   PUT  /api/model            { baseURL, apiKey?, model }    （apiKey 缺省 = 不变）
//   POST /api/model/test       → 用当前配置发一次 1-token 请求，返回 ok/错误码
//   GET  /api/conversations    → ConversationEntry[]
//   POST /api/conversations    { title? } → ConversationEntry
//   GET  /api/conversations/:id/events → SessionEvent[]（UI 重放水合）
//   POST /api/conversations/:id/messages { text } → 202
//   GET  /api/conversations/:id/stream   → SSE（AgentLiveEvent 序列化 JSON；连接即回放日志尾部状态）
//   GET  /api/today            → TodayView
//   POST /api/flows            { category, note?, value?, unit?, time? } → source:"ui" 快速记录
//   POST /api/void             { seq } → source:"ui" 作废
//   POST /api/checkin          { planId, done? } → source:"ui" 打卡（今天页打卡态闭环；Reverse Sync 2026-09-03 补——原清单漏了 UI 打卡端点，模型端 checkin_plan 工具无法覆盖"用户自己点勾"场景）
//   GET  /api/health
// cookie：op_session；httpOnly; SameSite=Lax; Path=/
// 静态：GET / → web/dist（存在时）；CORS：dev 下同源代理，无需 CORS 头
export async function startServer(deps: ServerDeps): Promise<{ server: http.Server; port: number }>;
```

**`package.json` scripts**

```json
"dev:server": "node --experimental-strip-types --watch src/app/main.ts",
"dev:web": "pnpm --dir web dev",
"build:web": "pnpm --dir web build",
"start": "node --experimental-strip-types src/app/main.ts"
```

（`src/app/main.ts`：读 `OP_DATA`(默认 `./data`)、`OP_PORT`(默认 8787)，startServer + 启动日志。）

**客户端 API（`web/src/api.ts`）**

```ts
export const api = {
  register(username: string, password: string): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  me(): Promise<{ uid: string; username: string } | null>;
  getModel(): Promise<{ baseURL: string; model: string; hasKey: boolean }>;
  putModel(input: { baseURL: string; apiKey?: string; model: string }): Promise<void>;
  testModel(): Promise<{ ok: boolean; error?: string }>;
  listConversations(): Promise<ConversationEntry[]>;
  createConversation(title?: string): Promise<ConversationEntry>;
  conversationEvents(cid: string): Promise<SessionEvent[]>;
  sendMessage(cid: string, text: string): Promise<void>;
  today(): Promise<TodayView>;
  quickFlow(input: { category: string; note?: string; value?: number; unit?: string }): Promise<void>;
  voidRecord(seq: number): Promise<void>;
};
export function openConversationStream(cid: string, onEvent: (e: AgentLiveEvent) => void): () => void;  // EventSource
```

### 4.3 Implementation Checklist

- [ ] 1. `src/app/env.ts` + `src/app/store.ts`（Node 平台缝 + 目录布局 + ensureUserSandbox）
- [ ] 2. `src/app/auth.ts` + `test/app-auth.test.ts`（scrypt 往返、timingSafe、SessionStore TTL 用注入 now）
- [ ] 3. `src/app/secretbox.ts` + `test/app-secretbox.test.ts`（seal/open 往返、篡改 throw、model.json 原子写）
- [ ] 4. `src/app/ledger.ts` + `test/app-ledger.test.ts`（四 record 追加、串行队列顺序、void 剔除 activeRecords、重启 nextSeq 续排、奇行容错跳过）
- [ ] 5. `src/app/fold.ts` + `test/app-fold.test.ts`（todayView：今日流水/计划打卡态/分类合计/streak，固定 now 断言，时区参数化）
- [ ] 6. `src/app/tools.ts` + `test/app-tools.test.ts`（四工具 schema 校验 + execute 落账 + checkin 未知 planId isError + query 复用 fold）
- [ ] 7. `src/app/persona.ts`（纯函数，日期注入格式快照断言并入 tools 测试文件）
- [ ] 8. `src/app/conversations.ts`（池化装配 + send；用 mock adapter 单测：followup → mock 回复落日志 → ledger 落 source:"agent" 流水，验"模型可见即日志可重建"）
- [ ] 9. `src/app/server.ts` + `src/app/main.ts` + `test/app-server.test.ts`（真实 http 监听 127.0.0.1 随机端口：注册→登录→401 门→会话消息→SSE 收到 assistant 事件→/api/today 折叠→quickFlow/void；全 mock adapter）
- [ ] 10. `pnpm typecheck` + `pnpm test` 全绿
- [ ] 11. `web/` 脚手架（Vite React TS + 代理 + theme.css 移植）
- [ ] 12. `web/src/api.ts` + `App.tsx` 登录门 + `Login.tsx`（登录/注册切换）
- [ ] 13. `Chat.tsx`（会话列表 + SSE 流式渲染 + 思维链折叠 + 工具回执卡片 + 会话日志水合重放）
- [ ] 14. `Today.tsx`（三卡 + 今日计划打卡态 + 流水列表 + 快速记录 + 作废）
- [ ] 15. `Settings.tsx`（baseURL/Key/模型 + 测试连接；Key 输入后不回显）
- [ ] 16. 真实厂商 E2E 手工冒烟（.env.local 的 DeepSeek Key 走 `PUT /api/model`，验证完整闭环），然后 `pnpm typecheck && pnpm test` 终检
- [ ] 17. 回写 Execute Log + Review（三轴）+ 提交 commit

### 4.4 风险与回滚

- **R1 SSE 经代理**：dev 用 Vite 代理 `/api`，SSE 需关闭代理缓冲（`configure: proxy → proxyRes headers cache-control: no-cache`）；若仍缓冲，dev 直连 8787。验证点在 checklist 13。
- **R2 Node 类型剥离**：`--experimental-strip-types` 需 Node ≥22.6；启动脚本检测失败时回退方案 = tsc 编译 `dist/` 再 node 运行（不引运行时依赖）。checklist 9 时验证本机 Node 版本。
- **R3 并发写**：Ledger.append 内部 promise 链串行（F3）；同一会话 Agent 单实例池化天然串行；不同会话并行不冲突（账本串行队列兜底）。
- **R4 回滚**：app 层全为新文件，`git revert` 单 commit 即回滚；harness 零改动。

## 5. Execute Log

- 2026-09-03 · `[EXECUTE]` 启动（用户 "Plan Approved"），默认逐步模式。
- **过程纠正（2026-09-03，用户指出"有没有按照 TDD"）**：第 1 项初版先写实现后无测试，违反 TDD 铁律（test-driven-development skill：code before test → delete, start over）。已删除 `env.ts`/`store.ts` 原实现，按 红→绿 重做。
- [x] 1. `test/app-store.test.ts`（RED 确认：模块缺失失败）→ `src/app/env.ts` + `src/app/store.ts` 最小实现（GREEN：6/6）。全量 85 passed + typecheck 绿。`tsconfig.include` 增 `src/app`。
  - **TDD 纪律（自本条起对 checklist 全项生效）**：每项先写失败测试并亲眼看它红，再写最小实现看它绿；实现已存在而测试未红 = 删除重来。
  - 实现备注：`nodeFileIO.appendLine` 自带父目录 mkdir；`readAll` ENOENT → `[]`、其余 IO 错误照抛；`ensureUserSandbox(paths, uid)` 签名不含 FileIO（mkdir 直用 node:fs）。
  - **已识别偏差（待第 9 项落定）**：R2 的 `node --experimental-strip-types` 不可行——harness 内部相对导入无扩展名，Node ESM 直跑整图必挂。改为 devDep `tsx` 作为加载器跑 `main.ts`（运行时依赖仍为零），届时同步改 package.json scripts 并记入 §7 Diff。
- [x] 2. `test/app-auth.test.ts`（RED：模块缺失）→ `src/app/auth.ts`（GREEN：7/7）。全量 92 passed + typecheck 绿。
  - 覆盖：scrypt 同盐复现/异盐不同哈希、timingSafe 往返、注册表 JSONL 往返 + 坏行跳过、SessionStore 48hex 令牌/到期/撤销（时钟注入，无真实计时）。
- 2026-09-03 · 用户「全部」→ 批量模式（优先级高于逐步 STOP-AND-WAIT），TDD 纪律不变。
- [x] 3. `test/app-secretbox.test.ts`（RED）→ `src/app/secretbox.ts`（GREEN 6/6）。
- [x] 4. `test/app-ledger.test.ts`（RED）→ `src/app/ledger.ts`（GREEN 5/5；联合 Omit 不分发 → `LedgerAppend` 逐成员 Omit）。
- [x] 5. `test/app-fold.test.ts`（RED）→ `src/app/fold.ts`（GREEN 11/11；修正两处测试夹具错误：day 计划误建昨日、月边界期望值）。
- [x] 6+7. `test/app-tools.test.ts`（RED）→ `src/app/tools.ts` + `src/app/persona.ts`（GREEN 8/8；checkin `at` 统一注入时钟）。
- [x] 8. `test/app-conversations.test.ts`（RED）→ `src/app/conversations.ts`（GREEN 2/2；`ledgerFor` 改异步，见 §7）。
- [x] 9. `test/app-server.test.ts`（RED 8 用例）→ `src/app/server.ts` + `src/app/main.ts`（GREEN 8/8；tsx 装 devDep、scripts 就位）。
- [x] 10. 全量 132 passed（16 文件）+ 根/web typecheck 双 0 错。
- [x] 11. `web/` 脚手架（Vite 6 + React 18 + 代理 + theme.css 自原型移植）。
- [x] 12. `api.ts` + `App.tsx`（登录门/页签/明暗/退出）+ `pages/Login.tsx`。
- [x] 13. `pages/Chat.tsx`（SSE 流式增量 + 思维链折叠 + 工具回执 + 日志重放 + 409 引导横幅）。
- [x] 14. `pages/Today.tsx`（三卡 + 快速记录 + 计划打卡切换 + 流水作废）。
- [x] 15. `pages/Settings.tsx`（BYOK 表单 + hasKey 占位 + 测试连接）。
- [x] 16. 真实厂商 E2E 冒烟（DeepSeek `deepseek-v4-flash`，curl 全链路，Key 只经 shell 环境变量、未落任何输出/日志）：注册 → PUT /api/model → GET 只回 hasKey → 建会话 → 发消息「午饭牛肉面 30」→ 模型调 `record_flow` → turn/end completed → `/api/today` 出现 `餐饮 30 牛肉面`、streak 1 → SSE 回 status 事件。冒烟数据已清理。
- [x] 17. Review 三轴见 §6，偏差见 §7，提交见 §8。

## 6. Review Verdict

- Review Matrix（2026-09-03，三轴强制评审）：

| 轴 | 关键检查 | 结论 | 证据 |
|---|---|---|---|
| Spec 质量 & 需求达成 | Goal/In-Scope/Acceptance 完整可验证；四条验收逐条对照 | **PASS** | ①16 文件 132 tests 全绿 + 根/web typecheck 0 错；②真实厂商 E2E 全链路通过（§5 条 16）；③只追加 + void 更正回路有专测（app-ledger）；④Key AES-GCM 落盘、GET /api/model 断言不回明文、日志/账本无 Key（app-secretbox + app-server） |
| Spec-代码一致性 | File Changes / Signatures / Checklist 对照 | **PASS（含已记录偏差）** | 17 项全完成；偏差 6 条全部记录于 §7，无未声明偏差 |
| 代码自身质量 | 正确性/鲁棒/可维护/测试/安全 | **PASS（低风险备注）** | 零网络测试（mock adapter + modelTester 注入）；时钟全注入；scrypt+timingSafe、AES-GCM、HttpOnly cookie、静态路径穿越防护、body 上限、用户名不进路径；harness 零改动 |

- Overall Verdict: **PASS**
- Blocking Issues: 无
- Regression risk: **Low**（app 层全为新文件、harness 未动；回滚 = revert 单 commit）
- Follow-ups（不阻塞）：
  1. 会话令牌内存态（重启全员下线）——自部署可接受，公网前持久化；
  2. 认证端点无速率限制——批次 4 公网硬化；
  3. server 按 uid 查用户线性扫描——用户量上来加索引；
  4. 会话标题固定「新对话」——批次 2 首条消息自动命名；
  5. 冒烟中模型自述收到乱码 = Windows curl 客户端编码问题（浏览器/JSON 路径无此问题）——不修。

## 7. Plan-Execution Diff

1. **R2 落地为 tsx**：`--experimental-strip-types` 加载不了无扩展名导入的 harness 图 → devDep `tsx`（运行时依赖仍为零）。
2. **`ledgerFor` 同步 → 异步**（ServerDeps 与 ConversationDeps）：`Ledger.open` 天然异步；宿主侧 `Map<uid, Promise<Ledger>>` 缓存同实例。
3. **`ensureUserSandbox(paths, uid)`**：去掉多余的 FileIO 参数。
4. **新增 `POST /api/checkin`**：spec 漏了 UI 打卡端点，先反向同步 §4.2 再实现。
5. **ServerDeps 形态**：`conversationsFor` 工厂 → 直接传 `conversations` + 显式 `users`/`sessions`/`masterKey`/`modelTester?`。
6. **main.ts 未用 `startServer()`**：直接 `createAppServer` + `listen`（`startServer` 保留导出，入口自管 SIGINT）。

## 8. Archive Record

- spec 已随批次 1 提交入库；正式 `archive` 待批次 1 经日常真实使用验收后执行。
