/**
 * 全 App 共享的事件日志实例：串行队列与内存缓存必须只有一份，
 * 否则速记表单（ui 来源）与对话工具（conversation 来源）各持缓存会互相看不到对方的追加。
 */

import { createEventStore } from './eventStore'
import { eventsFile } from './paths'

export const sharedEventStore = createEventStore(eventsFile)
