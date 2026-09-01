/**
 * App 数据目录布局（M3）：documents/openprism/ 下——
 * events.jsonl（唯一持久层）、sessions/（会话日志）、providers.json + settings.json（厂商与界面设置）、reports/（简报，批次 2+）。
 */

import { Directory, File, Paths } from 'expo-file-system'

function ensureDir(dir: Directory): Directory {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  return dir
}

export function dataDir(): Directory {
  return ensureDir(new Directory(Paths.document, 'openprism'))
}

export function eventsFile(): File {
  return new File(dataDir(), 'events.jsonl')
}

export function sessionsDir(): Directory {
  return ensureDir(new Directory(dataDir(), 'sessions'))
}

export function sessionFile(sessionId: string): File {
  return new File(sessionsDir(), `${sessionId}.jsonl`)
}

export function reportsDir(): Directory {
  return ensureDir(new Directory(dataDir(), 'reports'))
}

export function readJsonFile<T>(file: File, fallback: T): T {
  if (!file.exists) return fallback
  try {
    return JSON.parse(file.textSync()) as T
  } catch {
    return fallback
  }
}

export function writeJsonFile(file: File, value: unknown): void {
  file.write(JSON.stringify(value, null, 2))
}
