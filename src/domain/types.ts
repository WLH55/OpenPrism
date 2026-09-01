/**
 * 领域类型：六维度、事件种类、组合式目标的聚合轴与周期。
 * 纯类型与常量，不依赖任何平台模块（可在 node 下单测）。
 */

export type ActivityDimension = 'life' | 'work' | 'family' | 'study'
export type Dimension = 'finance' | 'mood' | ActivityDimension
/** 拥有分类的维度（情感维度无分类）。 */
export type CategoryDimension = 'finance' | ActivityDimension

/** 目标聚合轴（M8 组合式指标，封闭谓词）。 */
export type Aggregate = 'count' | 'amount' | 'minutes'
export type GoalPeriod = 'day' | 'week' | 'month' | 'year'
export type GoalRepeat = 'rolling' | 'once'

/** 事件来源：conversation=对话工具调用 / ui=界面操作 / internal=工具内部副作用（如自动建类）。 */
export type EventSource = 'conversation' | 'ui' | 'internal'

export const ACTIVITY_DIMENSIONS: readonly ActivityDimension[] = ['life', 'work', 'family', 'study']
export const CATEGORY_DIMENSIONS: readonly CategoryDimension[] = ['finance', 'life', 'work', 'family', 'study']

export const DIMENSION_META: Record<Dimension, { emoji: string; label: string }> = {
  finance: { emoji: '💰', label: '理财' },
  mood: { emoji: '❤️', label: '情感' },
  life: { emoji: '🌱', label: '生活' },
  work: { emoji: '💼', label: '工作' },
  family: { emoji: '🏠', label: '家庭' },
  study: { emoji: '📚', label: '学习' },
}

export const AGGREGATE_LABEL: Record<Aggregate, string> = {
  count: '次数',
  amount: '金额',
  minutes: '时长',
}

export const PERIOD_LABEL: Record<GoalPeriod, string> = { day: '每天', week: '每周', month: '每月', year: '每年' }

export const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
