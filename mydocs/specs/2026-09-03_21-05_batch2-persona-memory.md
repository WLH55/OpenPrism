# SDD Spec: 批次 2「人格与记忆」

> 状态：`[EXECUTE]`（用户已授权自动连跑：TDD 全绿 → 自动进批次 3）
> 前序：批次 1（2c2e926）。设计依据：docs/design/2026-09-app.md §D4/§4.1/§4.2/§D4b/§D5/§5.1/§5.2。

## 1. Requirements

- **Goal**: 陪伴支柱成立——多智能体三段配置 + 会话内切换伙伴 + 技能/MCP（渐进式加载）+ 长期记忆三层（自动凝练 + 全量注入 + 显式偏好窄工具）。
- **In-Scope**:
  1. 智能体 CRUD：人设卡 = 纯自由 markdown（`users/{uid}/agents/{aid}/persona.md`，名字从 H1 推导）；能力绑定 = 内置工具开关 + 技能/MCP 绑定（`binding.json`）；
  2. 会话绑定/切换伙伴：会话 meta 记 currentAgentId + 切换历史；systemPrompt() 每步按当前伙伴重取（换人设下一步生效，历史不丢）；切换落 app 级记录（UI 可画"××× 加入对话"分割线）；账本 actor.agentName = 当前伙伴名；
  3. 技能：标准 Agent Skill 目录 + SKILL.md；安装=粘贴单文件内容（git URL 导入留后）；渐进式加载 = 目录层（name+description ≤1024 字符）常驻 system prompt + `load_skill` 工具按需载正文（载入=工具事件落日志，铁律天然满足）；
  4. MCP：Streamable HTTP JSON-RPC 客户端（initialize → tools/list → tools/call），工具挂 harness 管线（exclusive）；安装=URL + 可选头，安装时连接测试一次（中危告知语义由 UI 文案承担）；仅 remote 型（本地 command 型不做，公网禁令天然满足）；
  5. 记忆三层：L1 = 会话日志复用（不新建）；L3 = `users/{uid}/memory/` 四槽位（recent/profile/scope/preferences.md）+ meta.json（lastRun）；凝练 = 以用户 BYOK adapter 跑批（读近期会话文本 + 现有记忆 → 四段 markdown，原子写）；触发 = 记忆页手动 + 自动（服务启动时若 lastRun > 20h 且有新会话则后台跑）；注入 = 四槽拼接、剥离 `[^n]` 溯源脚注，随人设进 system prompt（5.2 全量自动）；模型写 = 窄工具 `save_preference`（仅 preferences、仅显式偏好、≤240 字、一次一条，prompt 明令不要猜）；
  6. Web：伙伴页（列表+编辑器：人设 markdown + 工具/技能/MCP 绑定开关）、技能页、记忆页（四槽查看编辑 + 手动凝练 + lastRun）、聊天页伙伴切换下拉 + 切换分割线。
- **Out-of-Scope**: 定时任务/调度（批次 3）、通知通道（批次 3）、微信桥（专项调研）、git URL 技能导入、记忆工作台高级功能（audit/dedup 循环细化留后）。

## 4. Plan (Contract)

### 4.1 File Changes

- 新 `src/app/agents.ts`、`src/app/skills.ts`、`src/app/mcp.ts`、`src/app/memory.ts`
- 改 `src/app/persona.ts`（拆出 disciplineBlock + composeAssistantPrompt(persona, memoryBlock, now)）
- 改 `src/app/tools.ts`（createLedgerTools 增加工具开关过滤参数）
- 改 `src/app/conversations.ts`（会话 meta：agentId/切换史；装配按绑定组工具 + 技能目录 + load_skill + MCP + save_preference）
- 改 `src/app/server.ts`（新路由，见 4.2）
- 测试：新 `test/app-agents.test.ts`、`test/app-skills.test.ts`、`test/app-mcp.test.ts`、`test/app-memory.test.ts`；扩 `test/app-conversations.test.ts`、`test/app-server.test.ts`
- Web：新 `pages/Agents.tsx`、`pages/Skills.tsx`、`pages/Memory.tsx`；改 `App.tsx`（页签）、`Chat.tsx`（切换伙伴 + 分割线）、`api.ts`

### 4.2 Signatures（核心）

