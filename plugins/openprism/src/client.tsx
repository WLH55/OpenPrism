/**
 * OpenPrism 浏览器半边：侧栏底部「面板」按钮 + 六维度分页可视化面板模态。
 *
 * 打包为 `lib/client.js`（esbuild CJS 闭包，`window.__ModuleLoader__.load`
 * 注册到模块表），外部依赖（react 等）经注入的 require 由平台模块表应答。
 * 数据源是宿主半边注册的 `GET /openprism/panel.json`（打开即取 + 5 秒轮询），
 * 分类管理走 `POST /openprism/categories`（add / rename / delete）。
 *
 * @module openprism/client
 */

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ─── 与宿主 panel.ts 对应的形状（浏览器半边自持副本，避免跨包类型耦合） ───

type ActivityDim = 'life' | 'work' | 'family' | 'study'
type CategoryDim = 'finance' | ActivityDim
type TabKey = 'overview' | 'mood' | CategoryDim | 'settings'

const CATEGORY_DIMS: CategoryDim[] = ['finance', 'life', 'work', 'family', 'study']
const ACTIVITY_DIMS: ActivityDim[] = ['life', 'work', 'family', 'study']

const DIM_META: Record<CategoryDim, { emoji: string; label: string }> = {
  finance: { emoji: '💰', label: '理财' },
  life: { emoji: '🌱', label: '生活' },
  work: { emoji: '💼', label: '工作' },
  family: { emoji: '🏠', label: '家庭' },
  study: { emoji: '📚', label: '学习' },
}

interface RecentItem { id: string; kind: 'expense' | 'mood' | 'activity'; occurredAt: number; date: string; title: string }
interface GoalProgress { id: string; dimension: string; metric: string; target: number; period: string; note?: string; current: number; ratio: number; windowStart: string }
type DimensionKey = 'finance' | 'mood' | ActivityDim
type PeriodKey = 'today' | 'week' | 'month' | 'year'
interface SliceValue { count: number; amount?: number; minutes?: number }

interface PanelSummary {
  updatedAt: number
  month: string
  finance: {
    monthTotal: number
    monthCount: number
    byCategory: Array<{ category: string; amount: number; count: number }>
    daily: Array<{ date: string; amount: number }>
  }
  mood: {
    count: number
    average: number | null
    recent: Array<{ date: string; score: number; note?: string }>
  }
  activities: Record<ActivityDim, {
    monthCount: number
    monthMinutes: number
    byCategory: Array<{ category: string; count: number; minutes: number }>
    recent: Array<{ date: string; category: string; minutes?: number; note?: string }>
  }>
  categories: Record<CategoryDim, string[]>
  recent?: RecentItem[]
  goals?: GoalProgress[]
  heatmap?: Record<DimensionKey, Array<{ date: string; count: number }>>
  slices?: Record<DimensionKey, Record<PeriodKey, SliceValue>>
}

type Mutate = (op: 'add' | 'rename' | 'delete', dimension: CategoryDim, name: string, newName?: string) => Promise<void>
type Correct = (body: Record<string, unknown>) => Promise<void>
type QuickRecord = (body: Record<string, unknown>) => Promise<void>

const PERIOD_LABEL: Record<PeriodKey, string> = { today: '今日', week: '本周', month: '本月', year: '今年' }
const GOAL_METRIC_LABEL: Record<string, string> = {
  expenseTotal: '支出上限',
  activityDuration: '时长目标',
  activityCount: '次数目标',
  moodCount: '打卡目标',
}

/** 本插件实际用到的 client ctx 面（完整类型见 dsh-client-runtime）。 */
interface ClientContextLike {
  slots: {
    register(options: { name: string; id?: string; priority?: number }, component: unknown): () => void
  }
  effect(setup: () => (() => void) | void, label?: string): () => void
}

export const name = 'openprism-client'
export const inject = ['slots']

export function apply(ctx: ClientContextLike): void {
  ctx.effect(
    () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'openprism-panel' }, PanelFooterAction),
    'openprism: panel button',
  )
}

ensureStyle()

// ─── 侧栏按钮 ───

