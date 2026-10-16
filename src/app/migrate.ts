// 旧数据迁移（ADR 0008）：旧单模型 model_config → model_providers + 激活。
// JSONL 一次性导入器已删（2026-10-01 随遗留数据文件一并清理）；model_config 表本身也删（schema v2），
// 本函数只服务「表还在的老库」升级：吸收完由 db.ts 的 dropLegacyTables 删表。

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { platformFromBaseURL } from "./secretbox";

/** 旧版单模型 model_config 行 → model_providers + 激活（幂等：表已删即返回；providers 非空即跳过） */
export function migrateLegacyModelConfig(db: DatabaseSync): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_config'").get();
  if (!table) return; // 新库（schema v2 起不再建表）或已删表的老库，二次启动直接跳过
  const has = db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as unknown as { n: number };
  if (has.n > 0) return;
  const rows = db.prepare("SELECT uid, base_url, model, key_enc FROM model_config").all() as unknown as {
    uid: string;
    base_url: string;
    model: string;
    key_enc: string | null;
  }[];
  for (const row of rows) {
    if (row.base_url === "" && row.model === "") continue; // 空配置不迁
    const id = randomUUID();
    db.prepare(
      "INSERT INTO model_providers (id, uid, platform, base_url, model, context_window, key_enc, created_ts) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)"
    ).run(id, row.uid, platformFromBaseURL(row.base_url), row.base_url, row.model, row.key_enc, Date.now());
    db.prepare("INSERT OR IGNORE INTO model_active (uid, provider_id) VALUES (?, ?)").run(row.uid, id);
  }
}
