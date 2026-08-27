/**
 * OpenPrism 面板域声明：六维度记录形状（v0.3）。
 * 面板数据存放在 dsh 的 storage-domain（`$DSH_HOME/storages`），跨会话持久；
 * 会话日志只携带标准 `tool/call` / `tool/result` 事件，任何 dsh 都能加载。
 *
 * @module openprism/types
 */

/** 六个面板维度的键。 */
export type DimensionKey = 'finance' | 'mood' | 'life' | 'work' | 'family' | 'study'

/** 拥有可自定义分类的维度（情感是 1-5 分值，无分类）。 */
export type CategoryDimension = 'finance' | 'life' | 'work' | 'family' | 'study'

/** 活动类维度：生活/工作/家庭/学习共用一条记录形状。 */
export type ActivityDimension = 'life' | 'work' | 'family' | 'study'

/** 一笔支出记录。 */
export interface ExpenseRecord {
  /** 记录时间（Unix 毫秒）。 */
  time: number
  /** 金额（元）。 */
  amount: number
  /** 类别（用户可自定义，见 categories 表）。 */
  category: string
  /** 简短备注。 */
  note?: string
}

/** 一条心情记录。 */
export interface MoodRecord {
  /** 记录时间（Unix 毫秒）。 */
  time: number
  /** 心情分值，1（最差）到 5（最好）。 */
  score: number
  /** 简短备注。 */
  note?: string
}

/** 一条活动记录（生活/工作/家庭/学习共用）。 */
export interface ActivityRecord {
  /** 记录时间（Unix 毫秒）。 */
  time: number
  /** 所属活动维度。 */
  dimension: ActivityDimension
  /** 类别（用户可自定义）。 */
  category: string
  /** 时长（分钟），用户提到时才有。 */
  durationMinutes?: number
  /** 简短备注。 */
  note?: string
}

/** 一条分类记录；key 约定为 `<dimension>/<name>`，name 不允许含 `/`。 */
export interface CategoryRecord {
  dimension: CategoryDimension
  name: string
  createdAt: number
}

/** 面板数据：storage-domain 四张表的读取快照。 */
export interface PanelData {
  expenses: ExpenseRecord[]
  moods: MoodRecord[]
  activities: ActivityRecord[]
  categories: Array<{ dimension: CategoryDimension; name: string; createdAt: number }>
}
