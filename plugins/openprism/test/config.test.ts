import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginConfig, describeSchedule, serializeSchedule, ScheduleStore } from '../src/config.js'

describe('插件配置：定时任务用户自定义（D7 2026-08-31）', () => {
  it('空对象 / undefined：全部内置默认', () => {
    for (const raw of [undefined, {}, null]) {
      const { config, warnings } = parsePluginConfig(raw)
      expect(warnings).toEqual([])
      expect(config.distill).toEqual({ time: { hour: 3, minute: 0 } })
      expect(config.dailyBriefing).toEqual({ time: { hour: 7, minute: 0 } })
      expect(config.weeklyBriefing).toEqual({ time: { hour: 21, minute: 0 }, day: 0 })
    }
  })

  it('自定义时刻与周报星期', () => {
    const { config, warnings } = parsePluginConfig({
      dailyBriefingTime: '08:30',
      weeklyBriefingTime: '21:45',
      weeklyBriefingDay: 5,
    })
    expect(warnings).toEqual([])
    expect(config.dailyBriefing).toEqual({ time: { hour: 8, minute: 30 } })
    expect(config.weeklyBriefing).toEqual({ time: { hour: 21, minute: 45 }, day: 5 })
    expect(config.distill).toEqual({ time: { hour: 3, minute: 0 } }) // 未提及的字段走默认
  })

  it('null / 空串 / off 关闭对应任务', () => {
    const { config } = parsePluginConfig({ distillTime: null, dailyBriefingTime: '', weeklyBriefingTime: 'off' })
    expect(config.distill).toBeNull()
    expect(config.dailyBriefing).toBeNull()
    expect(config.weeklyBriefing).toBeNull()
  })

  it('非法时刻回退默认并出警告；未知配置项忽略并出警告', () => {
    const { config, warnings } = parsePluginConfig({ dailyBriefingTime: '25:00', distillTime: 3, distilltime: '09:00' })
    expect(config.dailyBriefing).toEqual({ time: { hour: 7, minute: 0 } })
    expect(config.distill).toEqual({ time: { hour: 3, minute: 0 } })
    expect(warnings.some((w) => w.includes('dailyBriefingTime'))).toBe(true)
    expect(warnings.some((w) => w.includes('distillTime'))).toBe(true)
    expect(warnings.some((w) => w.includes('未知配置项'))).toBe(true)
  })

  it('describeSchedule：默认文本与关闭文本', () => {
    const text = describeSchedule(parsePluginConfig({}).config)
    expect(text).toContain('每天 03:00')
    expect(text).toContain('每天 07:00')
    expect(text).toContain('周日 21:00')
    const offText = describeSchedule(parsePluginConfig({ dailyBriefingTime: null }).config)
    expect(offText).toContain('关闭')
  })

  it('serialize：解析-序列化-再解析往返一致（schedule.json 形态）', () => {
    const { config } = parsePluginConfig({ distillTime: '02:30', dailyBriefingTime: null, weeklyBriefingTime: '20:15', weeklyBriefingDay: 6 })
    expect(serializeSchedule(config)).toEqual({
      distillTime: '02:30',
      dailyBriefingTime: null,
      weeklyBriefingTime: '20:15',
      weeklyBriefingDay: 6,
    })
    expect(parsePluginConfig(serializeSchedule(config)).config).toEqual(config)
  })

  it('ScheduleStore：save 后 load 读回一致；文件缺失返回 null 且不标记 loaded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-sched-'))
    const store = new ScheduleStore(join(dir, 'schedule.json'))
    expect(await store.load()).toBeNull()
    expect(store.loaded).toBe(false)

    const { config } = parsePluginConfig({ dailyBriefingTime: '08:30' })
    await store.save(config)
    expect(store.loaded).toBe(true)
    expect(await store.load()).toEqual(config)
    const text = JSON.parse(await readFile(join(dir, 'schedule.json'), 'utf8')) as { dailyBriefingTime: string }
    expect(text.dailyBriefingTime).toBe('08:30')
  })
})
