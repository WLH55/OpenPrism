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
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import {
  ACTIVITY_DIMENSIONS,
  ACTIVITY_DIMENSION_LABEL,
  CATEGORY_DIMENSIONS,
  DEFAULT_CATEGORIES,
  buildGoalProgress,
  buildHeatmap,
  buildPanelSummary,
  buildSlices,
  renderPanelSummary,
} from './panel.js'
import type { PanelSummary } from './panel.js'
import { EventStore, randomEventId } from './store.js'
import { foldEvents } from './fold.js'
import type { FoldedState } from './fold.js'
import { Mirror, type MirrorSessionLike } from './mirror.js'
import { rebuildFromSessions } from './rebuild.js'
import { DshSessionFileSource } from './session-files.js'
import { resolveEventsFile, resolveOpenPrismHome } from './home.js'
import { normalizeRecordArgs } from './records.js'
import { applyCorrection, describeRecord, parseCorrectionRequest } from './corrections.js'
import { panelDataFromFold } from './summary.js'
import { dayKey } from './panel.js'
import { CaptureStore } from './captures.js'
import { distillPending, type DistillLlmPort } from './distill.js'
import { buildDailyBriefing, buildWeeklyBriefing } from './briefing.js'
import { join } from 'node:path'
import type { ActivityDimension, CategoryDimension } from './types.js'

export const name = 'openprism'
export const inject = ['tools']

/** 最近一次 apply 的存储实例（测试与运维内省用；生产单实例语义不变）。 */
let lastApplied: { store: EventStore; captures: CaptureStore } | undefined
export function lastAppliedStores(): { store: EventStore; captures: CaptureStore } | undefined {
  return lastApplied
}