function PanelFooterAction(props: { wide?: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  return createElement(
    'button',
    {
      className: 'op-btn',
      title: 'OpenPrism 生活面板',
      type: 'button',
      onClick: () => { setOpen(true) },
    },
    props.wide === false ? '📊' : '📊 面板',
    open
      ? createPortal(createElement(PanelModal, { onClose: () => { setOpen(false) } }), document.body)
      : null,
  )
}

// ─── 面板模态（六维度分页） ───

function PanelModal(props: { onClose: () => void }): ReactNode {
  const [summary, setSummary] = useState<PanelSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')

  async function load(): Promise<void> {
    try {
      const response = await fetch('openprism/panel.json', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const data = (await response.json()) as PanelSummary
      setSummary(data)
      setError(null)
    } catch (cause) {
      setError(String(cause))
    }
  }

  async function mutate(op: 'add' | 'rename' | 'delete', dimension: CategoryDim, name: string, newName?: string): Promise<void> {
    const body = newName === undefined ? { op, dimension, name } : { op, dimension, name, newName }
    await postJson('openprism/categories', body)
    await load()
  }

  async function correct(body: Record<string, unknown>): Promise<void> {
    await postJson('openprism/corrections', body)
    await load()
  }

  async function quickRecord(body: Record<string, unknown>): Promise<void> {
    await postJson('openprism/records', body)
    await load()
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 5000)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [props.onClose])

  const updatedAt = summary === null ? null : new Date(summary.updatedAt).toLocaleTimeString('zh-CN')

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: '总览' },
    { key: 'mood', label: '❤️ 情感' },
    ...CATEGORY_DIMS.map((dim) => ({ key: dim, label: `${DIM_META[dim].emoji} ${DIM_META[dim].label}` })),
    { key: 'settings', label: '⚙ 设置' },
  ]

  return createElement(
    'div',
    { className: 'op-modal-backdrop', onClick: props.onClose },
    createElement(
      'div',
      {
        className: 'op-modal',
        role: 'dialog',
        'aria-label': 'OpenPrism 生活面板',
        onClick: (e: MouseEvent) => { e.stopPropagation() },
      },
      createElement(
        'header',
        { className: 'op-modal-header' },
        createElement('h2', null, 'OpenPrism 面板'),
        createElement(
          'span',
          { className: 'op-modal-meta' },
          error !== null ? `加载失败：${error}` : updatedAt === null ? '加载中…' : `更新于 ${updatedAt}`),
        createElement('button', { className: 'op-close', type: 'button', onClick: props.onClose }, '✕'),
      ),
      createElement(
        'nav',
        { className: 'op-tabs' },
        tabs.map((t) =>
          createElement(
            'button',
            {
              key: t.key,
              className: tab === t.key ? 'op-tab active' : 'op-tab',
              type: 'button',
              onClick: () => { setTab(t.key) },
            },
            t.label,
          ),
        ),
      ),
      tab === 'settings'
        ? createElement('div', { className: 'op-body' }, createElement(SettingsBody, null))
        : summary === null && error === null
          ? createElement('div', { className: 'op-empty' }, '加载中…')
          : summary === null
            ? createElement('div', { className: 'op-empty' }, '数据暂不可用')
            : createElement(
              'div',
              { className: 'op-body' },
              tab === 'overview' ? createElement(OverviewBody, { summary, correct })
                : tab === 'mood' ? createElement(MoodBody, { summary, correct, quickRecord })
                : tab === 'finance' ? createElement(FinanceBody, { summary, mutate, correct, quickRecord })
                : createElement(ActivityBody, { summary, dimension: tab, mutate, correct, quickRecord }),
            ),
    ),
  )
}

// ─── 总览 ───

function OverviewBody(props: { summary: PanelSummary; correct: Correct }): ReactNode {
  const { summary, correct } = props
  const cards = [
    statCard(`本月支出（${summary.month}）`, `¥${summary.finance.monthTotal.toFixed(2)}`, `${String(summary.finance.monthCount)} 笔`),
    statCard('心情均值', summary.mood.average === null ? '—' : `${summary.mood.average.toFixed(1)} / 5`, `${String(summary.mood.count)} 条`),
    ...ACTIVITY_DIMS.map((dim) =>
      statCard(
        `${DIM_META[dim].emoji} ${DIM_META[dim].label} · 本月`,
        `${String(summary.activities[dim].monthCount)} 条`,
        summary.activities[dim].monthMinutes > 0 ? fmtMinutes(summary.activities[dim].monthMinutes) : '—',
      ),
    ),
  ]
  return createElement(
    'div',
    { className: 'op-stack' },
    summary.goals !== undefined && summary.goals.length > 0 ? createElement(GoalBars, { goals: summary.goals }) : null,
    createElement('div', { className: 'op-stats' }, cards),
    DailyBars(summary),
    summary.mood.recent.length === 0
      ? null
      : section('最近心情', createElement(
        'ul',
        { className: 'op-moods' },
        summary.mood.recent.slice(0, 3).map((m, index) => moodRow(m, index)),
      )),
    createElement(RecentList, { summary, correct }),
  )
}

// ─── 💰 理财 ───

function FinanceBody(props: { summary: PanelSummary; mutate: Mutate; correct: Correct; quickRecord: QuickRecord }): ReactNode {
  const { summary, mutate, correct, quickRecord } = props
  return createElement(
    'div',
    { className: 'op-stack' },
    QuickForm({ dimension: 'finance', quickRecord }),
    SliceCard({ summary, dimension: 'finance' }),
    GoalBars({ goals: summary.goals ?? [], dimension: 'finance' }),
    createElement(
      'div',
      { className: 'op-stats' },
      statCard(`本月支出（${summary.month}）`, `¥${summary.finance.monthTotal.toFixed(2)}`, `${String(summary.finance.monthCount)} 笔`),
      statCard('本月分类数', String(summary.finance.byCategory.length), summary.categories.finance.length === 0 ? '' : `已定义 ${String(summary.categories.finance.length)} 类`),
    ),
    DailyBars(summary),
    Heatmap({ summary, dimension: 'finance' }),
    section('本月分类',
      summary.finance.byCategory.length === 0
        ? createElement('div', { className: 'op-empty' }, '本月暂无支出')
        : createElement(
          'div',
          { className: 'op-categories' },
          summary.finance.byCategory.map((c) =>
            createElement(
              'div',
              { key: c.category, className: 'op-category-row' },
              createElement('span', { className: 'op-category-name' }, c.category),
              createElement(
                'div',
                { className: 'op-category-track' },
                createElement('div', {
                  className: 'op-category-bar',
                  style: { width: `${(c.amount / Math.max(...summary.finance.byCategory.map((x) => x.amount), 1)) * 100}%` },
                }),
              ),
              createElement('span', { className: 'op-category-amount' }, `¥${c.amount.toFixed(2)}`),
            ),
          ),
        )),
    createElement(CategoryManager, { dimension: 'finance', list: summary.categories.finance, mutate }),
    createElement(RecentList, { summary, correct }),
  )
}

