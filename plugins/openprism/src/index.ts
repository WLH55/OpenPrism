/**
 * OpenPrism —— DeepSeek Harness (dsh) 组合包：对话即录入的个人生活面板（六维度）。
 *
 * 架构（v0.4，全局事件日志版，docs/design/2026-08-feature-design.md + ADR 0002/0003）：
 * - 唯一持久层 = append-only 全局事件日志（`$DSH_HOME/openprism/events.jsonl`）；
 *   storage-domain 四张表废弃，工具 execute 不写记录——记录由镜像器从会话日志的
 *   `tool/call`（openprism_*）以确定性 id 落库（3.1），会话日志即录入凭据；
 * - 分类、目标等非会话写入直接追加日志，带 source（mirror/ui/internal/extraction/rule）
 *   与可选 channel（3.3）；
 * - 面板/汇总从日志折叠（fold.ts），旧的「同版本加表」与快照迁移全部消失；
 * - POST /openprism/rebuild 可从 `$DSH_HOME/sessions` 全量重建 mirror 事件（3.3）。
 *
 * 【零声明的 dsh 依赖】本包不声明任何 @deepseek-ai/* 依赖（peer 也不声明），
 * 类型检查用 devDependencies——避免 profile 遮蔽副本的双实例崩溃（铁律一，不变）。
 *
 * @module openprism
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
// ctx.webServer 键的类型增强；该 seam 未组合时注入回调不激活
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ACTIVITY_DIMENSIONS,
  ACTIVITY_DIMENSION_LABEL,
  CATEGORY_DIMENSIONS,
  DEFAULT_CATEGORIES,
  buildPanelSummary,
  renderPanelSummary,
} from './panel.js'
import type { PanelSummary } from './panel.js'
import { EventStore, randomEventId } from './store.js'
import { foldEvents } from './fold.js'
import type { FoldedState } from './fold.js'
import { Mirror, type MirrorSessionLike } from './mirror.js'
import { rebuildFromSessions } from './rebuild.js'
import { DshSessionFileSource } from './session-files.js'
import { resolveEventsFile } from './home.js'
import { normalizeRecordArgs } from './records.js'
import { panelDataFromFold } from './summary.js'
import type { ActivityDimension, CategoryDimension } from './types.js'

export const name = 'openprism'
export const inject = ['tools']

export async function apply(ctx: Context): Promise<void> {
  ctx.logger.info('openprism: 六维度生活面板就绪（全局事件日志版 v0.4：镜像器 + 折叠 + 更正 + rebuild）')

  const store = new EventStore(resolveEventsFile())
  await store.load()
  await seedCategories()

  const mirror = new Mirror(store)
  ctx.on('session/event', mirror.handleSessionEvent)
  ctx.on('session/created', (session: MirrorSessionLike) => {
    void mirror.backfillSession(session)
  })

  function fold(): FoldedState {
    return foldEvents(store.list())
  }

  async function readSummary(): Promise<PanelSummary> {
    return buildPanelSummary(panelDataFromFold(fold()))
  }

  // ─── 分类：播种 / 解析（未知名称自动建类，internal 事件） ───

  async function seedCategories(): Promise<void> {
    const seen = new Set<CategoryDimension>()
    for (const event of store.list()) {
      if (event.kind === 'category') seen.add(event.payload.dimension)
    }
    for (const dim of CATEGORY_DIMENSIONS) {
      if (seen.has(dim)) continue
      for (const name of DEFAULT_CATEGORIES[dim]) {
        await store.append({
          id: randomEventId('c'),
          kind: 'category',
          source: 'internal',
          recordedAt: Date.now(),
          payload: { op: 'create', dimension: dim, name },
        })
      }
    }
  }

  /** 规范化分类名：穿过改名链取规范名；不存在则 internal 建类。 */
  async function resolveCategory(dim: CategoryDimension, raw: string): Promise<string> {
    const name = raw.trim()
    if (name.length === 0 || name.includes('/')) {
      throw new Error(`openprism: 无效的分类名 ${JSON.stringify(raw)}`)
    }
    const state = fold()
    const canonical = state.resolveCategory(dim, name)
    if (state.categories[dim].includes(canonical)) return canonical
    await store.append({
      id: randomEventId('c'),
      kind: 'category',
      source: 'internal',
      recordedAt: Date.now(),
      payload: { op: 'create', dimension: dim, name: canonical },
    })
    return canonical
  }

  // ─── 工具描述里嵌入启动时的分类清单（运行中新增靠自动建类兜底，同 v0.3） ───

  const bootCategories = fold().categories

  ctx.tools.register(expenseTool(bootCategories.finance))
  ctx.tools.register(moodTool())
  ctx.tools.register(activityTool(bootCategories))
  ctx.tools.register(panelTool())

  function categoryDescription(list: readonly string[]): string {
    return `Existing: ${list.join('、')}. Reuse one when reasonable; any other non-empty name creates a new custom category.`
  }

  function expenseTool(categories: readonly string[]): ToolDefinition {
    return {
      name: 'openprism_record_expense',
      description:
        'Record one personal expense for the user (💰 finance dimension). Call it as soon as the user mentions spending money '
        + '(buying something, paying a bill, dining out).',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Amount in yuan (CNY), a positive number.' },
          category: { type: 'string', description: `Expense category. ${categoryDescription(categories)}` },
          note: { type: 'string', description: 'Short note, e.g. "lunch", "taxi to airport". (optional)' },
          occurredAt: { type: 'string', description: 'When the expense happened (ISO date/time or YYYY-MM-DD). Omit for "just now". (optional)' },
        },
        required: ['amount', 'category'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['recorded', 'amount', 'category', 'monthTotal'],
          properties: {
            recorded: { type: 'boolean' },
            amount: { type: 'number' },
            category: { type: 'string' },
            monthTotal: { type: 'number', description: 'The current month total across all sessions.' },
          },
        },
        render: (_args: unknown, value: JsonValue) => {
          const v = value as { amount: number; category: string; monthTotal: number }
          return textBlock(`已记录支出 ¥${v.amount.toFixed(2)}（${v.category}）。本月累计 ¥${v.monthTotal.toFixed(2)}。`)
        },
      },
      async execute(args: unknown, _exec: unknown): Promise<JsonValue> {
        const normalized = normalizeRecordArgs('expense', args as Record<string, unknown>)
        if (!normalized.ok) throw new Error(`openprism: ${normalized.error}`)
        const payload = normalized.payload as { amount: number; category: string }
        const category = await resolveCategory('finance', payload.category)
        const summary = await readSummary()
        return { recorded: true, amount: payload.amount, category, monthTotal: summary.finance.monthTotal }
      },
      presentCall: (args: unknown): ToolCallView | undefined => {
        const raw = args as Record<string, unknown>
        if (typeof raw.amount !== 'number' || typeof raw.category !== 'string') return undefined
        return { card: 'generic', title: '记一笔支出', kind: 'other', rawInput: args as JsonValue }
      },
    }
  }

  function moodTool(): ToolDefinition {
    return {
      name: 'openprism_record_mood',
      description:
        "Record the user's current mood as a 1-5 score (❤️ mood dimension). Call it when the user expresses feelings or state "
        + '(happy, tired, anxious, calm...). 1 = worst, 5 = best.',
      parameters: {
        type: 'object',
        properties: {
          score: { type: 'number', description: 'Mood score: integer 1 (worst) to 5 (best).' },
          note: { type: 'string', description: 'Short note capturing what the user expressed. (optional)' },
          occurredAt: { type: 'string', description: 'When the feeling applied (ISO date/time or YYYY-MM-DD). Omit for "just now". (optional)' },
        },
        required: ['score'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['recorded', 'score', 'moodCount', 'moodAverage'],
          properties: {
            recorded: { type: 'boolean' },
            score: { type: 'integer' },
            moodCount: { type: 'integer' },
            moodAverage: {
              oneOf: [{ type: 'number' }, { type: 'null' }],
              description: 'Average mood score across all sessions, null before any record.',
            },
          },
        },
        render: (_args: unknown, value: JsonValue) => {
          const v = value as { score: number; moodCount: number; moodAverage: number | null }
          return textBlock(
            `已记录心情 ${v.score}/5。共 ${v.moodCount} 条，均值 ${v.moodAverage === null ? '—' : v.moodAverage.toFixed(1)}。`,
          )
        },
      },
      async execute(args: unknown, _exec: unknown): Promise<JsonValue> {
        const normalized = normalizeRecordArgs('mood', args as Record<string, unknown>)
        if (!normalized.ok) throw new Error(`openprism: ${normalized.error}`)
        const payload = normalized.payload as { score: number }
        const summary = await readSummary()
        return { recorded: true, score: payload.score, moodCount: summary.mood.count, moodAverage: summary.mood.average }
      },
      presentCall: (args: unknown): ToolCallView | undefined => {
        const raw = args as Record<string, unknown>
        if (typeof raw.score !== 'number') return undefined
        return { card: 'generic', title: '记一条心情', kind: 'other', rawInput: args as JsonValue }
      },
    }
  }

  function activityTool(categories: Record<CategoryDimension, string[]>): ToolDefinition {
    const perDimension = ACTIVITY_DIMENSIONS
      .map((dim) => `${dim}: ${categories[dim].join('、')}`)
      .join('; ')
    return {
      name: 'openprism_record_activity',
      description:
        'Record one life activity for the user (🌱 life / 💼 work / 🏠 family / 📚 study dimensions). Call it when the user '
        + 'mentions exercising, sleeping, chores, meetings, coding sessions, family time, studying, reading, etc. '
        + 'Plain chat that is not worth tracking should NOT be recorded.',
      parameters: {
        type: 'object',
        properties: {
          dimension: {
            type: 'string',
            enum: [...ACTIVITY_DIMENSIONS],
            description: 'life=🌱 daily life, work=💼 job tasks, family=🏠 family time, study=📚 learning.',
          },
          category: {
            type: 'string',
            description: `Category within the dimension. Existing by dimension — ${perDimension}. `
              + 'Reuse one when reasonable; any other non-empty name creates a new custom category.',
          },
          durationMinutes: { type: 'number', description: 'Duration in minutes, when the user mentioned one. (optional)' },
          note: { type: 'string', description: 'Short note, e.g. "5km run", "standup meeting". (optional)' },
          occurredAt: { type: 'string', description: 'When the activity happened (ISO date/time or YYYY-MM-DD). Omit for "just now". (optional)' },
        },
        required: ['dimension', 'category'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['recorded', 'dimension', 'category', 'monthCount', 'monthMinutes'],
          properties: {
            recorded: { type: 'boolean' },
            dimension: { type: 'string' },
            category: { type: 'string' },
            monthCount: { type: 'integer', description: 'Records of this dimension in the current month.' },
            monthMinutes: { type: 'number', description: 'Summed durationMinutes of this dimension in the current month.' },
          },
        },
        render: (_args: unknown, value: JsonValue) => {
          const v = value as {
            dimension: ActivityDimension
            category: string
            monthCount: number
            monthMinutes: number
          }
          const label = ACTIVITY_DIMENSION_LABEL[v.dimension] ?? v.dimension
          const minutes = v.monthMinutes > 0 ? `，本月累计 ${v.monthMinutes} 分钟` : ''
          return textBlock(`已记录「${label}·${v.category}」。本月 ${v.monthCount} 条${minutes}。`)
        },
      },
      async execute(args: unknown, _exec: unknown): Promise<JsonValue> {
        const normalized = normalizeRecordArgs('activity', args as Record<string, unknown>)
        if (!normalized.ok) throw new Error(`openprism: ${normalized.error}`)
        const payload = normalized.payload as { dimension: ActivityDimension; category: string }
        const category = await resolveCategory(payload.dimension, payload.category)
        const summary = await readSummary()
        const dim = summary.activities[payload.dimension]
        return { recorded: true, dimension: payload.dimension, category, monthCount: dim.monthCount, monthMinutes: dim.monthMinutes }
      },
      presentCall: (args: unknown): ToolCallView | undefined => {
        const raw = args as Record<string, unknown>
        if (typeof raw.dimension !== 'string' || typeof raw.category !== 'string') return undefined
        return {
          card: 'generic',
          title: `记一条${ACTIVITY_DIMENSION_LABEL[raw.dimension as ActivityDimension] ?? '活动'}`,
          kind: 'other',
          rawInput: args as JsonValue,
        }
      },
    }
  }

  function panelTool(): ToolDefinition {
    return {
      name: 'openprism_panel',
      description:
        "Show the user's personal life panel across six dimensions (💰 finance, ❤️ mood, 🌱 life, 💼 work, 🏠 family, 📚 study): "
        + "this month's expense totals by category, a 14-day daily trend, mood average, per-dimension activity counts, "
        + 'and the recordable category lists. Data aggregates across all sessions. '
        + 'Call it when the user asks about their records, spending, mood, activities, or "面板/统计".',
      parameters: {
        type: 'object',
        properties: {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['monthTotal', 'monthCount', 'moodCount', 'summary'],
          properties: {
            monthTotal: { type: 'number' },
            monthCount: { type: 'integer' },
            moodCount: { type: 'integer' },
            summary: { type: 'string', description: 'Human-readable panel summary text.' },
          },
        },
        render: (_args: unknown, value: JsonValue) => textBlock((value as { summary: string }).summary),
      },
      async execute(_args: unknown, _exec: unknown): Promise<JsonValue> {
        const summary = await readSummary()
        return {
          monthTotal: summary.finance.monthTotal,
          monthCount: summary.finance.monthCount,
          moodCount: summary.mood.count,
          summary: renderPanelSummary(summary),
        }
      },
      presentCall: (): ToolCallView | undefined => ({
        card: 'generic',
        title: '生活面板',
        kind: 'other',
        rawInput: null,
      }),
    }
  }

  // ─── 浏览器面板端点（webServer seam 可选组合时注册） ───

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposePanel = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/panel.json',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          try {
            const summary = await readSummary()
            sendJson(res, 200, summary)
          } catch (error) {
            sendJson(res, 500, { error: String(error) })
          }
        },
      })
      const disposeCategories = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/categories',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          try {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>
            const result = await mutateCategory(body)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      const disposeRebuild = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/rebuild',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          try {
            const result = await rebuildFromSessions(store, new DshSessionFileSource())
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 500, { error: String(error) })
          }
        },
      })
      return () => {
        disposeRebuild()
        disposeCategories()
        disposePanel()
      }
    }, 'openprism: panel endpoints')
  })

  /** 分类增删改（面板 UI 的管理操作）→ internal 事件；改名/删除的记录迁移由折叠解析承担。 */
  async function mutateCategory(body: Record<string, unknown>): Promise<{ ok: true }> {
    const op = body.op
    const dim = body.dimension
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (op !== 'add' && op !== 'rename' && op !== 'delete') throw new Error('op 必须是 add / rename / delete')
    if (typeof dim !== 'string' || !(CATEGORY_DIMENSIONS as readonly string[]).includes(dim)) {
      throw new Error('dimension 必须是 finance / life / work / family / study')
    }
    const dimension = dim as CategoryDimension
    validateCategoryName(name)
    const state = fold()
    const list = state.categories[dimension]
    const exists = state.resolveCategory(dimension, name) === name ? list.includes(name) : true

    if (op === 'add') {
      if (exists) throw new Error(`分类「${name}」已存在`)
      await store.append({
        id: randomEventId('c'),
        kind: 'category',
        source: 'ui',
        recordedAt: Date.now(),
        payload: { op: 'create', dimension, name },
      })
      return { ok: true }
    }

    if (name === '其他') throw new Error('兜底分类「其他」不可改名或删除')
    if (!exists) throw new Error(`分类「${name}」不存在`)

    if (op === 'rename') {
      const newName = typeof body.newName === 'string' ? body.newName.trim() : ''
      validateCategoryName(newName)
      if (list.includes(newName)) throw new Error(`分类「${newName}」已存在`)
      await store.append({
        id: randomEventId('c'),
        kind: 'category',
        source: 'ui',
        recordedAt: Date.now(),
        payload: { op: 'rename', dimension, name, newName },
      })
      return { ok: true }
    }

    // delete：记录经折叠解析归入兜底分类「其他」
    await store.append({
      id: randomEventId('c'),
      kind: 'category',
      source: 'ui',
      recordedAt: Date.now(),
      payload: { op: 'delete', dimension, name },
    })
    return { ok: true }
  }

  function validateCategoryName(name: string): void {
    if (name.length === 0 || name.length > 24) throw new Error('分类名长度须在 1-24 之间')
    if (name.includes('/')) throw new Error('分类名不允许包含 "/"')
  }

  function sendJson(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 8192) throw new Error('请求体过大')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function textBlock(text: string): Array<{ type: 'text'; text: string }> {
    return [{ type: 'text', text }]
  }
}
