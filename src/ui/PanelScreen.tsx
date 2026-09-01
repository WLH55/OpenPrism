/**
 * 面板屏（批次 2）：六维度分页（周期切片 今日/本周/本月/今年）+ 分类聚合 + 14 天趋势 +
 * 91 天热力图 + 目标进度条 + 最近记录；头部进速记表单（source: 'ui'）与手动简报
 * （数据章节零 token 从折叠直接出，AI 解读可选、由厂商配置驱动）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native'
import { randomUUID } from 'expo-crypto'
import { sharedEventStore } from '../store/store'
import { saveReport, listReportFiles, readReport } from '../store/reports'
import { resolveCurrentProvider } from '../store/providers'
import { foldEvents, periodWindow, DIMENSION_ORDER } from '../domain/fold'
import type { Folded, GoalProgress } from '../domain/fold'
import { buildPanel } from '../domain/panel'
import type { PanelData, PeriodKey } from '../domain/panel'
import type { File } from 'expo-file-system'
import {
  makeActivity,
  makeCategory,
  makeExpense,
  makeMood,
  type OpenEvent,
} from '../domain/events'
import type { ActivityDimension, CategoryDimension, Dimension } from '../domain/types'
import { DIMENSION_META, PERIOD_LABEL, WEEKDAY_LABEL } from '../domain/types'
import { buildBriefing } from '../domain/briefing'
import type { BriefingKind } from '../domain/briefing'
import { chatCompletion } from '../llm/client'
import { LlmError, friendlyLlmMessage } from '../llm/errors'

const SLICE_LABEL: Record<PeriodKey, string> = { today: '今日', week: '本周', month: '本月', year: '今年' }
const SLICE_TO_WINDOW: Record<PeriodKey, 'day' | 'week' | 'month' | 'year'> = {
  today: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
}
const ACTIVITY_DIMS: ActivityDimension[] = ['life', 'work', 'family', 'study']
const DAY_MS = 24 * 60 * 60 * 1000

interface Board {
  folded: Folded
  panel: PanelData
  now: number
}

export function PanelScreen() {
  const [board, setBoard] = useState<Board | null>(null)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [page, setPage] = useState(0)
  const [quickVisible, setQuickVisible] = useState(false)
  const [briefVisible, setBriefVisible] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const { width } = useWindowDimensions()

  const reload = useCallback(async (): Promise<Folded> => {
    const now = Date.now()
    const folded = foldEvents(await sharedEventStore.loadAll(), now)
    setBoard({ folded, panel: buildPanel(folded, now), now })
    return folded
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast(null), 2500)
  }, [])

  if (!board) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>面板</Text>
        </View>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#2f6fed" />
        </View>
      </View>
    )
  }

  const { panel } = board

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>面板</Text>
        <View style={styles.headerActions}>
          <Pressable hitSlop={8} onPress={() => setBriefVisible(true)}>
            <Text style={styles.headerAction}>简报</Text>
          </Pressable>
          <Pressable hitSlop={8} onPress={() => setQuickVisible(true)}>
            <Text style={styles.headerAction}>＋ 速记</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.chipRow}>
        {(Object.keys(SLICE_LABEL) as PeriodKey[]).map((key) => (
          <Pressable
            key={key}
            style={[styles.chip, period === key && styles.chipOn]}
            onPress={() => setPeriod(key)}
          >
            <Text style={[styles.chipText, period === key && styles.chipTextOn]}>{SLICE_LABEL[key]}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={styles.pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {DIMENSION_ORDER.map((dim) => (
          <View key={dim} style={{ width }}>
            <DimensionPage board={board} dim={dim} period={period} />
          </View>
        ))}
      </ScrollView>

      <View style={styles.dots}>
        {DIMENSION_ORDER.map((dim, i) => (
          <View key={dim} style={[styles.dot, page === i && styles.dotOn]} />
        ))}
      </View>

      <View style={styles.recentCard}>
        <Text style={styles.cardTitle}>🕘 最近记录</Text>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
          {panel.recent.length === 0 ? (
            <Text style={styles.empty}>还没有记录——去对话页或点「＋ 速记」记第一笔</Text>
          ) : (
            panel.recent.map((r) => (
              <View key={r.id} style={styles.recentRow}>
                <Text style={styles.recentEmoji}>{DIMENSION_META[r.dimension].emoji}</Text>
                <Text style={styles.recentTitle} numberOfLines={1}>
                  {r.title}
                </Text>
                <Text style={styles.recentDate}>{r.dateLabel.slice(5)}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>

      {toast ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      <QuickRecordModal
        visible={quickVisible}
        onClose={() => setQuickVisible(false)}
        onSaved={async (message) => {
          setQuickVisible(false)
          await reload()
          showToast(message)
        }}
      />
      <BriefingModal visible={briefVisible} onClose={() => setBriefVisible(false)} reload={reload} />
    </View>
  )
}

// ─── 单维度页 ───

function DimensionPage({ board, dim, period }: { board: Board; dim: Dimension; period: PeriodKey }) {
  const { folded, panel, now } = board
  const meta = DIMENSION_META[dim]
  const slice = panel.slices[dim]?.[period] ?? { count: 0, amount: 0, minutes: 0 }

  const win = periodWindow(SLICE_TO_WINDOW[period], now)
  const winRecords = folded.records.filter((r) => r.occurredAt >= win.start && r.occurredAt < win.end)
  const moodAvg = useMemo(() => {
    const moods = winRecords.filter((r) => r.kind === 'mood')
    if (!moods.length) return null
    const total = moods.reduce((s, r) => s + (r.kind === 'mood' ? r.score : 0), 0)
    return Math.round((total / moods.length) * 10) / 10
  }, [winRecords])

  const goals = folded.goalProgress.filter((gp) => gp.goal.event.dimension === dim)

  const hero =
    dim === 'finance'
      ? `¥${Math.round(slice.amount)}`
      : dim === 'mood'
        ? `${slice.count} 条${moodAvg !== null ? ` · 均值 ${moodAvg}` : ''}`
        : `${slice.count} 条 · ${slice.minutes} 分钟`

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent}>
      <View style={styles.heroCard}>
        <Text style={styles.heroEmoji}>{meta.emoji}</Text>
        <Text style={styles.heroLabel}>
          {meta.label} · {SLICE_LABEL[period]}
        </Text>
        <Text style={styles.heroValue}>{hero}</Text>
      </View>

      {dim === 'finance' ? <FinanceDetail panel={panel} /> : null}
      {dim === 'mood' ? <MoodDetail panel={panel} /> : null}
      {ACTIVITY_DIMS.includes(dim as ActivityDimension) ? <ActivityDetail panel={panel} dim={dim as ActivityDimension} /> : null}

      <HeatmapCard counts={panel.heatmap[dim]} />

      {goals.length ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🎯 {meta.label}目标</Text>
          {goals.map((gp) => (
            <GoalBar key={gp.goal.key} gp={gp} now={now} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  )
}

function FinanceDetail({ panel }: { panel: PanelData }) {
  const cats = panel.finance.byCategory
  const max = Math.max(...cats.map((c) => c.amount), 1)
  const daily = panel.finance.daily
  const maxDaily = Math.max(...daily.map((d) => d.amount), 1)
  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>本月分类 · 合计 ¥{Math.round(panel.finance.monthTotal)}</Text>
        {cats.length === 0 ? (
          <Text style={styles.empty}>本月暂无支出</Text>
        ) : (
          cats.map((c) => (
            <View key={c.category} style={styles.barRow}>
              <View style={styles.barHead}>
                <Text style={styles.barName}>
                  {c.category} · {c.count} 笔
                </Text>
                <Text style={styles.barValue}>¥{Math.round(c.amount)}</Text>
              </View>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${(c.amount / max) * 100}%` }]} />
              </View>
            </View>
          ))
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>近 14 天支出</Text>
        <View style={styles.dailyRow}>
          {daily.map((d) => (
            <View key={d.date} style={styles.dailyCol}>
              <View style={styles.dailyTrack}>
                <View
                  style={[
                    styles.dailyBar,
                    { height: `${Math.max((d.amount / maxDaily) * 100, d.amount > 0 ? 8 : 0)}%` },
                  ]}
                />
              </View>
            </View>
          ))}
        </View>
        <View style={styles.dailyCaption}>
          <Text style={styles.dailyCaptionText}>{daily[0]?.date.slice(5)}</Text>
          <Text style={styles.dailyCaptionText}>今天</Text>
        </View>
      </View>
    </>
  )
}

function MoodDetail({ panel }: { panel: PanelData }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>本月均值 {panel.mood.average ?? '—'}</Text>
      {panel.mood.recent.length === 0 ? (
        <Text style={styles.empty}>本月暂无心情记录</Text>
      ) : (
        <View style={styles.moodChips}>
          {panel.mood.recent.map((r, i) => (
            <View key={`${r.date}-${i}`} style={styles.moodChip}>
              <Text style={styles.moodScore}>{r.score}</Text>
              <Text style={styles.moodDate}>{r.date.slice(5)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function ActivityDetail({ panel, dim }: { panel: PanelData; dim: ActivityDimension }) {
  const a = panel.activities[dim]
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        本月 {a.monthCount} 条 · {a.monthMinutes} 分钟
      </Text>
      {a.byCategory.length === 0 ? (
        <Text style={styles.empty}>本月暂无活动</Text>
      ) : (
        a.byCategory.map((c) => (
          <View key={c.category} style={styles.activityRow}>
            <Text style={styles.barName}>{c.category}</Text>
            <Text style={styles.barValue}>
              {c.count} 次{c.minutes ? ` / ${c.minutes} 分` : ''}
            </Text>
          </View>
        ))
      )}
    </View>
  )
}

/** 91 天热力图：13 列（周）× 7 行（周一到周日），末列未来日期留空。 */
function HeatmapCard({ counts }: { counts?: Record<string, number> }) {
  const { width } = useWindowDimensions()
  const grid = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // 13 列恰好收尾于本周：起点 = 本周一 - 12 周，本周末尾的未来日期留空
    const start = new Date(today)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 12 * 7)
    const cells: Array<{ key: string; count: number | null }> = []
    for (let i = 0; i < 13 * 7; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      const key = fmtDay(d.getTime())
      cells.push({ key, count: d.getTime() > today.getTime() ? null : (counts?.[key] ?? 0) })
    }
    return cells
  }, [counts])

  const size = Math.min(18, Math.floor((width - 104) / 13))
  const total = grid.reduce((s, c) => s + (c.count ?? 0), 0)

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>近 91 天 · {total} 条</Text>
      <View style={styles.heatWrap}>
        {Array.from({ length: 13 }, (_, w) => (
          <View key={w} style={{ gap: 2 }}>
            {grid.slice(w * 7, w * 7 + 7).map((cell) => (
              <View
                key={cell.key}
                style={{
                  width: size,
                  height: size,
                  borderRadius: 2,
                  backgroundColor: cell.count === null ? 'transparent' : heatColor(cell.count),
                }}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  )
}

function heatColor(count: number): string {
  if (count <= 0) return '#e9ebf0'
  if (count === 1) return '#c9dbfb'
  if (count <= 3) return '#8db1f6'
  return '#2f6fed'
}

function GoalBar({ gp, now }: { gp: GoalProgress; now: number }) {
  const g = gp.goal.event
  const meta = DIMENSION_META[g.dimension]
  const unit = g.aggregate === 'amount' ? '元' : g.aggregate === 'minutes' ? '分钟' : '次'
  const cmp = g.aggregate === 'amount' ? '≤' : '≥'
  const over = g.aggregate === 'amount' && gp.current > g.target
  const pct = Math.min(gp.current / g.target, 1)
  const left = `${g.category ? `${meta.label}/${g.category}` : meta.label} ${PERIOD_LABEL[g.period]}${cmp}${g.target}${unit}`
  const sub: string[] = []
  if (g.anchorDays?.length) sub.push(`偏好 ${g.anchorDays.map((d) => WEEKDAY_LABEL[d]).join('、')}`)
  if (g.repeat === 'once') sub.push(`单次 · ${fmtDay(gp.goal.windowEnd - DAY_MS)} 截止`)
  if (over) sub.push(`已超 ¥${Math.round(gp.current - g.target)}`)
  return (
    <View style={styles.goalRow}>
      <View style={styles.barHead}>
        <Text style={styles.goalName} numberOfLines={1}>
          {gp.met ? '✅' : '⬜'} {left}
        </Text>
        <Text style={styles.barValue}>
          {Math.round(gp.current * 10) / 10}/{g.target}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct * 100}%` }, over && styles.barOver]} />
      </View>
      {sub.length ? <Text style={styles.goalSub}>{sub.join(' · ')}</Text> : null}
    </View>
  )
}

// ─── 速记表单 ───

type QuickKind = 'expense' | 'mood' | 'activity'

function QuickRecordModal({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const [kind, setKind] = useState<QuickKind>('expense')
  const [amount, setAmount] = useState('')
  const [score, setScore] = useState<number | null>(null)
  const [dimension, setDimension] = useState<ActivityDimension>('life')
  const [category, setCategory] = useState('')
  const [minutes, setMinutes] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [cats, setCats] = useState<Record<CategoryDimension, string[]> | null>(null)

  useEffect(() => {
    if (!visible || cats) return
    void (async () => {
      const folded = foldEvents(await sharedEventStore.loadAll(), Date.now())
      setCats(folded.categories)
    })()
  }, [visible, cats])

  const activeCats: string[] = kind === 'expense' ? (cats?.finance ?? []) : (cats?.[dimension] ?? [])
  const pickCategory = (name: string): void => setCategory((prev) => (prev === name ? '' : name))

  const save = async (): Promise<void> => {
    if (saving) return
    const now = Date.now()
    const trimmedNote = note.trim() || undefined
    try {
      if (kind === 'expense') {
        const value = Number(amount)
        if (!Number.isFinite(value) || value <= 0) throw new Error('金额要是正数')
        const cat = category.trim() || '其他'
        await appendWithCategory('finance', cat, (name) => [
          makeExpense(uiInit(now), { category: name, amount: value, note: trimmedNote, occurredAt: now }),
        ])
        await onSaved(`已记支出 ¥${value} · ${cat}`)
      } else if (kind === 'mood') {
        if (score === null) throw new Error('选一个心情分')
        await sharedEventStore.append(makeMood(uiInit(now), { score, note: trimmedNote, occurredAt: now }))
        await onSaved(`已记心情 ${score} 分`)
      } else {
        const minutesValue = minutes.trim() ? Number(minutes) : undefined
        if (minutesValue !== undefined && (!Number.isFinite(minutesValue) || minutesValue <= 0)) {
          throw new Error('时长要是正数')
        }
        const cat = category.trim() || '其他'
        await appendWithCategory(dimension, cat, (name) => [
          makeActivity(uiInit(now), { dimension, category: name, minutes: minutesValue, note: trimmedNote, occurredAt: now }),
        ])
        await onSaved(`已记${DIMENSION_META[dimension].label} · ${cat}`)
      }
      setAmount('')
      setScore(null)
      setCategory('')
      setMinutes('')
      setNote('')
      setCats(null)
    } catch (e) {
      Alert.alert('没记上', e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>速记</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Text style={styles.modalClose}>收起</Text>
            </Pressable>
          </View>
          <View style={styles.chipRow}>
            {(['expense', 'mood', 'activity'] as QuickKind[]).map((k) => (
              <Pressable key={k} style={[styles.chip, kind === k && styles.chipOn]} onPress={() => setKind(k)}>
                <Text style={[styles.chipText, kind === k && styles.chipTextOn]}>
                  {k === 'expense' ? '支出' : k === 'mood' ? '心情' : '活动'}
                </Text>
              </Pressable>
            ))}
          </View>

          {kind === 'expense' ? (
            <>
              <Text style={styles.fieldLabel}>金额（元）</Text>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder="35"
                placeholderTextColor="#9aa0aa"
              />
            </>
          ) : null}

          {kind === 'mood' ? (
            <>
              <Text style={styles.fieldLabel}>心情分（1-10）</Text>
              <View style={styles.scoreRow}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((s) => (
                  <Pressable key={s} style={[styles.scoreChip, score === s && styles.scoreChipOn]} onPress={() => setScore(s)}>
                    <Text style={[styles.scoreChipText, score === s && styles.scoreChipTextOn]}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          {kind === 'activity' ? (
            <>
              <Text style={styles.fieldLabel}>维度</Text>
              <View style={styles.chipRow}>
                {ACTIVITY_DIMS.map((d) => (
                  <Pressable key={d} style={[styles.chip, dimension === d && styles.chipOn]} onPress={() => setDimension(d)}>
                    <Text style={[styles.chipText, dimension === d && styles.chipTextOn]}>
                      {DIMENSION_META[d].emoji} {DIMENSION_META[d].label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          {kind !== 'mood' ? (
            <>
              <Text style={styles.fieldLabel}>分类（点选或输入新词）</Text>
              <TextInput
                style={styles.input}
                value={category}
                onChangeText={setCategory}
                placeholder={kind === 'expense' ? '午饭' : '运动'}
                placeholderTextColor="#9aa0aa"
              />
              {activeCats.length ? (
                <View style={styles.catWrap}>
                  {activeCats.map((c) => (
                    <Pressable key={c} style={[styles.catChip, category === c && styles.catChipOn]} onPress={() => pickCategory(c)}>
                      <Text style={[styles.catChipText, category === c && styles.catChipTextOn]}>{c}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}

          {kind === 'activity' ? (
            <>
              <Text style={styles.fieldLabel}>时长（分钟，可选）</Text>
              <TextInput
                style={styles.input}
                value={minutes}
                onChangeText={setMinutes}
                keyboardType="decimal-pad"
                placeholder="40"
                placeholderTextColor="#9aa0aa"
              />
            </>
          ) : null}

          <Text style={styles.fieldLabel}>备注（可选）</Text>
          <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="随便写点" placeholderTextColor="#9aa0aa" />

          <Pressable style={[styles.saveButton, saving && styles.saveDisabled]} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>保存</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

function uiInit(now: number) {
  return { id: randomUUID(), recordedAt: now, source: 'ui' as const }
}

/** 记录前确保分类存在（不存在先落 internal 分类事件，与对话工具同语义）。 */
async function appendWithCategory(
  dim: CategoryDimension,
  name: string,
  make: (category: string) => OpenEvent[],
): Promise<void> {
  const folded = foldEvents(await sharedEventStore.loadAll(), Date.now())
  const events: OpenEvent[] = []
  if (!folded.categories[dim].includes(name)) {
    events.push(makeCategory({ id: randomUUID(), recordedAt: Date.now(), source: 'internal' }, { dimension: dim, op: 'add', name }))
  }
  events.push(...make(name))
  await sharedEventStore.append(...events)
}

// ─── 简报 ───

function BriefingModal({
  visible,
  onClose,
  reload,
}: {
  visible: boolean
  onClose: () => void
  reload: () => Promise<Folded>
}) {
  const [view, setView] = useState<'home' | 'preview'>('home')
  const [kind, setKind] = useState<BriefingKind>('daily')
  const [markdown, setMarkdown] = useState('')
  const [filename, setFilename] = useState('')
  const [busy, setBusy] = useState<'daily' | 'weekly' | 'ai' | null>(null)
  const [reports, setReports] = useState<File[]>([])

  const refresh = useCallback(() => setReports(listReportFiles()), [])
  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])

  const generate = async (which: BriefingKind): Promise<void> => {
    setBusy(which)
    try {
      const now = Date.now()
      const folded = await reload()
      const md = buildBriefing(which, folded, now)
      const file = saveReport(which, md, now)
      setKind(which)
      setMarkdown(md)
      setFilename(file.name)
      setView('preview')
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const openFile = (file: File): void => {
    setKind(file.name.startsWith('brief-daily-') ? 'daily' : 'weekly')
    setMarkdown(readReport(file))
    setFilename(file.name)
    setView('preview')
  }

  const interpret = async (): Promise<void> => {
    if (busy) return
    const provider = await resolveCurrentProvider()
    if (!provider) {
      Alert.alert('还没配置模型', 'AI 解读需要先在「设置」配好厂商与 API Key')
      return
    }
    setBusy('ai')
    try {
      const res = await chatCompletion(
        {
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
          model: provider.model,
          stream: false,
          temperature: 0.5,
          messages: [
            {
              role: 'system',
              content:
                '你是 OpenPrism 生活简报的解读助手。只依据给定的简报数据，用中文写 3-6 句：一段温和的整体观察（肯定做得好的地方），一条具体可执行的小建议。不得编造数据里没有的事实。',
            },
            { role: 'user', content: `以下是简报内容：\n\n${markdown}` },
          ],
        },
      )
      const text = res.message.content?.trim() || '（模型没有返回内容）'
      const next = `${markdown}\n\n## 🤖 AI 解读\n\n${text}`
      setMarkdown(next)
      saveReport(kind, next, Date.now(), filename || undefined) // 解读写回原文件；当日新生成则同名覆盖
    } catch (e) {
      Alert.alert('解读失败', e instanceof LlmError ? friendlyLlmMessage(e) : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>{view === 'home' ? '简报' : filename}</Text>
            <Pressable hitSlop={10} onPress={view === 'home' ? onClose : () => setView('home')}>
              <Text style={styles.modalClose}>{view === 'home' ? '收起' : '‹ 返回'}</Text>
            </Pressable>
          </View>

          {view === 'home' ? (
            <ScrollView contentContainerStyle={styles.briefHome}>
              <Text style={styles.briefHint}>数据章节从事件折叠直接生成（零 token）；AI 解读可选，逐字追加到简报并存档。</Text>
              <View style={styles.briefButtons}>
                <Pressable style={styles.briefButton} onPress={() => generate('daily')} disabled={busy !== null}>
                  {busy === 'daily' ? <ActivityIndicator color="#2f6fed" /> : <Text style={styles.briefButtonText}>生成今日日报</Text>}
                </Pressable>
                <Pressable style={styles.briefButton} onPress={() => generate('weekly')} disabled={busy !== null}>
                  {busy === 'weekly' ? <ActivityIndicator color="#2f6fed" /> : <Text style={styles.briefButtonText}>生成本周周报</Text>}
                </Pressable>
              </View>
              <Text style={styles.cardTitle}>已存档</Text>
              {reports.length === 0 ? (
                <Text style={styles.empty}>还没有简报</Text>
              ) : (
                reports.map((f) => (
                  <Pressable key={f.name} style={styles.reportRow} onPress={() => openFile(f)}>
                    <Text style={styles.reportName}>📄 {f.name}</Text>
                  </Pressable>
                ))
              )}
            </ScrollView>
          ) : (
            <>
              <ScrollView contentContainerStyle={styles.briefPreview}>
                <Text style={styles.briefText}>{markdown}</Text>
              </ScrollView>
              <Pressable style={[styles.saveButton, busy !== null && styles.saveDisabled]} onPress={interpret} disabled={busy !== null}>
                {busy === 'ai' ? <ActivityIndicator color="#fff" /> : (
                  <Text style={styles.saveText}>{markdown.includes('## 🤖 AI 解读') ? '重新 AI 解读' : 'AI 解读'}</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

// ─── 小工具 ───

function fmtDay(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Android 有等宽字体，iOS 用系统默认。 */
const PlatformFont = 'monospace'

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef0f4' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e4ea',
  },
  title: { fontSize: 17, fontWeight: '700', color: '#1c1f24' },
  headerActions: { flexDirection: 'row', gap: 18 },
  headerAction: { fontSize: 15, color: '#2f6fed', fontWeight: '600' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chipRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e4ea',
  },
  chipOn: { backgroundColor: '#2f6fed', borderColor: '#2f6fed' },
  chipText: { fontSize: 13, color: '#5b616c' },
  chipTextOn: { color: '#ffffff', fontWeight: '600' },
  pager: { flex: 1 },
  page: { flex: 1 },
  pageContent: { paddingHorizontal: 16, paddingVertical: 8, gap: 10 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 5, paddingVertical: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#c9ccd4' },
  dotOn: { backgroundColor: '#2f6fed', width: 16 },
  heroCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    gap: 4,
  },
  heroEmoji: { fontSize: 26 },
  heroLabel: { fontSize: 12, color: '#7c828d' },
  heroValue: { fontSize: 24, fontWeight: '700', color: '#1c1f24' },
  card: { backgroundColor: '#ffffff', borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#3c414b' },
  empty: { fontSize: 13, color: '#9aa0aa' },
  barRow: { gap: 4 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barName: { fontSize: 13, color: '#3c414b', flexShrink: 1 },
  barValue: { fontSize: 13, color: '#1c1f24', fontWeight: '600' },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: '#f0f1f5', overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: '#2f6fed' },
  barOver: { backgroundColor: '#e5484d' },
  dailyRow: { flexDirection: 'row', gap: 4, alignItems: 'flex-end' },
  dailyCol: { flex: 1 },
  dailyTrack: { height: 56, justifyContent: 'flex-end', alignItems: 'center' },
  dailyBar: { width: '70%', maxWidth: 14, borderRadius: 3, backgroundColor: '#2f6fed' },
  dailyCaption: { flexDirection: 'row', justifyContent: 'space-between' },
  dailyCaptionText: { fontSize: 10, color: '#9aa0aa' },
  moodChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  moodChip: {
    alignItems: 'center',
    backgroundColor: '#f2f6ff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  moodScore: { fontSize: 15, fontWeight: '700', color: '#2f6fed' },
  moodDate: { fontSize: 10, color: '#9aa0aa' },
  activityRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heatWrap: { flexDirection: 'row', gap: 2 },
  goalRow: { gap: 4 },
  goalName: { fontSize: 13, color: '#1c1f24', flexShrink: 1 },
  goalSub: { fontSize: 11, color: '#9aa0aa' },
  recentCard: {
    height: 170,
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 12,
  },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  recentEmoji: { fontSize: 14 },
  recentTitle: { flex: 1, fontSize: 13, color: '#3c414b' },
  recentDate: { fontSize: 11, color: '#9aa0aa' },
  toast: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: '#1c1f24',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  toastText: { color: '#ffffff', fontSize: 13 },
  modalRoot: { flex: 1, backgroundColor: 'rgba(28,31,36,0.35)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    maxHeight: '88%',
    gap: 8,
  },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#1c1f24' },
  modalClose: { fontSize: 14, color: '#2f6fed', fontWeight: '600' },
  fieldLabel: { fontSize: 12, color: '#7c828d', marginTop: 4 },
  input: {
    backgroundColor: '#f2f3f6',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1c1f24',
  },
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  scoreChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f3f6',
  },
  scoreChipOn: { backgroundColor: '#2f6fed' },
  scoreChipText: { fontSize: 14, color: '#3c414b', fontWeight: '600' },
  scoreChipTextOn: { color: '#ffffff' },
  catWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  catChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: '#f2f3f6',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  catChipOn: { backgroundColor: '#eaf1ff', borderColor: '#2f6fed' },
  catChipText: { fontSize: 12, color: '#3c414b' },
  catChipTextOn: { color: '#2f6fed', fontWeight: '600' },
  saveButton: {
    backgroundColor: '#2f6fed',
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 6,
  },
  saveDisabled: { backgroundColor: '#b9c6e4' },
  saveText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  briefHome: { gap: 10, paddingBottom: 12 },
  briefHint: { fontSize: 12, color: '#9aa0aa', lineHeight: 17 },
  briefButtons: { flexDirection: 'row', gap: 10 },
  briefButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2f6fed',
    alignItems: 'center',
    paddingVertical: 14,
  },
  briefButtonText: { color: '#2f6fed', fontSize: 15, fontWeight: '600' },
  reportRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eef0f4' },
  reportName: { fontSize: 13, color: '#3c414b' },
  briefPreview: { gap: 6, paddingBottom: 16 },
  briefText: { fontSize: 13, color: '#3c414b', lineHeight: 21, fontFamily: PlatformFont },
})