```ts
// agents.ts
export interface AgentEntry { id: string; name: string; createdTs: number; }
export interface AgentBinding { tools?: string[];          // 启用的内置工具名（缺省=全部四工具）
  skills: string[]; mcps: string[]; }                      // 绑定的技能/ MCP id
export class AgentStore {
  constructor(deps: { fileIO: FileIO; paths: AppPaths; now(): number; randomUUID(): string });
  list(uid): Promise<(AgentEntry & { binding: AgentBinding })[]>;
  create(uid, input: { persona: string; binding?: AgentBinding }): Promise<AgentEntry>;  // 名字=H1 首行 | "助手"
  persona(uid, aid): Promise<string>;                       // 不存在 throw
  updatePersona(uid, aid, markdown): Promise<AgentEntry>;   // 名字随 H1 重推导
  updateBinding(uid, aid, binding: AgentBinding): Promise<void>;
  remove(uid, aid): Promise<void>;
}
// persona.ts
export function extractAgentName(markdown: string): string;            // 首个 H1 文本；无则 ""
export function composeAssistantPrompt(input: { persona?: string; memoryBlock?: string; now(): number; tzOffsetMinutes?: number }): string;

// skills.ts（标准 Agent Skill：SKILL.md + YAML frontmatter，零依赖只解析 key: value 平面键）
export interface SkillMeta { id: string; name: string; description: string; whenToUse?: string; }
export interface ParsedSkill { name: string; description: string; whenToUse?: string; body: string; }
export function parseSkillFile(content: string): ParsedSkill;          // frontmatter + 正文；description>1024 → throw
export class SkillStore { /* list/create(content)/body(id)/remove —— users/{uid}/skills/{id}/SKILL.md + index.jsonl */ }
export function skillCatalogPrompt(skills: SkillMeta[]): string;       // 目录层文本（常驻 prompt 用）
export function createLoadSkillTool(deps: { store: SkillStore }): ToolDefinition;   // name="load_skill"，exclusive

// mcp.ts（Streamable HTTP JSON-RPC 最小客户端）
export interface McpServerConfig { id: string; name: string; url: string; headers?: Record<string,string>; }
export class McpRegistry {
  constructor(deps: { env: PlatformEnv; fileIO: FileIO; paths: AppPaths; now(): number; randomUUID(): string });
  list(uid): Promise<McpServerConfig[]>;                       // users/{uid}/mcps.json（原子写）
  add(uid, input: { name: string; url: string; headers? }): Promise<McpServerConfig>;
  remove(uid, id): Promise<void>;
  async toolsFor(uid, id): Promise<ToolDefinition[]>;          // initialize+tools/list → 包装为 exclusive 工具
}
export async function mcpCall(env: PlatformEnv, server: McpServerConfig, method: string, params?: unknown): Promise<unknown>;

// memory.ts
export const MEMORY_SLOTS = ["recent", "profile", "scope", "preferences"] as const;
export type MemorySlot = (typeof MEMORY_SLOTS)[number];
export class MemoryStore {
  constructor(deps: { fileIO: FileIO; paths: AppPaths; now(): number });
  read(uid): Promise<Record<MemorySlot, string>>;              // 缺文件=空串
  writeSlot(uid, slot, markdown): Promise<void>;               // 原子写
  meta(uid): Promise<{ lastRunTs?: number; runs: number }>;
  consolidate(input: { uid; adapter: LlmAdapter; model: string; sessionTexts: string[] }): Promise<{ changed: boolean }>;
  static stripFootnotes(markdown: string): string;             // 剥 [^n]: 行与行内 [^n] 引用
  injectionBlock(uid): Promise<string>;                        // 四槽拼接 + 剥脚注（空槽跳过）
}
export function buildConsolidationPrompt(sessionTexts: string[], currentMemory: Record<MemorySlot, string>): string;
// 返回文本约定：四段，每段以 <!-- slot: xxx --> 注释开头；解析失败 → 整体不写（fail-safe）

// conversations.ts 增量
export interface ConversationMeta { agentId: string; switches: { ts: number; agentId: string }[]; }
// ConversationStore 增：metaFor(uid,cid)、switchAgent(uid,cid,agentId)（追加 switch 记录；池内 Agent 的
// systemPrompt 闭包每步读当前 meta → 换人设下一步生效）；装配 tools = 内置(按开关) + load_skill + save_preference + MCP
```

HTTP 路由（新增）：
```
GET/POST /api/agents；GET/PUT/DELETE /api/agents/:id；PUT /api/agents/:id/persona {markdown}
GET/POST /api/skills；GET /api/skills/:id/body；DELETE /api/skills/:id
GET/POST /api/mcps；DELETE /api/mcps/:id；POST /api/mcps/:id/tools（列工具，装时测试用）
GET /api/memory；PUT /api/memory/:slot {markdown}；POST /api/memory/consolidate
GET /api/conversations/:id/meta；PUT /api/conversations/:id/agent {agentId}
```

### 4.3 Checklist（TDD：每项先红后绿）

- [ ] 1. persona.ts 拆分：extractAgentName / composeAssistantPrompt（日期+纪律+人设+记忆块）——test 并入 app-agents
- [ ] 2. agents.ts：CRUD + 名字随 H1 重推导 + binding 存取（RED→GREEN）
- [ ] 3. skills.ts：parseSkillFile（frontmatter/超长拒绝）+ SkillStore + 目录层文本 + load_skill 工具
- [ ] 4. mcp.ts：JSON-RPC POST + SSE 响应解析 + fake MCP 服务器测试夹具 + toolsFor 包装（exclusive、execute→tools/call、错误 isError 化由管线承担）
- [ ] 5. memory.ts：stripFootnotes、read/writeSlot 原子写、buildConsolidationPrompt、consolidate（mock adapter：四段输出→落盘+meta；坏输出不落）、injectionBlock
- [ ] 6. tools.ts 开关过滤 + save_preference 窄工具（>240 字 throw；非 preferences 槽不存在）
- [ ] 7. conversations.ts：meta/切换/装配（测试：切换后新 Turn 的 systemPrompt 指纹变化、actor.agentName=新伙伴、绑定关掉的工具不在请求 tools 里——mock adapter.requests 断言）
- [ ] 8. server.ts 新路由 + 集成测试（含 404/400 边界、memory consolidate 走注入 adapter）
- [ ] 9. web：Agents/Skills/Memory 三页 + Chat 切换伙伴与分割线 + api.ts 扩展
- [ ] 10. 全量 typecheck/test（根+web）绿 → commit 批次 2 → 自动进批次 3 spec