// ─── ❤️ 情感 ───

function MoodBody(props: { summary: PanelSummary; correct: Correct; quickRecord: QuickRecord }): ReactNode {
  const { summary, correct, quickRecord } = props
  return createElement(
    'div',
    { className: 'op-stack' },
    QuickForm({ dimension: 'mood', quickRecord }),
    SliceCard({ summary, dimension: 'mood' }),
    GoalBars({ goals: summary.goals ?? [], dimension: 'mood' }),
    createElement(
      'div',
      { className: 'op-stats' },
      statCard('心情均值', summary.mood.average === null ? '—' : `${summary.mood.average.toFixed(1)} / 5`, '全部记录'),
      statCard('记录条数', String(summary.mood.count), '1-5 分制'),
    ),
    Heatmap({ summary, dimension: 'mood' }),
    section('最近心情',
      summary.mood.recent.length === 0
        ? createElement('div', { className: 'op-empty' }, '暂无心情记录')
        : createElement(
          'ul',
          { className: 'op-moods' },
          summary.mood.recent.map((m, index) => moodRow(m, index)),
        )),
    createElement(RecentList, { summary, correct }),
  )
}

// ─── 🌱💼🏠📚 活动维度 ───

function ActivityBody(props: { summary: PanelSummary; dimension: ActivityDim; mutate: Mutate; correct: Correct; quickRecord: QuickRecord }): ReactNode {
  const { summary, dimension, mutate, correct, quickRecord } = props
  const s = summary.activities[dimension]
  const meta = DIM_META[dimension]
  return createElement(
    'div',
    { className: 'op-stack' },
    QuickForm({ dimension, quickRecord }),
    SliceCard({ summary, dimension }),
    GoalBars({ goals: summary.goals ?? [], dimension }),
    createElement(
      'div',
      { className: 'op-stats' },
      statCard(`${meta.emoji} ${meta.label} · 本月`, `${String(s.monthCount)} 条`, summary.month),
      statCard('本月时长', s.monthMinutes > 0 ? fmtMinutes(s.monthMinutes) : '—', '按记录的分钟数累计'),
    ),
    section('本月分类',
      s.byCategory.length === 0
        ? createElement('div', { className: 'op-empty' }, '本月暂无记录')
        : createElement(
          'div',
          { className: 'op-categories' },
          s.byCategory.map((c) =>
            createElement(
              'div',
              { key: c.category, className: 'op-category-row' },
              createElement('span', { className: 'op-category-name' }, c.category),
              createElement(
                'div',
                { className: 'op-category-track' },
                createElement('div', {
                  className: 'op-category-bar',
                  style: { width: `${(c.count / Math.max(...s.byCategory.map((x) => x.count), 1)) * 100}%` },
                }),
              ),
              createElement(
                'span',
                { className: 'op-category-amount' },
                c.minutes > 0 ? `${String(c.count)} 条 · ${fmtMinutes(c.minutes)}` : `${String(c.count)} 条`,
              ),
            ),
          ),
        )),
    section('最近记录',
      s.recent.length === 0
        ? createElement('div', { className: 'op-empty' }, '暂无记录')
        : createElement(
          'ul',
          { className: 'op-moods' },
          s.recent.map((r, index) =>
            createElement(
              'li',
              { key: `${r.date}-${String(index)}`, className: 'op-act-row' },
              createElement('span', { className: 'op-mood-date' }, r.date.slice(5)),
              createElement('span', { className: 'op-act-cat' }, r.category),
              createElement('span', { className: 'op-mood-note' }, r.note ?? ''),
              r.minutes !== undefined
                ? createElement('span', { className: 'op-act-min' }, fmtMinutes(r.minutes))
                : null,
            ),
          ),
        )),
    Heatmap({ summary, dimension }),
    createElement(CategoryManager, { dimension, list: summary.categories[dimension], mutate }),
    createElement(RecentList, { summary, correct }),
  )
}

// ─── 分类管理（自定义分类维度） ───

