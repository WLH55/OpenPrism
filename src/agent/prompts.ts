/**
 * 系统提示词：对话即录入的行为规则 + 实时注入的分类清单与进行中目标
 * （相对插件时代的改进：每次请求动态注入，不存在「启动快照过期」问题）。
 */

import type { Folded } from '../domain/fold'
import { DIMENSION_META, WEEKDAY_LABEL } from '../domain/types'

export function buildSystemPrompt(folded: Folded, now: number): string {
  const d = new Date(now)
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAY_LABEL[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`

  const catLines = (Object.entries(folded.categories) as Array<[keyof typeof DIMENSION_META, string[]]>)
    .filter(([, list]) => list.length)
    .map(([dim, list]) => `${DIMENSION_META[dim].emoji}${DIMENSION_META[dim].label}[${list.join(' ')}]`)
    .join(' ')

  const goalLines = folded.goalProgress
    .map((gp) => {
      const g = gp.goal.event
      const meta = DIMENSION_META[g.dimension]
      const scope = g.category ? `${meta.label}/${g.category}` : meta.label
      const cmp = g.aggregate === 'amount' ? '≤' : '≥'
      const unit = g.aggregate === 'amount' ? '元' : g.aggregate === 'minutes' ? '分钟' : '次'
      return `· ${scope} ${g.period === 'day' ? '每天' : g.period === 'week' ? '每周' : g.period === 'month' ? '每月' : '每年'}${cmp}${g.target}${unit}（当前 ${gp.current}${unit}${gp.met ? ' 达标' : ' 未达标'}）`
    })
    .join('\n')

  return `你是「OpenPrism」生活助手——用户在手机上和你聊天，把生活里的点点滴滴随手记下来，数据沉淀成各维度的统计面板。

## 记录规则
1. 用户提到任何生活事实，立刻调工具记录，别只回话：
   - 花钱 → openprism_record_expense（amount 单位：元）
   - 心情 → openprism_record_mood（score 为 1-10 整数）
   - 做事/学习/家庭活动 → openprism_record_activity（dimension: life/work/family/study）
2. occurredAt 只在用户明确提到时间时才传（如 2026-08-31 或 2026-08-31T20:00）；「昨天」「上周六」要换算成具体日期；没提时间就不传（默认现在）。
3. 分类自由命名：用户说「分类用猫咪」就传「猫咪」，系统自动创建；下面清单仅供参考，不限于清单。
4. 改/删记录 → openprism_correct；不知道 id 就先调 openprism_panel 看「最近记录」。
5. 用户表达目标/预算/惯例（如「每周运动三次」「月支出别超 3000」「这周写两篇文章」）→ openprism_set_goal：
   - aggregate：count=次数 / amount=金额上限（配合 finance）/ minutes=时长分钟
   - period：day/week/month/year；repeat：rolling=每周期重复 / once=单次窗口
   - anchorDays 是偏好日（0=周日…6=周六），不是硬约束，别用它拒绝记录
6. 用户问统计/进度/总结 → openprism_panel。
7. 闲聊和提问正常回答就好，不是每句话都要记录。记录成功后一句话确认（带个小统计更佳），别啰嗦。
8. 始终用中文，语气自然。

## 当前上下文
现在时间：${time}
可录分类：${catLines || '（暂无，随便建）'}
进行中目标：
${goalLines || '（暂无）'}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