### 4.4 风险

- MCP 实现多样性（Streamable HTTP 各家差异）：只实现 POST JSON + SSE/JSON 双解析，连接失败在安装时暴露；不做 resumable/进度通知。
- 凝练质量：fail-safe（解析失败不落盘），首版不追 audit/dedup 精细度。
- 自动凝练的触发用"启动时惰性检查"而非定时器（定时器归批次 3 调度器，届时复用）。

## 5. Execute Log（2026-09-03，批量 TDD 红→绿）

- [x] 1+2. `test/app-agents.test.ts`（RED→GREEN 8+5）→ persona.ts 拆分（extractAgentName/composeAssistantPrompt/defaultAssistantPrompt 兼容出口）+ agents.ts CRUD。
- [x] 3. `test/app-skills.test.ts`（6）→ skills.ts。过程修正：markdown 正文改原样读写（FileIO.readAll 的 JSONL 滤空行语义会压扁正文）——persona/skill 一律 node:fs 原样。
- [x] 4. `test/app-mcp.test.ts`（3，真实 node:http fake 服务器 ×2：JSON + SSE）→ mcp.ts；RED 以"摘除实现"方式补观察（test 先写但未先跑红，已记录为流程小滑步）。
- [x] 5. `test/app-memory.test.ts`（7）→ memory.ts（stripFootnotes/buildConsolidationPrompt/consolidate fail-safe/appendPreference/syncInjectionBlock）。
- [x] 6. save_preference 窄工具随 memory.ts 落地（存储面 appendPreference 已红绿；工具壳 8 行测试后补，记偏差）。
- [x] 7. `test/app-conversations.test.ts` 重写（7：批次1 回归 2 + 伙伴/装配 5）→ conversations.ts（meta.json、switchAgent、每步同步重读人设/记忆/技能目录、绑定装配）。
- [x] 8. server.ts 批次 2 路由 + `test/app-server.test.ts` 13（含 agents/skills/mcps/memory/切换全链路；consolidate 走注入 mock adapter 零网络）；main.ts 装配 + 启动惰性自动凝练（>20h 且有会话）。
- [x] 9. web：Agents/Skills/Memory 三页 + Chat 伙伴下拉切换与"××× 加入对话"分割线 + App 六页签 + api2。
- [x] 10. 根 163 tests 全绿（20 文件）+ 根/web typecheck 0 错 + web build 过 → commit。

## 6. Review Verdict

| 轴 | 结论 | 证据 |
|---|---|---|
| Spec 质量 & 需求达成 | **PASS** | In-Scope 六项全落地：三段配置/切换/技能渐进加载/MCP 客户端/记忆三层+注入/偏好窄工具；163 tests 含行为断言（systemPrompt 指纹、tools 集合、脚注剥离、fail-safe） |
| Spec-代码一致性 | **PASS（偏差已记）** | 见 §7；无未声明偏差 |
| 代码自身质量 | **PASS** | 零网络测试（fake MCP 服务器、mock adapter）；harness 仍零改动；Key 不涉（本批无新密钥面） |

- Overall Verdict: **PASS** · Blocking Issues: 无 · Regression risk: Low（全增量文件+装配扩展）
- Follow-ups：① MCP 会话头（Mcp-Session-Id）解析了但未回传使用——各家 server 需要时再补；② 绑定（工具/技能/MCP 集合）装配期快照，改绑定对新会话/重启生效（人设/记忆/目录则每步热更）——设计只要求人设每步重取，已满足；③ git URL 技能导入、微信桥、MCP stdio 均 Out-of-Scope 不做。

## 7. Plan-Execution Diff

1. 工具开关过滤放装配层（conversations filter）而非 tools.ts 加参——更少侵入。
2. save_preference 落在 memory.ts（依赖 MemoryStore），spec 原写在 tools.ts。
3. mcp RED 以摘除法补观察（测试先写、未先看红）——流程偏差，其余各项严格红→绿。
4. 正文存储改 node:fs 原样读写（FileIO JSONL 语义滤空行，压扁 markdown）。
5. main.ts 的 adapterFor/consolidate 采集逻辑与 server 路由内联重复一份（入口自治 vs 路由复用各留一份，批 3 调度器复用时再收敛）。

## 8. Archive Record

- 已随批次 2 提交入库；正式 archive 待批次 3–4 完成后统一执行。
