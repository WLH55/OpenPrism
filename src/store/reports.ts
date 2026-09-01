/**
 * 简报存档（批次 2）：markdown 落 reports/，按文件名倒序列出（同前缀的日期/年-周字典序即时间序）。
 */

import { Directory, File } from 'expo-file-system'
import type { BriefingKind } from '../domain/briefing'
import { briefingFilename } from '../domain/briefing'
import { reportsDir } from './paths'

export function saveReport(kind: BriefingKind, markdown: string, now: number, filenameOverride?: string): File {
  const file = new File(reportsDir(), filenameOverride ?? briefingFilename(kind, now))
  file.write(markdown)
  return file
}

export function listReportFiles(): File[] {
  const dir = reportsDir()
  if (!dir.exists) return []
  return dir.list().filter((item): item is File => item instanceof File).sort((a, b) => (a.name < b.name ? 1 : -1))
}

export function readReport(file: File): string {
  return file.exists ? file.textSync() : ''
}

export function reportDirectory(): Directory {
  return reportsDir()
}