function CategoryManager(props: { dimension: CategoryDim; list: string[]; mutate: Mutate }): ReactNode {
  const { list, mutate } = props
  const [addValue, setAddValue] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function run(action: () => Promise<void>): void {
    if (busy) return
    setBusy(true)
    setError(null)
    void action().then(
      () => { setBusy(false) },
      (cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  const rows = list.map((name) =>
    renaming === name
      ? createElement(
        'div',
        { key: name, className: 'op-cat-row editing' },
        createElement('input', {
          className: 'op-input',
          value: renameValue,
          autoFocus: true,
          onChange: (e: { currentTarget: { value: string } }) => { setRenameValue(e.currentTarget.value) },
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              run(async () => { await mutate('rename', props.dimension, name, renameValue); setRenaming(null) })
            }
          },
        }),
        createElement(
          'button',
          {
            className: 'op-mini-btn primary',
            type: 'button',
            disabled: busy,
            onClick: () => { run(async () => { await mutate('rename', props.dimension, name, renameValue); setRenaming(null) }) },
          },
          '确定',
        ),
        createElement(
          'button',
          { className: 'op-mini-btn', type: 'button', disabled: busy, onClick: () => { setRenaming(null) } },
          '取消',
        ),
      )
      : createElement(
        'div',
        { key: name, className: 'op-cat-row' },
        createElement('span', { className: 'op-cat-name' }, name === '其他' ? `${name}（兜底）` : name),
        name === '其他' ? null : createElement(
          'button',
          {
            className: 'op-mini-btn',
            type: 'button',
            title: '改名（已有记录会跟随迁移）',
            disabled: busy,
            onClick: () => { setRenaming(name); setRenameValue(name) },
          },
          '✎',
        ),
        name === '其他' ? null : createElement(
          'button',
          {
            className: 'op-mini-btn danger',
            type: 'button',
            title: '删除（已有记录归入「其他」）',
            disabled: busy,
            onClick: () => { run(() => mutate('delete', props.dimension, name)) },
          },
          '✕',
        ),
      ),
  )

  return section('分类管理（自定义）', createElement(
    'div',
    { className: 'op-cat-manager' },
    ...rows,
    createElement(
      'div',
      { className: 'op-add-row' },
      createElement('input', {
        className: 'op-input',
        placeholder: '新分类名…',
        value: addValue,
        onChange: (e: { currentTarget: { value: string } }) => { setAddValue(e.currentTarget.value) },
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' && addValue.trim().length > 0) {
            run(async () => { await mutate('add', props.dimension, addValue.trim()); setAddValue('') })
          }
        },
      }),
      createElement(
        'button',
        {
          className: 'op-mini-btn primary',
          type: 'button',
          disabled: busy || addValue.trim().length === 0,
          onClick: () => { run(async () => { await mutate('add', props.dimension, addValue.trim()); setAddValue('') }) },
        },
        '添加',
      ),
    ),
    error === null ? null : createElement('div', { className: 'op-cat-error' }, error),
  ))
}

// ─── ⚙ 设置（定时任务，D7：面板里由用户设置，保存即生效） ───

interface ScheduleForm {
  distillTime: string | null
  dailyBriefingTime: string | null
  weeklyBriefingTime: string | null
  weeklyBriefingDay: number
}

const WEEK_DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

