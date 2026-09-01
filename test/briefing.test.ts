import { describe, expect, it } from 'vitest'
import { makeActivity, makeExpense, makeGoal, makeMood } from '../src/domain/events'
import { foldEvents } from '../src/domain/fold'
import { buildBriefing, briefingFilename, isoWeek } from '../src/domain/briefing'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

let seq = 0
function nid(): { id: string; recordedAt: number; source: 'conversation' } {
  seq += 1
  return { id: `b${seq}`, recordedAt: at(2026, 1, 1), source: 'conversation' }
}

const NOW = at(2026, 9, 1, 21) // 周二

function fixture() {
  const events = [
    // 今天：两笔支出、一条心情、一条活动
    makeExpense(nid(), { category: '猫粮', amount: 200, occurredAt: at(2026, 9, 1, 9) }),
    makeExpense(nid(), { category: '买书', amount: 80, occurredAt: at(2026, 9, 1, 15) }),
    makeMood(nid(), { score: 7, occurredAt: at(2026, 9, 1, 20) }),
    makeActivity(nid(), { dimension: 'life', category: '撸猫', minutes: 30, occurredAt: at(2026, 9, 1, 20) }),
    // 昨天（同周）：供周报与环比
    makeExpense(nid(), { category: '猫粮', amount: 50, occurredAt: at(2026, 8, 31, 10) }),
    makeMood(nid(), { score: 8, occurredAt: at(2026, 8, 31, 21) }),
    // 目标：每周撸猫 1 次（本周已 1 次 → 达标）
    makeGoal(nid(), { dimension: 'life', category: '撸猫', aggregate: 'count', target: 1, period: 'week', repeat: 'rolling' }),
  ]
  return foldEvents(events, NOW)
}

describe('briefingFilename / isoWeek', () => {
  it('2026-09-01 是 ISO 第 36 周', () => {
    expect(isoWeek(new Date(2026, 8, 1))).toBe(36)
    expect(isoWeek(new Date(2026, 8, 7))).toBe(37) // 周一 9-07 开新周
  })

  it('文件名带日期与年-周', () => {
    expect(briefingFilename('daily', NOW)).toBe('brief-daily-2026-09-01.md')
    expect(briefingFilename('weekly', NOW)).toBe('brief-weekly-2026-W36.md')
  })
})

describe('buildBriefing 日报', () => {
  const md = buildBriefing('daily', fixture(), NOW)

  it('标题含日期与星期', () => {
    expect(md).toContain('# OpenPrism 日报 · 2026-09-01 周二')
  })

  it('录入概览按维度计数', () => {
    expect(md).toContain('今日共录入 4 条')
    expect(md).toContain('💰理财 2')
    expect(md).toContain('🌱生活 1')
  })

  it('理财含今日分类明细与本月累计、昨日环比', () => {
    expect(md).toContain('今日支出 ¥280（2 笔）：猫粮 ¥200 · 买书 ¥80')
    expect(md).toContain('较昨日 +460%')
    expect(md).toContain('本月累计 ¥280（2 笔）')
  })

  it('心情均值与分数序列', () => {
    expect(md).toContain('今日 1 条 · 均值 7.0 · 7分')
  })

  it('活动章节只在有记录的维度出现', () => {
    expect(md).toContain('## 🌱 生活')
    expect(md).toContain('今日 1 条 / 30 分钟：撸猫 1次')
    expect(md).not.toContain('## 💼 工作')
  })

  it('目标对照零 token 出达标状态', () => {
    expect(md).toContain('- ✅ 生活/撸猫 每周≥1次：当前 1/1次 达标')
  })

  it('明细按时间排序且带时分', () => {
    expect(md).toContain('- 09:00 支出 ¥200 猫粮')
    expect(md).toContain('- 20:00 撸猫 30 分钟')
  })

  it('纯函数确定性：两次生成逐字节一致', () => {
    expect(buildBriefing('daily', fixture(), NOW)).toBe(md)
  })
})

describe('buildBriefing 周报', () => {
  const md = buildBriefing('weekly', fixture(), NOW)

  it('标题是周一到周日区间与周序', () => {
    expect(md).toContain('# OpenPrism 周报 · 2026-08-31 – 2026-09-06（第 36 周）')
  })

  it('本周口径含昨天数据、环比上周为空则不出环比行', () => {
    expect(md).toContain('本周共录入 6 条')
    expect(md).toContain('本周支出 ¥330（3 笔）')
    expect(md).not.toContain('较上周')
  })

  it('周报不出现「本月累计」（那是日报章节）', () => {
    expect(md).not.toContain('本月累计')
  })
})

describe('buildBriefing 空数据', () => {
  it('无记录不炸、占位文案齐全', () => {
    const md = buildBriefing('daily', foldEvents([], NOW), NOW)
    expect(md).toContain('今日暂无记录。')
    expect(md).toContain('今日无支出记录。')
    expect(md).toContain('今日无心情记录。')
    expect(md).toContain('（暂无进行中的目标）')
    expect(md).toContain('## 🕘 今日记录\n（无）')
  })
})
