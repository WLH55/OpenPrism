/**
 * 插件运行配置：定时任务的用户自定义面（D7，2026-08-31 确认「放定时任务、由用户
 * 自定义，不默认固定」）。
 *
 * 配置来自宿主 profile 的 cordis.patch.yml 里 openprism 行的 `config` 块（改完重启
 * dsh 生效--patch 在启动时读取）：
 *
 * ```yaml
 * - id: openprism
 *   name: openprism
 *   config:
 *     distillTime: '03:00'        # 夜间提炼时刻（HH:mm）；null / '' / 'off' 关闭
 *     dailyBriefingTime: '07:00'  # 每日简报时刻；关闭则连启动补跑一并停
 *     weeklyBriefingTime: '21:00' # 周报时刻；null 关闭
 *     weeklyBriefingDay: 0        # 周报星期：0=周日 .. 6=周六（默认 0）
 * ```
 *
 * 全部可省略：缺省即内置默认（提炼 03:00、每日简报 07:00、周报 周日 21:00）；
 * 非法值回退默认并记 warning，未知配置项忽略并记 warning（防拼写错误静默失效）。
 *
 * @module openprism/config
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 一天内的时刻（宿主本地时区）。 */
export interface TimeOfDay {
  hour: number
  minute: number
}

/** 一个定时任务的触发描述。 */
export interface ScheduledJob {
  time: TimeOfDay
  /** 0=周日..6=周六；undefined = 每天。 */
  day?: number
}

export interface PluginConfig {
  /** 夜间提炼（5.3）；null 关闭。 */
  distill: ScheduledJob | null
  /** 每日简报 + 启动补跑（D7）；null 关闭。 */
  dailyBriefing: ScheduledJob | null
  /** 每周周报（D7）；null 关闭。 */
  weeklyBriefing: ScheduledJob | null
}

export interface ParsedConfig {
  config: PluginConfig
  warnings: string[]
}

const DEFAULTS = {
  distillTime: '03:00',
  dailyBriefingTime: '07:00',
  weeklyBriefingTime: '21:00',
  weeklyBriefingDay: 0,
} as const

const KNOWN_KEYS = ['distillTime', 'dailyBriefingTime', 'weeklyBriefingTime', 'weeklyBriefingDay'] as const

/** 'HH:mm'（或 'H:mm'）-> TimeOfDay；越界或格式不符返回 undefined。 */
function parseTimeString(text: string): TimeOfDay | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

/**
 * 解析一个时刻字段：undefined 用默认；null / '' / 'off' / false 关闭；其余类型或
 * 非法字符串回退默认并追加 warning。逐字段容错--一个字段写错不影响其他字段。
 */
function parseTimeField(field: string, value: unknown, fallback: string, warnings: string[]): TimeOfDay | null {
  if (value === null || value === false || value === 'off' || value === '') return null
  const text = value === undefined ? fallback : typeof value === 'string' ? value : undefined
  if (text === undefined) {
    warnings.push(`配置 ${field} 非法（${JSON.stringify(value) ?? 'undefined'}），使用默认 ${fallback}`)
    return parseTimeString(fallback)!
  }
  const parsed = parseTimeString(text)
  if (parsed === undefined) {
    warnings.push(`配置 ${field}：「${text}」不是合法的 HH:mm，使用默认 ${fallback}`)
    return parseTimeString(fallback)!
  }
  return parsed
}

/** 周报星期：undefined 用默认 0（周日）；非 0-6 整数回退默认并出警告。 */
function parseDayField(value: unknown, warnings: string[]): number {
  if (value === undefined) return DEFAULTS.weeklyBriefingDay
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) return value
  warnings.push(`配置 weeklyBriefingDay 非法（${JSON.stringify(value) ?? 'undefined'}），使用默认 ${DEFAULTS.weeklyBriefingDay}`)
  return DEFAULTS.weeklyBriefingDay
}

/** 解析插件 config（apply 的第二参）；raw 为空对象 / undefined 时全走默认。 */
export function parsePluginConfig(raw: unknown): ParsedConfig {
  const warnings: string[] = []
  const obj: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push(`config 结构非法（应为对象，收到 ${Array.isArray(raw) ? '数组' : typeof raw}），定时任务全部使用默认值`)
  }
  for (const key of Object.keys(obj)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) warnings.push(`未知配置项「${key}」已忽略`)
  }
  const distill = parseTimeField('distillTime', obj.distillTime, DEFAULTS.distillTime, warnings)
  const daily = parseTimeField('dailyBriefingTime', obj.dailyBriefingTime, DEFAULTS.dailyBriefingTime, warnings)
  const weekly = parseTimeField('weeklyBriefingTime', obj.weeklyBriefingTime, DEFAULTS.weeklyBriefingTime, warnings)
  const weeklyDay = parseDayField(obj.weeklyBriefingDay, warnings)
  return {
    config: {
      distill: distill === null ? null : { time: distill },
      dailyBriefing: daily === null ? null : { time: daily },
      weeklyBriefing: weekly === null ? null : { time: weekly, day: weeklyDay },
    },
    warnings,
  }
}

/** 启动日志用的定时任务一览文本。 */
export function describeSchedule(config: PluginConfig): string {
  const dayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
  const fmt = (job: ScheduledJob | null): string => {
    if (job === null) return '关闭'
    const time = `${String(job.time.hour).padStart(2, '0')}:${String(job.time.minute).padStart(2, '0')}`
    return job.day === undefined ? `每天 ${time}` : `${dayLabels[job.day]} ${time}`
  }
  return `夜间提炼 ${fmt(config.distill)}；每日简报 ${fmt(config.dailyBriefing)}；周报 ${fmt(config.weeklyBriefing)}`
}

/** TimeOfDay -> 'HH:mm'（补零）。 */
export function formatTime(time: TimeOfDay): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
}

/**
 * 定时任务的 JSON 持久化形态（schedule.json / 面板端点共用）：时刻为 'HH:mm'
 * 字符串、关闭为 null，周报星期为 0-6 数字。
 */
export function serializeSchedule(config: PluginConfig): {
  distillTime: string | null
  dailyBriefingTime: string | null
  weeklyBriefingTime: string | null
  weeklyBriefingDay: number
} {
  return {
    distillTime: config.distill === null ? null : formatTime(config.distill.time),
    dailyBriefingTime: config.dailyBriefing === null ? null : formatTime(config.dailyBriefing.time),
    weeklyBriefingTime: config.weeklyBriefing === null ? null : formatTime(config.weeklyBriefing.time),
    weeklyBriefingDay: config.weeklyBriefing?.day ?? DEFAULTS.weeklyBriefingDay,
  }
}

/**
 * 定时任务存储：`$DSH_HOME/openprism/schedule.json`（面板 ⚙ 设置的持久化面，
 * D7 2026-08-31：放定时任务、面板里由用户设置，不写死在代码里）。
 *
 * 优先级：schedule.json（面板保存过）> 插件 config（patch 行引导值）> 内置默认。
 * load() 返回 null 表示文件不存在或不可解析（调用方回退引导值）。
 */
export class ScheduleStore {
  /** 成功从文件载入过配置（面板设置过且文件可读）。 */
  loaded = false

  constructor(private readonly filePath: string) {}

  async load(): Promise<PluginConfig | null> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch {
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      return null
    }
    const parsed = parsePluginConfig(raw)
    this.loaded = true
    return parsed.config
  }

  async save(config: PluginConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(serializeSchedule(config), null, 2)}\n`, 'utf8')
    this.loaded = true
  }
}