function SettingsBody(): ReactNode {
  const [form, setForm] = useState<ScheduleForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastTimes = useRef<Partial<Record<'distillTime' | 'dailyBriefingTime' | 'weeklyBriefingTime', string>>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('openprism/schedule', { cache: 'no-store' })
        const data = (await response.json()) as { schedule: ScheduleForm; description: string }
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        if (!cancelled) {
          setForm(data.schedule)
          for (const key of ['distillTime', 'dailyBriefingTime', 'weeklyBriefingTime'] as const) {
            if (data.schedule[key] !== null) lastTimes.current[key] = data.schedule[key] as string
          }
          setMessage(`当前：${data.description}`)
        }
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function save(): Promise<void> {
    if (form === null) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('openprism/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = (await response.json()) as { schedule?: ScheduleForm; description?: string; error?: string }
      if (!response.ok) throw new Error(data.error ?? `HTTP ${String(response.status)}`)
      if (data.schedule !== undefined) {
        setForm(data.schedule)
        for (const key of ['distillTime', 'dailyBriefingTime', 'weeklyBriefingTime'] as const) {
          if (data.schedule[key] !== null) lastTimes.current[key] = data.schedule[key] as string
        }
      }
      setMessage(`已保存，立即生效：${data.description ?? ''}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (form === null) {
    return section('定时任务', createElement('div', { className: 'op-empty' }, loadError ?? '加载中…'))
  }

  const setTime = (key: 'distillTime' | 'dailyBriefingTime' | 'weeklyBriefingTime', value: string | null): void => {
    setForm((f) => f === null ? f : { ...f, [key]: value })
    if (value !== null) lastTimes.current[key] = value
  }
  const toggle = (key: 'distillTime' | 'dailyBriefingTime' | 'weeklyBriefingTime', checked: boolean, fallback: string): void => {
    setForm((f) => f === null ? f : { ...f, [key]: checked ? (lastTimes.current[key] ?? fallback) : null })
  }
  const row = (label: string, hint: string, key: 'distillTime' | 'dailyBriefingTime' | 'weeklyBriefingTime', fallback: string, extra?: ReactNode): ReactNode =>
    createElement(
      'div',
      { key, className: 'op-sched-row' },
      createElement(
        'label',
        { className: 'op-sched-toggle' },
        createElement('input', {
          type: 'checkbox',
          checked: form[key] !== null,
          onChange: (e: { currentTarget: { checked: boolean } }) => { toggle(key, e.currentTarget.checked, fallback) },
        }),
        createElement('span', { className: 'op-sched-label' }, label),
      ),
      createElement('input', {
        className: 'op-sched-time',
        type: 'time',
        disabled: form[key] === null,
        value: form[key] ?? fallback,
        onChange: (e: { currentTarget: { value: string } }) => { setTime(key, e.currentTarget.value === '' ? null : e.currentTarget.value) },
      }),
      extra ?? null,
      createElement('span', { className: 'op-sched-hint' }, hint),
    )

  return section('定时任务（保存即生效，无需重启）', createElement(
    'div',
    { className: 'op-sched' },
    row('夜间提炼', '夜里批量整理白天采集的对话', 'distillTime', '03:00'),
    row('每日简报', '清晨生成昨日回顾 + 目标与超支提醒；关闭则启动补跑一并停', 'dailyBriefingTime', '07:00'),
    row(
      '每周周报',
      '本周 vs 上周对比 + 一段 AI 解读',
      'weeklyBriefingTime',
      '21:00',
      createElement(
        'select',
        {
          className: 'op-sched-day',
          disabled: form.weeklyBriefingTime === null,
          value: String(form.weeklyBriefingDay),
          onChange: (e: { currentTarget: { value: string } }) => {
            setForm((f) => f === null ? f : { ...f, weeklyBriefingDay: Number(e.currentTarget.value) })
          },
        },
        WEEK_DAY_LABELS.map((label, day) => createElement('option', { key: String(day), value: String(day) }, label)),
      ),
    ),
    createElement(
      'div',
      { className: 'op-add-row' },
      createElement('span', { className: 'op-sched-note' }, '改动持久化保存，重启后依然有效'),
      createElement(
        'button',
        { className: 'op-mini-btn primary op-form-btn', type: 'button', disabled: busy, onClick: () => { void save() } },
        busy ? '…' : '保存',
      ),
    ),
    message === null ? null : createElement('div', { className: 'op-sched-msg' }, message),
    error === null ? null : createElement('div', { className: 'op-cat-error' }, error),
  ))
}

// ─── 共享小组件 ───

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: { error?: string } | null = null
  try { data = await response.json() as { error?: string } } catch { /* 空体 */ }
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${String(response.status)}`)
}

// ─── 目标进度（6.1） ───

function GoalBars(props: { goals: GoalProgress[]; dimension?: string }): ReactNode {
  const goals = props.dimension === undefined
    ? props.goals
    : props.goals.filter((g) => g.dimension === props.dimension)
  if (goals.length === 0) return null
  return section('目标进度', createElement(
    'div',
    { className: 'op-goals' },
    goals.map((g) => {
      const percent = Math.min(Math.round(g.ratio * 100), 999)
      const over = g.ratio > 1
      const targetLabel = g.metric === 'expenseTotal' ? `¥${String(g.target)}` : `${String(g.target)}`
      const currentLabel = g.metric === 'expenseTotal' ? `¥${String(Math.round(g.current))}` : `${String(Math.round(g.current))}`
      return createElement(
        'div',
        { key: g.id, className: 'op-goal-row' },
        createElement(
          'div',
          { className: 'op-goal-head' },
          createElement('span', { className: 'op-goal-title' },
            `${g.note ?? `${GOAL_METRIC_LABEL[g.metric] ?? g.metric}`}（${PERIOD_LABEL[g.period === 'daily' ? 'today' : g.period === 'weekly' ? 'week' : 'month']}）`),
          createElement('span', { className: over ? 'op-goal-value over' : 'op-goal-value' },
            `${currentLabel} / ${targetLabel}`),
        ),
        createElement(
          'div',
          { className: 'op-goal-track' },
          createElement('div', {
            className: over ? 'op-goal-bar over' : 'op-goal-bar',
            style: { width: `${Math.min(percent, 100)}%` },
          }),
        ),
      )
    }),
  ))
}

// ─── 周期切片（今日/本周/本月/今年） ───

function SliceCard(props: { summary: PanelSummary; dimension: DimensionKey }): ReactNode {
  const slices = props.summary.slices?.[props.dimension]
  if (slices === undefined) return null
  const periods: PeriodKey[] = ['today', 'week', 'month', 'year']
  return createElement('div', { className: 'op-slices' },
    periods.map((p) => {
      const v = slices[p]
      const value = props.dimension === 'finance' && v.amount !== undefined
        ? `¥${String(Math.round(v.amount))}`
        : v.minutes !== undefined && v.minutes > 0
          ? `${String(Math.round(v.minutes / 60 * 10) / 10)}h`
          : `${String(v.count)}`
      return createElement(
        'div',
        { key: p, className: 'op-slice' },
        createElement('span', { className: 'op-slice-label' }, PERIOD_LABEL[p]),
        createElement('span', { className: 'op-slice-value' }, value),
        createElement('span', { className: 'op-slice-count' }, `${String(v.count)} 条`),
      )
    }),
  )
}

// ─── 记录密度热力图（近 91 天） ───

function Heatmap(props: { summary: PanelSummary; dimension: DimensionKey }): ReactNode {
  const heat = props.summary.heatmap?.[props.dimension]
  if (heat === undefined || heat.length === 0) return null
  const max = Math.max(...heat.map((d) => d.count), 1)
  const weeks: Array<Array<{ date: string; count: number } | null>> = []
  let current: Array<{ date: string; count: number } | null> = []
  heat.forEach((d, index) => {
    const dow = (new Date(`${d.date}T00:00:00`).getDay() + 6) % 7
    if (index === 0 && dow > 0) for (let i = 0; i < dow; i++) current.push(null)
    current.push(d)
    if (current.length === 7) { weeks.push(current); current = [] }
  })
  if (current.length > 0) weeks.push(current)
  return section('记录密度（近 91 天）', createElement(
    'div',
    { className: 'op-heat' },
    weeks.map((week, wi) => createElement('div', { key: String(wi), className: 'op-heat-col' },
      week.map((day, di) => {
        if (day === null) return createElement('div', { key: String(di), className: 'op-heat-cell empty' })
        const level = day.count === 0 ? 0 : Math.ceil((day.count / max) * 4)
        return createElement('div', {
          key: day.date,
          className: `op-heat-cell l${String(level)}`,
          title: `${day.date}：${String(day.count)} 条`,
        })
      }),
    ))),
  )
}

// ─── 最近记录（删除/编辑入口，4.1 的 UI 半边） ───

function RecentList(props: { summary: PanelSummary; correct: Correct }): ReactNode {
  const recent = props.summary.recent ?? []
  const [busy, setBusy] = useState(false)
  if (recent.length === 0) return null
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  return section('最近记录（可删除）', createElement(
    'ul',
    { className: 'op-recent-list' },
    recent.map((item) => createElement(
      'li',
      { key: item.id, className: 'op-recent-row' },
      createElement('span', { className: 'op-mood-date' }, item.date.slice(5)),
      createElement('span', { className: 'op-recent-title' }, item.title),
      (item.kind === 'expense' || item.kind === 'mood') && !busy ? createElement('button', {
        className: 'op-mini-btn',
        type: 'button',
        title: '改数值',
        onClick: () => {
          const raw = window.prompt(item.kind === 'expense' ? '改为新金额（元）' : '改为新心情分（1-5）')
          if (raw === null) return
          const value = item.kind === 'expense' ? Number(raw) : Number(Math.round(Number(raw)))
          if (item.kind === 'expense' ? !(value > 0) : !(value >= 1 && value <= 5)) { window.alert('数值无效'); return }
          void run(async () => { await props.correct({ op: 'update', target: item.id, amount: value, score: value }) })
        },
      }, '✎') : null,
      !busy ? createElement('button', {
        className: 'op-mini-btn danger',
        type: 'button',
        title: '删除该记录',
        onClick: () => { if (window.confirm('删除这条记录？')) void run(async () => { await props.correct({ op: 'delete', target: item.id }) }) },
      }, '✕') : null,
    )),
  ))
}

// ─── 速记表单（不经模型） ───

function QuickForm(props: { dimension: 'finance' | 'mood' | ActivityDim; quickRecord: QuickRecord }): ReactNode {
  const dimension = props.dimension
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const [minutes, setMinutes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      if (dimension === 'finance') {
        await props.quickRecord({ kind: 'expense', amount: Number(amount), category: category.trim().length > 0 ? category.trim() : '其他', ...(note.trim() ? { note: note.trim() } : {}) })
      } else if (dimension === 'mood') {
        await props.quickRecord({ kind: 'mood', score: Number(amount) })
      } else {
        await props.quickRecord({
          kind: 'activity', dimension, category: category.trim().length > 0 ? category.trim() : '其他',
          ...(minutes !== '' && Number(minutes) > 0 ? { durationMinutes: Number(minutes) } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        })
      }
      setAmount(''); setCategory(''); setNote(''); setMinutes('')
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const fields: ReactNode[] = []
  if (dimension === 'finance') {
    fields.push(createElement('input', { key: 'a', className: 'op-input', type: 'number', placeholder: '金额（元）', value: amount, onChange: (e: { currentTarget: { value: string } }) => { setAmount(e.currentTarget.value) } }))
    fields.push(createElement('input', { key: 'c', className: 'op-input', placeholder: '分类（默认「其他」）', value: category, onChange: (e: { currentTarget: { value: string } }) => { setCategory(e.currentTarget.value) } }))
  } else if (dimension === 'mood') {
    fields.push(createElement('input', { key: 'a', className: 'op-input', type: 'number', min: 1, max: 5, placeholder: '心情分 1-5', value: amount, onChange: (e: { currentTarget: { value: string } }) => { setAmount(e.currentTarget.value) } }))
  } else {
    fields.push(createElement('input', { key: 'c', className: 'op-input', placeholder: '分类（默认「其他」）', value: category, onChange: (e: { currentTarget: { value: string } }) => { setCategory(e.currentTarget.value) } }))
    fields.push(createElement('input', { key: 'm', className: 'op-input', type: 'number', placeholder: '分钟（可选）', value: minutes, onChange: (e: { currentTarget: { value: string } }) => { setMinutes(e.currentTarget.value) } }))
  }
  if (dimension !== 'mood') {
    fields.push(createElement('input', { key: 'n', className: 'op-input', placeholder: '备注（可选）', value: note, onChange: (e: { currentTarget: { value: string } }) => { setNote(e.currentTarget.value) } }))
  }
  const valid = dimension === 'mood'
    ? Number(amount) >= 1 && Number(amount) <= 5
    : dimension === 'finance' ? Number(amount) > 0 : category.trim().length > 0 || true
  return section('速记（直接落库，不经模型）', createElement(
    'div',
    { className: 'op-form' },
    ...fields,
    createElement('button', {
      className: 'op-mini-btn primary op-form-btn',
      type: 'button',
      disabled: busy || !valid,
      onClick: () => { void submit() },
    }, busy ? '…' : '记一笔'),
    error === null ? null : createElement('div', { className: 'op-cat-error' }, error),
  ))
}

function DailyBars(summary: PanelSummary): ReactNode {
  const daily = summary.finance.daily
  const dailyMax = Math.max(...daily.map((d) => d.amount), 1)
  const today = new Date().getDate()
  return section('近 14 天支出',
    createElement(
      'div',
      { className: 'op-daily' },
      daily.map((d) =>
        createElement(
          'div',
          {
            key: d.date,
            className: 'op-daily-col',
            title: `${d.date}：¥${d.amount.toFixed(2)}`,
          },
          createElement('span', { className: 'op-daily-amount' }, d.amount > 0 ? String(Math.round(d.amount)) : ''),
          createElement('div', {
            className: 'op-daily-bar',
            style: { height: `${Math.max((d.amount / dailyMax) * 100, d.amount > 0 ? 6 : 2)}%` },
          }),
          createElement('span', { className: 'op-daily-day' }, String(Number(d.date.slice(8)) === today ? '今' : Number(d.date.slice(8)))),
        ),
      ),
    ),
  )
}

function moodRow(m: { date: string; score: number; note?: string }, index: number): ReactNode {
  return createElement(
    'li',
    { key: `${m.date}-${String(index)}`, className: 'op-mood-row' },
    createElement('span', { className: 'op-mood-date' }, m.date.slice(5)),
    createElement('span', { className: 'op-mood-stars' }, '★'.repeat(m.score) + '☆'.repeat(5 - m.score)),
    createElement('span', { className: 'op-mood-note' }, m.note ?? ''),
  )
}

function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${String(h)} 小时` : `${String(h)} 小时 ${String(m)} 分`
}

function statCard(title: string, value: string, sub: string): ReactNode {
  return createElement(
    'div',
    { className: 'op-stat' },
    createElement('span', { className: 'op-stat-title' }, title),
    createElement('span', { className: 'op-stat-value' }, value),
    createElement('span', { className: 'op-stat-sub' }, sub),
  )
}

function section(title: string, children: ReactNode): ReactNode {
  return createElement(
    'section',
    { className: 'op-section' },
    createElement('h3', null, title),
    children,
  )
}

// ─── 样式（一次性注入，dark 友好的半透明配色） ───

function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin="openprism"]') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'openprism'
  style.textContent = `
.op-btn{display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;border:none;border-radius:8px;
  background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.8}
.op-btn:hover{background:rgba(127,127,127,.15);opacity:1}
.op-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);
  display:flex;align-items:center;justify-content:center;padding:24px}
.op-modal{width:min(680px,94vw);max-height:88vh;overflow:auto;border-radius:16px;
  background:rgba(28,28,34,.96);color:#e8e8ee;box-shadow:0 20px 60px rgba(0,0,0,.5);
  border:1px solid rgba(127,127,127,.25)}
.op-modal-header{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:12px;
  padding:16px 20px;background:inherit;border-bottom:1px solid rgba(127,127,127,.2)}
.op-modal-header h2{margin:0;font-size:16px}
.op-modal-meta{flex:1;font-size:12px;opacity:.6}
.op-close{border:none;background:transparent;color:inherit;font-size:16px;cursor:pointer;opacity:.7}
.op-close:hover{opacity:1}
.op-tabs{position:sticky;top:57px;z-index:1;display:flex;gap:2px;flex-wrap:wrap;
  padding:8px 12px 0;background:inherit;border-bottom:1px solid rgba(127,127,127,.15)}
.op-tab{padding:6px 10px;border:none;border-radius:8px;background:transparent;color:inherit;
  font:inherit;font-size:12px;cursor:pointer;opacity:.6}
.op-tab:hover{opacity:.9;background:rgba(127,127,127,.1)}
.op-tab.active{background:rgba(99,102,241,.25);opacity:1}
.op-body{padding:20px}
.op-stack{display:flex;flex-direction:column;gap:20px}
.op-stats{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.op-stat{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:12px;
  background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.18)}
.op-stat-title{font-size:12px;opacity:.65}
.op-stat-value{font-size:22px;font-weight:600;color:#a5b4fc}
.op-stat-sub{font-size:12px;opacity:.55}
.op-section h3{margin:0 0 10px;font-size:13px;font-weight:600;opacity:.75}
.op-daily{display:flex;align-items:flex-end;gap:4px;height:110px;padding:8px;
  background:rgba(127,127,127,.08);border-radius:12px}
.op-daily-col{flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px}
.op-daily-amount{font-size:9px;opacity:.7}
.op-daily-bar{width:70%;max-width:22px;border-radius:3px 3px 0 0;
  background:linear-gradient(180deg,#818cf8,#6366f1);min-height:2px}
.op-daily-day{font-size:9px;opacity:.5}
.op-categories{display:flex;flex-direction:column;gap:8px}
.op-category-row{display:grid;grid-template-columns:56px 1fr 110px;align-items:center;gap:10px}
.op-category-name{font-size:12px;opacity:.8}
.op-category-track{height:10px;border-radius:5px;background:rgba(127,127,127,.15);overflow:hidden}
.op-category-bar{height:100%;border-radius:5px;background:linear-gradient(90deg,#6366f1,#8b5cf6)}
.op-category-amount{font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.op-moods{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.op-mood-row{display:grid;grid-template-columns:44px 70px 1fr;align-items:center;gap:10px;
  padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.08)}
.op-mood-date{font-size:12px;opacity:.6}
.op-mood-stars{color:#fbbf24;font-size:12px;letter-spacing:1px}
.op-mood-note{font-size:12px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op-act-row{display:grid;grid-template-columns:44px 64px 1fr auto;align-items:center;gap:10px;
  padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.08)}
.op-act-cat{font-size:12px;opacity:.85}
.op-act-min{font-size:12px;opacity:.6;font-variant-numeric:tabular-nums}
.op-cat-manager{display:flex;flex-direction:column;gap:2px}
.op-cat-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;min-height:30px}
.op-cat-row:hover{background:rgba(127,127,127,.1)}
.op-cat-row.editing{background:rgba(127,127,127,.12)}
.op-cat-name{flex:1;font-size:12px}
.op-mini-btn{border:none;background:transparent;color:inherit;cursor:pointer;font-size:12px;
  opacity:.55;padding:3px 8px;border-radius:6px}
.op-mini-btn:hover{opacity:1;background:rgba(127,127,127,.2)}
.op-mini-btn:disabled{opacity:.3;cursor:default}
.op-mini-btn.primary{background:rgba(99,102,241,.35);opacity:1}
.op-mini-btn.danger:hover{background:rgba(248,113,113,.25)}
.op-input{background:rgba(127,127,127,.15);border:1px solid rgba(127,127,127,.3);border-radius:6px;
  color:inherit;font:inherit;font-size:12px;padding:4px 8px;min-width:0;flex:1}
.op-input:focus{outline:none;border-color:#818cf8}
.op-add-row{display:flex;gap:6px;margin-top:6px}
.op-add-row .op-input{flex:1}
.op-add-row .op-mini-btn{flex:none;opacity:1}
.op-cat-error{color:#f87171;font-size:11px;padding:4px 6px}
.op-empty{padding:20px;text-align:center;font-size:13px;opacity:.5}
.op-goals{display:flex;flex-direction:column;gap:10px}
.op-goal-row{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:12px;
  background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.18)}
.op-goal-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.op-goal-title{font-size:12px;opacity:.8}
.op-goal-value{font-size:12px;font-variant-numeric:tabular-nums;opacity:.85}
.op-goal-value.over{color:#f87171}
.op-goal-track{height:8px;border-radius:4px;background:rgba(127,127,127,.15);overflow:hidden}
.op-goal-bar{height:100%;border-radius:4px;background:linear-gradient(90deg,#34d399,#10b981)}
.op-goal-bar.over{background:linear-gradient(90deg,#f87171,#ef4444)}
.op-slices{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.op-slice{display:flex;flex-direction:column;gap:2px;padding:10px 8px;border-radius:12px;
  background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.16);text-align:center}
.op-slice-label{font-size:11px;opacity:.6}
.op-slice-value{font-size:16px;font-weight:600;color:#a5b4fc;font-variant-numeric:tabular-nums}
.op-slice-count{font-size:10px;opacity:.5}
.op-heat{display:flex;gap:3px;overflow-x:auto;padding:8px;background:rgba(127,127,127,.08);border-radius:12px}
.op-heat-col{display:flex;flex-direction:column;gap:3px}
.op-heat-cell{width:11px;height:11px;border-radius:3px;background:rgba(127,127,127,.12)}
.op-heat-cell.l1{background:rgba(129,140,248,.35)}
.op-heat-cell.l2{background:rgba(129,140,248,.55)}
.op-heat-cell.l3{background:rgba(129,140,248,.8)}
.op-heat-cell.l4{background:#818cf8}
.op-recent-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.op-recent-row{display:grid;grid-template-columns:44px 1fr auto auto;align-items:center;gap:8px;
  padding:6px 10px;border-radius:8px;background:rgba(127,127,127,.08)}
.op-recent-title{font-size:12px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op-form{display:flex;flex-wrap:wrap;gap:6px;align-items:center;
  padding:10px 12px;border-radius:12px;background:rgba(127,127,127,.1);border:1px dashed rgba(127,127,127,.3)}
.op-form .op-input{flex:1;min-width:90px}
.op-form-btn{flex:none;opacity:1;padding:6px 14px}
.op-sched{display:flex;flex-direction:column;gap:8px}
.op-sched-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;
  background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.16)}
.op-sched-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:140px;font-size:12px;cursor:pointer}
.op-sched-toggle input[type=checkbox]{accent-color:#818cf8;width:14px;height:14px;cursor:pointer}
.op-sched-label{font-size:12px;opacity:.85}
.op-sched-time,.op-sched-day{flex:none;width:104px;background:rgba(127,127,127,.15);
  border:1px solid rgba(127,127,127,.3);border-radius:6px;color:inherit;font:inherit;font-size:12px;padding:4px 6px}
.op-sched-time:disabled,.op-sched-day:disabled{opacity:.35}
.op-sched-time:focus,.op-sched-day:focus{outline:none;border-color:#818cf8}
.op-sched-hint{flex-basis:100%;font-size:11px;opacity:.5;margin-left:22px}
.op-sched-note{flex:1;font-size:11px;opacity:.55}
.op-sched-msg{font-size:11px;color:#34d399;padding:4px 6px}
@media (max-width:640px){
  .op-modal-backdrop{padding:0;align-items:stretch}
  .op-modal{width:100vw;max-height:100vh;height:100vh;border-radius:0;border:none}
  .op-body{padding:14px}
  .op-stats{grid-template-columns:1fr 1fr;gap:8px}
  .op-stat-value{font-size:18px}
  .op-tabs{top:53px}
  .op-slices{grid-template-columns:repeat(2,1fr)}
  .op-heat-cell{width:9px;height:9px}
}
`
  document.head.appendChild(style)
}