export async function apply(ctx: Context): Promise<void> {
  ctx.logger.info('openprism: 六维度生活面板就绪（全局事件日志版 v0.4：镜像器 + 折叠 + 更正 + rebuild）')

  const store = new EventStore(resolveEventsFile())
  await store.load()
  await seedCategories()

  const captures = new CaptureStore(join(resolveOpenPrismHome(), 'captures'))
  await captures.load()

  const mirror = new Mirror(store, captures)
  ctx.on('session/event', mirror.handleSessionEvent)
  ctx.on('session/created', (session: MirrorSessionLike) => {
    void mirror.backfillSession(session)
  })

  // ─── 夜间提炼（5.3）：凌晨 3 点批量提炼 pending 原料；错过补跑=下次启动照跑 ───

  let llmPort: DistillLlmPort | undefined
  ctx.inject(['llm'], (llmCtx) => {
    llmPort = createLlmPort(llmCtx)
  })

  async function runDistill(): Promise<unknown> {
    try {
      return await distillPending({ store, captures, route: mirror.getRoute(), llm: llmPort })
    } catch (error) {
      ctx.logger.warn(`openprism: 夜间提炼失败：${String(error)}`)
      return { ran: false, reason: 'no-llm', error: String(error) }
    }
  }

  // ─── 简报（D7）：数据模板零 token，周报解读可选过 LLM；落 reports/YYYY-MM/ ───

  async function runDailyBriefing(): Promise<{ path: string; markdown: string }> {
    const now = Date.now()
    const state = fold()
    const goalRecords = state.records
      .filter((r) => r.kind === 'goal' && !r.deleted)
      .map((r) => ({ id: r.id, payload: r.payload as import('./events.js').GoalPayload }))
    const briefing = buildDailyBriefing({
      records: state.records,
      goals: buildGoalProgress(goalRecords, state.records, now),
      distillCount: store.list().filter((e) => e.source === 'extraction' && e.recordedAt >= now - 24 * 3600 * 1000).length,
      now,
    })
    const fullPath = join(resolveOpenPrismHome(), briefing.path)
    await mkdir(join(fullPath, '..'), { recursive: true })
    await writeFile(fullPath, briefing.markdown, 'utf8')
    ctx.logger.info(`openprism: 每日简报已生成 ${briefing.path}`)
    return briefing
  }

  async function runWeeklyBriefing(): Promise<{ path: string; markdown: string }> {
    const state = fold()
    const briefing = await buildWeeklyBriefing({
      records: state.records,
      now: Date.now(),
      llm: llmPort === undefined
        ? undefined
        : {
          completeOnce: (system, prompt) => {
            const route = mirror.getRoute()
            const port = llmPort
            if (route === undefined || port === undefined) return Promise.reject(new Error('no model route'))
            return port.complete({ provider: route.provider, model: route.model, system, prompt, maxTokens: 800 })
          },
        },
      llmRoute: mirror.getRoute(),
    })
    const fullPath = join(resolveOpenPrismHome(), briefing.path)
    await mkdir(join(fullPath, '..'), { recursive: true })
    await writeFile(fullPath, briefing.markdown, 'utf8')
    ctx.logger.info(`openprism: 周报已生成 ${briefing.path}`)
    return briefing
  }

  /** 启动补跑：今天已过 07:00 但昨天的每日简报缺失 → 补生成（5.3 补跑语义的简报版）。 */
  async function catchUpBriefing(): Promise<void> {
    const now = new Date()
    if (now.getHours() < 7) return
    const yesterday = dayKey(now.getTime() - 24 * 3600 * 1000)
    const relPath = `reports/${yesterday.slice(0, 7)}/daily-${yesterday}.md`
    const exists = await readdir(join(resolveOpenPrismHome(), 'reports', yesterday.slice(0, 7)))
      .then((files) => files.includes(`daily-${yesterday}.md`))
      .catch(() => false)
    if (!exists) await runDailyBriefing()
  }

  ctx.effect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const schedule = (job: () => Promise<void>, hour: number, minute: number, sundayOnly = false): void => {
      const now = new Date()
      const next = new Date(now)
      next.setHours(hour, minute, 0, 0)
      if (sundayOnly) {
        while (next.getDay() !== 0 || next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
      } else if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1)
      }
      timers.push(setTimeout(() => {
        void job().finally(() => schedule(job, hour, minute, sundayOnly))
      }, Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1)))
    }
    schedule(async () => { await runDistill() }, 3, 0) // 凌晨 3 点：提炼（5.3）
    schedule(async () => { await runDailyBriefing() }, 7, 0) // 清晨 7 点：每日简报（D7）
    schedule(async () => { await runWeeklyBriefing() }, 21, 0, true) // 周日 21 点：周报（D7）
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, 'openprism: nightly jobs')
  void catchUpBriefing()

  lastApplied = { store, captures }

  function fold(): FoldedState {
    return foldEvents(store.list())
  }

  async function readSummary(): Promise<PanelSummary> {
    const state = fold()
    const summary = buildPanelSummary(panelDataFromFold(state))
    const now = summary.updatedAt
    summary.recent = state.records
      .filter((r) => !r.deleted && r.kind !== 'goal')
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, 12)
      .map((r) => ({
        id: r.id,
        kind: r.kind as 'expense' | 'mood' | 'activity',
        occurredAt: r.occurredAt,
        date: dayKey(r.occurredAt),
        title: describeRecord(r),
      }))
    // 聚合 v2（批次 4）：目标进度 / 热力图 / 周期切片
    const goalRecords = state.records
      .filter((r) => r.kind === 'goal' && !r.deleted)
      .map((r) => ({ id: r.id, payload: r.payload as import('./events.js').GoalPayload }))
    summary.goals = buildGoalProgress(goalRecords, state.records, now)
    const dims = ['finance', 'mood', 'life', 'work', 'family', 'study'] as const
    summary.heatmap = Object.fromEntries(dims.map((dim) => [dim, buildHeatmap(state.records, dim, now)])) as PanelSummary['heatmap']
    summary.slices = Object.fromEntries(dims.map((dim) => [dim, buildSlices(state.records, dim, now)])) as PanelSummary['slices']
    return summary
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
  ctx.tools.register(correctTool())
  ctx.tools.register(goalTool())

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

  function correctTool(): ToolDefinition {
    return {
      name: 'openprism_correct',
      description:
        'Correct or delete one previously recorded OpenPrism entry (expense/mood/activity). Provide `target` (event id from '
        + 'openprism_panel 最近记录) to hit an exact entry, or provide `kind` (+optional dimension/category filter) to hit the '
        + 'most recent match. op=update needs at least one field to change: amount/score/category/note/durationMinutes/occurredAt. '
        + 'Call it when the user says an entry was wrong ("刚才记错了", "改成 28", "删掉那条").',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['update', 'delete'], description: 'update changes fields; delete removes the entry.' },
          target: { type: 'string', description: 'Event id of the entry (from openprism_panel 最近记录). (optional)' },
          kind: { type: 'string', enum: ['expense', 'mood', 'activity'], description: 'Required when target is omitted.' },
          dimension: { type: 'string', enum: [...ACTIVITY_DIMENSIONS], description: 'Activity dimension filter. (optional)' },
          amount: { type: 'number', description: 'update: corrected amount (expense). (optional)' },
          score: { type: 'number', description: 'update: corrected mood score 1-5. (optional)' },
          category: { type: 'string', description: 'update: corrected category. (optional)' },
          note: { type: 'string', description: 'update: corrected note. (optional)' },
          durationMinutes: { type: 'number', description: 'update: corrected duration in minutes. (optional)' },
          occurredAt: { type: 'string', description: 'update: corrected occurrence time (ISO date/time). (optional)' },
        },
        required: ['op'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['corrected', 'op', 'target', 'entry'],
          properties: {
            corrected: { type: 'boolean' },
            op: { type: 'string' },
            target: { type: 'string', description: 'Id of the corrected original event.' },
            entry: { type: 'string', description: 'Human-readable description of the corrected entry (before this correction).' },
          },
        },
        render: (_args: unknown, value: JsonValue) => {
          const v = value as { op: string; entry: string }
          return textBlock(`${v.op === 'delete' ? '已删除' : '已更正'}：${v.entry}`)
        },
      },
      async execute(args: unknown, _exec: unknown): Promise<JsonValue> {
        const request = parseCorrectionRequest(args as Record<string, unknown>)
        if ('error' in request) throw new Error(`openprism: ${request.error}`)
        const result = await applyCorrection(store, request, { source: 'internal' })
        return { corrected: true, op: result.op, target: result.target, entry: describeRecord(result.record) }
      },
      presentCall: (args: unknown): ToolCallView | undefined => {
        const raw = args as Record<string, unknown>
        if (raw.op !== 'update' && raw.op !== 'delete') return undefined
        return { card: 'generic', title: '更正记录', kind: 'other', rawInput: args as JsonValue }
      },
    }
  }

  /** ctx.llm → 提炼端口的适配（dsh-llm 只做类型检查，运行时动态 import 到宿主副本）。 */
  function createLlmPort(llmCtx: { llm: import('@deepseek-ai/dsh-llm').LlmRuntime }): DistillLlmPort {
    return {
      async complete({ provider, model, system, prompt, maxTokens }) {
        const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm')
        const options = {
          provider,
          model,
          messages: [
            createUserMessage({
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'plugin', plugin: 'openprism' },
            }),
          ],
          system,
          maxTokens,
          purpose: 'openprism-distill',
        } as unknown as import('@deepseek-ai/dsh-llm').GenerateOptions
        const assembler = new BlockAssembler()
        for await (const chunk of llmCtx.llm.stream(options)) assembler.push(chunk)
        return (assembler.blocks() as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => (b as { text: string }).text)
          .join('')
      },
    }
  }

  const GOAL_METRIC_DIMENSIONS: Record<string, readonly string[]> = {
    expenseTotal: ['finance'],
    activityDuration: [...ACTIVITY_DIMENSIONS],
    activityCount: [...ACTIVITY_DIMENSIONS],
    moodCount: ['mood'],
  }

  function goalTool(): ToolDefinition {
    return {
      name: 'openprism_set_goal',
      description:
        'Set or replace a personal goal/budget (🎯). expenseTotal = monthly/weekly/daily spending cap on finance; '
        + 'activityDuration / activityCount = time or count targets for one activity dimension; moodCount = mood check-in count. '
        + 'Call it when the user says things like "这个月吃饭预算 2000", "每周跑步 3 次", "每天学习 1 小时". '
        + 'Setting a goal for the same metric+dimension+period supersedes the previous one.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['expenseTotal', 'activityDuration', 'activityCount', 'moodCount'] },
          dimension: {
            type: 'string',
            enum: ['finance', 'life', 'work', 'family', 'study', 'mood'],
            description: 'expenseTotal→finance; activityDuration/Count→life/work/family/study; moodCount→mood.',
          },
          target: { type: 'number', description: 'Target value (yuan for expenseTotal, minutes for activityDuration, count otherwise).' },
          period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
          note: { type: 'string', description: 'Short label, e.g. "餐饮预算". (optional)' },
        },
        required: ['metric', 'dimension', 'target', 'period'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['set', 'metric', 'dimension', 'target', 'period'],
          properties: {
            set: { type: 'boolean' },
            metric: { type: 'string' },
            dimension: { type: 'string' },
            target: { type: 'number' },
            period: { type: 'string' },
          },
        },
        render: (_args: unknown, value: JsonValue) => {
          const v = value as { metric: string; dimension: string; target: number; period: string }
          const periodLabel = v.period === 'daily' ? '每天' : v.period === 'weekly' ? '每周' : '每月'
          return textBlock(`已设定目标：${periodLabel}${v.dimension}·${v.metric} ≤ ${String(v.target)}。可随时重新设定覆盖。`)
        },
      },
      async execute(args: unknown, _exec: unknown): Promise<JsonValue> {
        const raw = args as Record<string, unknown>
        const metric = requireString(raw, 'metric')
        const dimension = requireString(raw, 'dimension')
        const allowed = GOAL_METRIC_DIMENSIONS[metric]
        if (allowed === undefined) throw new Error(`openprism: 未知 metric ${metric}`)
        if (!allowed.includes(dimension)) {
          throw new Error(`openprism: metric ${metric} 的 dimension 必须是 ${allowed.join('/')}`)
        }
        const target = requireNumber(raw, 'target')
        if (!(target > 0)) throw new Error('openprism: target 必须为正数')
        const period = requireString(raw, 'period')
        if (!['daily', 'weekly', 'monthly'].includes(period)) throw new Error('openprism: period 必须是 daily/weekly/monthly')

        // 同 metric+dimension+period 的旧目标 → 追加 delete 更正（6.1 的“重设即覆盖”）
        const state = fold()
        for (const record of state.records) {
          if (record.kind !== 'goal' || record.deleted) continue
          const payload = record.payload as import('./events.js').GoalPayload
          if (payload.metric === metric && payload.dimension === dimension && payload.period === period) {
            await store.append({
              id: randomEventId('x'),
              kind: 'correction',
              source: 'internal',
              recordedAt: Date.now(),
              payload: { target: record.id, op: 'delete' },
            } as import('./events.js').OpenEvent)
          }
        }

        await store.append({
          id: randomEventId('g'),
          kind: 'goal',
          source: 'internal',
          recordedAt: Date.now(),
          payload: {
            dimension: dimension as import('./events.js').GoalPayload['dimension'],
            metric: metric as import('./events.js').GoalPayload['metric'],
            target,
            period: period as import('./events.js').GoalPayload['period'],
            ...(typeof raw.note === 'string' && raw.note.trim().length > 0 ? { note: raw.note.trim() } : {}),
          },
        })
        return { set: true, metric, dimension, target, period }
      },
      presentCall: (args: unknown): ToolCallView | undefined => {
        const raw = args as Record<string, unknown>
        if (typeof raw.metric !== 'string' || typeof raw.target !== 'number') return undefined
        return { card: 'generic', title: '设定目标', kind: 'other', rawInput: args as JsonValue }
      },
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
      const disposeCorrections = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/corrections',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          try {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>
            const request = parseCorrectionRequest(body)
            if ('error' in request) throw new Error(request.error)
            const result = await applyCorrection(store, request, { source: 'ui' })
            sendJson(res, 200, { ok: true, op: result.op, target: result.target })
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      const disposeRecords = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/records',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          try {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>
            const result = await quickRecord(body)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      const disposeDistill = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/distill',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          const report = await runDistill()
          sendJson(res, 200, report)
        },
      })
      const disposeBriefingDaily = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/briefing/daily',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          try {
            sendJson(res, 200, await runDailyBriefing())
          } catch (error) {
            sendJson(res, 500, { error: String(error) })
          }
        },
      })
      const disposeBriefingWeekly = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/briefing/weekly',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          try {
            sendJson(res, 200, await runWeeklyBriefing())
          } catch (error) {
            sendJson(res, 500, { error: String(error) })
          }
        },
      })
      const disposeBriefingsList = webCtx.webServer.register({
        kind: 'exact',
        path: '/openprism/briefings',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          try {
            const reportsDir = join(resolveOpenPrismHome(), 'reports')
            const months = await readdir(reportsDir).catch(() => [] as string[])
            const files: string[] = []
            for (const month of months) {
              const monthFiles = await readdir(join(reportsDir, month)).catch(() => [] as string[])
              for (const file of monthFiles) files.push(`reports/${month}/${file}`)
            }
            sendJson(res, 200, { briefings: files.sort() })
          } catch (error) {
            sendJson(res, 500, { error: String(error) })
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
        disposeBriefingDaily()
        disposeBriefingWeekly()
        disposeBriefingsList()
        disposeDistill()
        disposeRecords()
        disposeCorrections()
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

  /** 速记表单直录（不经模型，workbench 借鉴）：ui 事件 + 表单渠道 + 自动建类。 */
  async function quickRecord(body: Record<string, unknown>): Promise<{ ok: true; id: string }> {
    const kind = requireString(body, 'kind')
    if (kind !== 'expense' && kind !== 'mood' && kind !== 'activity') {
      throw new Error('kind 必须是 expense / mood / activity')
    }
    const normalized = normalizeRecordArgs(kind, body)
    if (!normalized.ok) throw new Error(normalized.error)
    const payload = normalized.payload
    if (kind !== 'mood') {
      const dim = kind === 'expense' ? 'finance' : (payload as { dimension: CategoryDimension }).dimension
      await resolveCategory(dim, (payload as { category: string }).category)
    }
    const id = randomEventId('u')
    await store.append({
      id,
      kind,
      source: 'ui',
      channel: 'form',
      recordedAt: Date.now(),
      ...(normalized.occurredAt !== undefined ? { occurredAt: normalized.occurredAt } : {}),
      payload,
    } as import('./events.js').OpenEvent)
    return { ok: true, id }
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

  function textBlock(text: string): Array<{ type: 'text'; text: string }> {
    return [{ type: 'text', text }]
  }
}
