/**
 * dsh 会话日志文件扫描：`$DSH_HOME/sessions/**\/session-<uuid>/session.jsonl(.zstd)`。
 * - zstd 用 node:zlib 内置解压（本机 node ≥22.15 验证可用）；无 .zstd 后缀按明文读；
 * - 目录名即 sessionId（`session-` 前缀去掉）；
 * - 单行解析失败跳过（容忍），整体读取失败跳过该会话。
 * 本模块只做「文件 → SessionLogEntry 流」，供 rebuild 使用。
 *
 * @module openprism/session-files
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { resolveSessionsDir } from './home.js'
import type { SessionEventLike } from './mirror.js'
import type { SessionLogEntry, SessionLogSource } from './rebuild.js'

export class DshSessionFileSource implements SessionLogSource {
  constructor(private readonly sessionsDir: string = resolveSessionsDir()) {}

  async *entries(): AsyncIterable<SessionLogEntry> {
    let groupDirs: string[]
    try {
      groupDirs = await readdir(this.sessionsDir)
    } catch {
      return
    }
    for (const group of groupDirs) {
      const groupDir = join(this.sessionsDir, group)
      let sessionDirs: string[]
      try {
        sessionDirs = (await readdir(groupDir, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && d.name.startsWith('session-'))
          .map((d) => d.name)
      } catch {
        continue
      }
      for (const sessionDir of sessionDirs) {
        const sessionId = sessionDir.slice('session-'.length)
        const events = await readSessionLog(join(groupDir, sessionDir))
        if (events) yield { sessionId, events }
      }
    }
  }
}

async function readSessionLog(dir: string): Promise<SessionEventLike[] | null> {
  const plain = join(dir, 'session.jsonl')
  const compressed = join(dir, 'session.jsonl.zstd')
  let text: string | null = null
  try {
    text = await readFile(plain, 'utf8')
  } catch {
    try {
      const buf = await readFile(compressed)
      text = zstdDecompressSync(buf).toString('utf8')
    } catch {
      return null
    }
  }
  const events: SessionEventLike[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as SessionEventLike)
    } catch {
      // 跳过坏行
    }
  }
  return events
}
