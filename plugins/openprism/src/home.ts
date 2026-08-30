/**
 * OpenPrism 数据目录解析：`$DSH_HOME/openprism`（缺省 `~/.dsh/openprism`）。
 *
 * - `events.jsonl` —— 全局事件日志（唯一持久层，ADR 0002）；
 * - `captures/YYYY-MM.jsonl` —— 采集日志（按月分片，ADR 0003，批次 3）；
 * - `reports/YYYY-MM/` —— 简报产物（可重算派生物，批次 5）。
 *
 * @module openprism/home
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function resolveOpenPrismHome(): string {
  return join(resolveDshHome(), 'openprism')
}

export function resolveEventsFile(): string {
  return join(resolveOpenPrismHome(), 'events.jsonl')
}

export function resolveSessionsDir(): string {
  return join(resolveDshHome(), 'sessions')
}
