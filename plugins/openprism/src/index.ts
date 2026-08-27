/**
 * OpenPrism —— DeepSeek Harness (dsh) 组合包：对话即录入的个人生活面板（六维度）。
 *
 * 架构（v0.3，storage-domain 版）：
 * - 结构化数据存放在 dsh 的 storage-domain（`ctx.storageDomain`，JSON 后端落在
 *   `$DSH_HOME/storages`）——跨会话持久，卸载插件不污染会话日志；
 * - 四张表：expenses（理财）、moods（情感）、activities（生活/工作/家庭/学习
 *   共用一条记录形状）、categories（各维度的自定义分类清单）；
 * - 四个模型面工具（`ctx.tools`）：`openprism_record_expense` /
 *   `openprism_record_mood` / `openprism_record_activity` / `openprism_panel`；
 *   记录时未知分类名自动创建——用户在对话里即可扩展自己的分类维度；
 * - HTTP 端点（`ctx.webServer`，可选 seam）：`GET /openprism/panel.json`
 *   （浏览器面板数据源）与 `POST /openprism/categories`（面板 UI 的分类
 *   增删改名）；
 * - 浏览器半边（`./client`，`dsh.client` 声明）：侧栏底部「面板」按钮 + 六维度分页可视化模态。
 *
 * 【零声明的 dsh 依赖】本包不声明任何 @deepseek-ai/* 依赖（peer 也不声明）。
 * 运行时导入的 Service Definition 包（dsh-storage-domain）经 dsh 的
 * profiles/node_modules 回退链解析到宿主自己的副本——避免 profile 本地副本
 * 遮蔽内置包造成的双实例（Symbol 身份不一致）崩溃。类型检查用 devDependencies。
 *
 * @module openprism
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolCallView, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
// ctx.webServer 键的类型增强；该 seam 未组合时注入回调不激活
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ACTIVITY_DIMENSIONS,
  ACTIVITY_DIMENSION_LABEL,
  CATEGORY_DIMENSIONS,
  DEFAULT_CATEGORIES,
  buildPanelSummary,
  renderPanelSummary,
} from './panel.js'
import type { PanelSummary } from './panel.js'
import type { ActivityDimension, CategoryDimension, ActivityRecord, CategoryRecord, ExpenseRecord, MoodRecord, PanelData } from './types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'

export const name = 'openprism'
export const inject = ['tools', 'storageDomain']

// ─── storage 域声明 ───
// version 保持 1：JSON 后端按描述符的表清单读取快照，缺表按空处理——
// 旧数据文件（只有 expenses/moods）加载后新表从空开始，无需迁移。

const expenseSchema = z.object({
  time: z.number(),
  amount: z.number(),
  category: z.string(),
  note: z.string().optional(),
})

const moodSchema = z.object({
  time: z.number(),
  score: z.number(),
  note: z.string().optional(),
})

const activitySchema = z.object({
  time: z.number(),
  dimension: z.enum(['life', 'work', 'family', 'study']),
  category: z.string(),
  durationMinutes: z.number().optional(),
  note: z.string().optional(),
})

const categorySchema = z.object({
  dimension: z.enum(['finance', 'life', 'work', 'family', 'study']),
  name: z.string(),
  createdAt: z.number(),
})

const openprismDomain = defineDomain({
  name: 'openprism',
  version: 1,
  tables: {
    expenses: domainTable<string, ExpenseRecord>(expenseSchema),
    moods: domainTable<string, MoodRecord>(moodSchema),
    activities: domainTable<string, ActivityRecord>(activitySchema),
    categories: domainTable<string, CategoryRecord>(categorySchema),
  },
})

/** categories 表的 key 约定：`<dimension>/<name>`（name 不允许含 `/`）。 */
function categoryKey(dimension: CategoryDimension, name: string): string {
  return `${dimension}/${name}`
}

