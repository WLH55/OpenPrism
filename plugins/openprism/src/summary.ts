/**
 * 折叠状态 → 旧版 PanelData 形状的适配层：批次 4 之前保持 panel.ts 聚合与
 * 浏览器 UI 的输入形状不变（平滑迁移）。记录时间取 occurredAt（4.2），分类
 * 经折叠解析（改名链/兜底「其他」）。
 *
 * @module openprism/summary
 */

import type { FoldedState } from './fold.js'
import type { ActivityPayload, ExpensePayload, MoodPayload } from './events.js'
import type { ActivityRecord, CategoryDimension, ExpenseRecord, MoodRecord, PanelData } from './types.js'

export function panelDataFromFold(state: FoldedState): PanelData {
  const expenses: ExpenseRecord[] = []
  const moods: MoodRecord[] = []
  const activities: ActivityRecord[] = []
  for (const record of state.records) {
    if (record.deleted) continue
    switch (record.kind) {
      case 'expense': {
        const payload = record.payload as ExpensePayload
        expenses.push({
          time: record.occurredAt,
          amount: payload.amount,
          category: state.resolveCategory('finance', payload.category),
          ...(payload.note !== undefined ? { note: payload.note } : {}),
        })
        break
      }
      case 'mood': {
        const payload = record.payload as MoodPayload
        moods.push({
          time: record.occurredAt,
          score: payload.score,
          ...(payload.note !== undefined ? { note: payload.note } : {}),
        })
        break
      }
      case 'activity': {
        const payload = record.payload as ActivityPayload
        activities.push({
          time: record.occurredAt,
          dimension: payload.dimension,
          category: state.resolveCategory(payload.dimension, payload.category),
          ...(payload.durationMinutes !== undefined ? { durationMinutes: payload.durationMinutes } : {}),
          ...(payload.note !== undefined ? { note: payload.note } : {}),
        })
        break
      }
      case 'goal':
        break // 目标进度由批次 4 的聚合 v2 消费
    }
  }
  const categories: PanelData['categories'] = []
  for (const [dim, names] of Object.entries(state.categories)) {
    names.forEach((name, index) => {
      categories.push({ dimension: dim as CategoryDimension, name, createdAt: index })
    })
  }
  return { expenses, moods, activities, categories }
}
