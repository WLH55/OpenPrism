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

import { createElement, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ─── 与宿主 panel.ts 对应的形状（浏览器半边自持副本，避免跨包类型耦合） ───

type ActivityDim = 'life' | 'work' | 'family' | 'study'
type CategoryDim = 'finance' | ActivityDim
type TabKey = 'overview' | 'mood' | CategoryDim

const CATEGORY_DIMS: CategoryDim[] = ['finance', 'life', 'work', 'family', 'study']
const ACTIVITY_DIMS: ActivityDim[] = ['life', 'work', 'family', 'study']

const DIM_META: Record<CategoryDim, { emoji: string; label: string }> = {
  finance: { emoji: '💰', label: '理财' },
  life: { emoji: '🌱', label: '生活' },
  work: { emoji: '💼', label: '工作' },
  family: { emoji: '🏠', label: '家庭' },
  study: { emoji: '📚', label: '学习' },
}

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
}

type Mutate = (op: 'add' | 'rename' | 'delete', dimension: CategoryDim, name: string, newName?: string) => Promise<void>

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
    const response = await fetch('openprism/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data: { error?: string } | null = null
    try { data = await response.json() as { error?: string } } catch { /* 空体 */ }
    if (!response.ok) throw new Error(data?.error ?? `HTTP ${String(response.status)}`)
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
      summary === null && error === null
        ? createElement('div', { className: 'op-empty' }, '加载中…')
        : summary === null
          ? createElement('div', { className: 'op-empty' }, '数据暂不可用')
          : createElement(
            'div',
            { className: 'op-body' },
            tab === 'overview' ? createElement(OverviewBody, { summary })
              : tab === 'mood' ? createElement(MoodBody, { summary })
              : tab === 'finance' ? createElement(FinanceBody, { summary, mutate })
              : createElement(ActivityBody, { summary, dimension: tab, mutate }),
          ),
    ),
  )
}

// ─── 总览 ───

function OverviewBody(props: { summary: PanelSummary }): ReactNode {
  const { summary } = props
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
    createElement('div', { className: 'op-stats' }, cards),
    DailyBars(summary),
    summary.mood.recent.length === 0
      ? null
      : section('最近心情', createElement(
        'ul',
        { className: 'op-moods' },
        summary.mood.recent.slice(0, 3).map((m, index) => moodRow(m, index)),
      )),
  )
}

// ─── 💰 理财 ───

function FinanceBody(props: { summary: PanelSummary; mutate: Mutate }): ReactNode {
  const { summary, mutate } = props
  return createElement(
    'div',
    { className: 'op-stack' },
    createElement(
      'div',
      { className: 'op-stats' },
      statCard(`本月支出（${summary.month}）`, `¥${summary.finance.monthTotal.toFixed(2)}`, `${String(summary.finance.monthCount)} 笔`),
      statCard('本月分类数', String(summary.finance.byCategory.length), summary.categories.finance.length === 0 ? '' : `已定义 ${String(summary.categories.finance.length)} 类`),
    ),
    DailyBars(summary),
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
  )
}

// ─── ❤️ 情感 ───

function MoodBody(props: { summary: PanelSummary }): ReactNode {
  const { summary } = props
  return createElement(
    'div',
    { className: 'op-stack' },
    createElement(
      'div',
      { className: 'op-stats' },
      statCard('心情均值', summary.mood.average === null ? '—' : `${summary.mood.average.toFixed(1)} / 5`, '全部记录'),
      statCard('记录条数', String(summary.mood.count), '1-5 分制'),
    ),
    section('最近心情',
      summary.mood.recent.length === 0
        ? createElement('div', { className: 'op-empty' }, '暂无心情记录')
        : createElement(
          'ul',
          { className: 'op-moods' },
          summary.mood.recent.map((m, index) => moodRow(m, index)),
        )),
  )
}

// ─── 🌱💼🏠📚 活动维度 ───

function ActivityBody(props: { summary: PanelSummary; dimension: ActivityDim; mutate: Mutate }): ReactNode {
  const { summary, dimension, mutate } = props
  const s = summary.activities[dimension]
  const meta = DIM_META[dimension]
  return createElement(
    'div',
    { className: 'op-stack' },
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
    createElement(CategoryManager, { dimension, list: summary.categories[dimension], mutate }),
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

// ─── 共享小组件 ───

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
`
  document.head.appendChild(style)
}