export async function apply(ctx: Context): Promise<void> {
  ctx.logger.info('openprism: 六维度生活面板已就绪（expense / mood / activity / panel + 自定义分类 + 可视化 UI）')

  let disposed = false
  const domainReady = ctx.storageDomain.open(openprismDomain)
  ctx.effect(() => {
    void domainReady.then(
      (domain) => {
        if (disposed) void domain.close()
      },
      (error: unknown) => {
        ctx.logger.error(`openprism: 打开 storage 域失败：${String(error)}`)
      },
    )
    return () => {
      disposed = true
      void domainReady.then((domain) => domain.close())
    }
  }, 'openprism: domain')

  interface Tables {
    expenses: KvTable<string, ExpenseRecord>
    moods: KvTable<string, MoodRecord>
    activities: KvTable<string, ActivityRecord>
    categories: KvTable<string, CategoryRecord>
  }

  async function tables(): Promise<Tables> {
    const domain = await domainReady
    return {
      expenses: domain.table('expenses') as KvTable<string, ExpenseRecord>,
      moods: domain.table('moods') as KvTable<string, MoodRecord>,
      activities: domain.table('activities') as KvTable<string, ActivityRecord>,
      categories: domain.table('categories') as KvTable<string, CategoryRecord>,
    }
  }

  async function readData(): Promise<PanelData> {
    const t = await tables()
    const categories: PanelData['categories'] = []
    for (const [, record] of t.categories.entries()) {
      categories.push({ dimension: record.dimension, name: record.name, createdAt: record.createdAt })
    }
    return {
      expenses: [...t.expenses.entries()].map(([, record]) => record),
      moods: [...t.moods.entries()].map(([, record]) => record),
      activities: [...t.activities.entries()].map(([, record]) => record),
      categories,
    }
  }

  async function readSummary(): Promise<PanelSummary> {
    return buildPanelSummary(await readData())
  }

  // ─── 分类：播种 / 读取 / 解析（未知名称自动创建） ───

  /** 首次启动播种默认分类：只对 categories 表中尚无记录的维度生效。 */
  async function seedCategories(): Promise<void> {
    const t = await tables()
    const seen = new Set<CategoryDimension>()
    for (const [, record] of t.categories.entries()) seen.add(record.dimension)
    for (const dim of CATEGORY_DIMENSIONS) {
      if (seen.has(dim)) continue
      const stamp = Date.now()
      for (const [index, name] of DEFAULT_CATEGORY_NAMES(dim).entries()) {
        await t.categories.put(categoryKey(dim, name), { dimension: dim, name, createdAt: stamp + index })
      }
    }
  }

  async function loadCategories(): Promise<Record<CategoryDimension, string[]>> {
    return buildPanelSummary(await readData()).categories
  }

  /**
   * 规范化分类名：trim 后与该维度现有分类精确匹配则复用；
   * 否则立即创建（用户在对话里自定义分类维度的入口）。
   */
  async function resolveCategory(dim: CategoryDimension, raw: string): Promise<string> {
    const name = raw.trim()
    if (name.length === 0 || name.includes('/')) {
      throw new Error(`openprism: 无效的分类名 ${JSON.stringify(raw)}`)
    }
    const lists = await loadCategories()
    if (lists[dim].includes(name)) return name
    const t = await tables()
    await t.categories.put(categoryKey(dim, name), { dimension: dim, name, createdAt: Date.now() })
    return name
  }

  // 工具描述里嵌入启动时的分类清单；运行中新增的分类不回头改描述——
  // resolveCategory 的自动创建兜底保证了新名称不会被校验拒绝。
  let bootCategories: Record<CategoryDimension, string[]>
  try {
    await seedCategories()
    bootCategories = await loadCategories()
  } catch (error) {
    ctx.logger.error(`openprism: 分类初始化失败（工具以默认分类注册）：${String(error)}`)
    bootCategories = DEFAULT_CATEGORY_LISTS()
  }
  if (disposed) return

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
            const body = JSON.parse(await readBody(req)) as {
              op?: unknown
              dimension?: unknown
              name?: unknown
              newName?: unknown
            }
            const result = await mutateCategory(body)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      return () => {
        disposeCategories()
        disposePanel()
      }
    }, 'openprism: panel endpoints')
  })

  /** 分类增删改（面板 UI 的管理操作）。抛出的 Error → HTTP 400 的 error 文本。 */
  async function mutateCategory(body: {
    op?: unknown
    dimension?: unknown
    name?: unknown
    newName?: unknown
  }): Promise<{ ok: true }> {
    const op = body.op
    const dim = body.dimension
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (op !== 'add' && op !== 'rename' && op !== 'delete') throw new Error('op 必须是 add / rename / delete')
    if (typeof dim !== 'string' || !(CATEGORY_DIMENSIONS as readonly string[]).includes(dim)) {
      throw new Error('dimension 必须是 finance / life / work / family / study')
    }
    const dimension = dim as CategoryDimension
    validateCategoryName(name)

    const t = await tables()
    const lists = await loadCategories()
    const list = lists[dimension]
    const exists = list.includes(name)

    if (op === 'add') {
      if (exists) throw new Error(`分类「${name}」已存在`)
      await t.categories.put(categoryKey(dimension, name), { dimension, name, createdAt: Date.now() })
      return { ok: true }
    }

    if (name === '其他') throw new Error('兜底分类「其他」不可改名或删除')
    if (!exists) throw new Error(`分类「${name}」不存在`)
    if (op === 'delete' && list.length <= 1) throw new Error('至少保留一个分类')

    if (op === 'rename') {
      const newName = typeof body.newName === 'string' ? body.newName.trim() : ''
      validateCategoryName(newName)
      if (list.includes(newName)) throw new Error(`分类「${newName}」已存在`)
      const previous = await t.categories.get(categoryKey(dimension, name))
      await t.categories.put(categoryKey(dimension, newName), {
        dimension,
        name: newName,
        createdAt: previous?.createdAt ?? Date.now(),
      })
      await t.categories.delete(categoryKey(dimension, name))
      await reassignCategory(dimension, name, newName)
      return { ok: true }
    }

    // delete：记录归入兜底分类（兜底行缺失时先补建）
    if (!list.includes('其他')) {
      await t.categories.put(categoryKey(dimension, '其他'), { dimension, name: '其他', createdAt: Date.now() })
    }
    await t.categories.delete(categoryKey(dimension, name))
    await reassignCategory(dimension, name, '其他')
    return { ok: true }
  }

  /** 改名/删除分类时，把已有记录的 category 字段迁移到目标名。 */
  async function reassignCategory(dimension: CategoryDimension, from: string, to: string): Promise<void> {
    const t = await tables()
    if (dimension === 'finance') {
      for (const [key, record] of t.expenses.entries()) {
        if (record.category === from) await t.expenses.put(key, { ...record, category: to })
      }
      return
    }
    for (const [key, record] of t.activities.entries()) {
      if (record.dimension === dimension && record.category === from) {
        await t.activities.put(key, { ...record, category: to })
      }
    }
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

  // ─── 参数校验（模型产出的 JSON 在工具边界校验） ───

  function requireNumber(args: Record<string, unknown>, key: string): number {
    const value = args[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`openprism: 参数 ${key} 必须是数字，收到 ${JSON.stringify(value) ?? 'undefined'}`)
    }
    return value
  }

  function requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`openprism: 参数 ${key} 必须是非空字符串，收到 ${JSON.stringify(value) ?? 'undefined'}`)
    }
    return value
  }

  function optionalNote(args: Record<string, unknown>): { note?: string } {
    const value = args.note
    if (typeof value !== 'string' || value.trim().length === 0) return {}
    return { note: value }
  }

  function textBlock(text: string): Array<{ type: 'text'; text: string }> {
    return [{ type: 'text', text }]
  }

  function recordKey(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ─── 工具定义（结构化构造，见文件头说明） ───

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
      async execute(args: unknown, _exec: ToolRunContext): Promise<JsonValue> {
        const raw = args as Record<string, unknown>
        const amount = requireNumber(raw, 'amount')
        if (!(amount > 0)) throw new Error('openprism: 参数 amount 必须为正数')
        const category = await resolveCategory('finance', requireString(raw, 'category'))
        const t = await tables()
        await t.expenses.put(recordKey('e'), { time: Date.now(), amount, category, ...optionalNote(raw) })
        const summary = await readSummary()
        return { recorded: true, amount, category, monthTotal: summary.finance.monthTotal }
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
      async execute(args: unknown, _exec: ToolRunContext): Promise<JsonValue> {
        const raw = args as Record<string, unknown>
        const score = requireNumber(raw, 'score')
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          throw new Error('openprism: 参数 score 必须是 1-5 的整数')
        }
        const t = await tables()
        await t.moods.put(recordKey('m'), { time: Date.now(), score, ...optionalNote(raw) })
        const summary = await readSummary()
        return { recorded: true, score, moodCount: summary.mood.count, moodAverage: summary.mood.average }
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
      async execute(args: unknown, _exec: ToolRunContext): Promise<JsonValue> {
        const raw = args as Record<string, unknown>
        const dimension = requireString(raw, 'dimension') as ActivityDimension
        if (!(ACTIVITY_DIMENSIONS as readonly string[]).includes(dimension)) {
          throw new Error(`openprism: 参数 dimension 必须是 ${ACTIVITY_DIMENSIONS.join(' / ')}`)
        }
        const category = await resolveCategory(dimension, requireString(raw, 'category'))
        let duration: { durationMinutes?: number } = {}
        if (raw.durationMinutes !== undefined) {
          const minutes = requireNumber(raw, 'durationMinutes')
          if (!(minutes > 0)) throw new Error('openprism: 参数 durationMinutes 必须为正数')
          duration = { durationMinutes: minutes }
        }
        const t = await tables()
        await t.activities.put(recordKey('a'), {
          time: Date.now(),
          dimension,
          category,
          ...duration,
          ...optionalNote(raw),
        })
        const summary = await readSummary()
        const dim = summary.activities[dimension]
        return { recorded: true, dimension, category, monthCount: dim.monthCount, monthMinutes: dim.monthMinutes }
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
      async execute(_args: unknown, _exec: ToolRunContext): Promise<JsonValue> {
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
}

// ─── 默认分类的取值助手（seedCategories / 失败回退共用） ───

function DEFAULT_CATEGORY_NAMES(dim: CategoryDimension): readonly string[] {
  return DEFAULT_CATEGORY_LISTS()[dim]
}

function DEFAULT_CATEGORY_LISTS(): Record<CategoryDimension, string[]> {
  const lists = {} as Record<CategoryDimension, string[]>
  for (const dim of CATEGORY_DIMENSIONS) lists[dim] = [...DEFAULT_CATEGORIES[dim]]
  return lists
}
