// SQLite 存储引擎（ADR 0008）：领域表建模 + WAL + synchronous=FULL。
// 全部 DDL 收敛在本文件；各 store 持有 DatabaseSync 做同步读写（persona 注入/会话签发的同步语义不破）。
// harness 零平台依赖铁律不破：node:sqlite 只允许出现在 src/app 层。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  salt       TEXT NOT NULL,
  pwd_hash   TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);

-- 账本：四类记录（event 流水 / plan 计划 / checkin 打卡 / void 作废）单表继承，
-- (uid, seq) 主键 = 用户内追加序；void 引用 target_seq，折叠层剔除、审计保留。
CREATE TABLE IF NOT EXISTS ledger_entries (
  uid         TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('event','plan','checkin','void')),
  ts          INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('agent','ui')),
  actor_conv  TEXT,
  actor_agent TEXT,
  time        INTEGER,
  category    TEXT,
  note        TEXT,
  value       REAL,
  unit        TEXT,
  attrs_json  TEXT,
  plan_id     TEXT,
  title       TEXT,
  scope       TEXT,
  due         TEXT,
  ndays       INTEGER,
  checkin_plan_id TEXT,
  at          INTEGER,
  done        INTEGER,
  target_seq  INTEGER,
  reason      TEXT,
  PRIMARY KEY (uid, seq)
);
CREATE INDEX IF NOT EXISTS idx_ledger_kind_time ON ledger_entries(uid, kind, time);
CREATE INDEX IF NOT EXISTS idx_ledger_category ON ledger_entries(uid, category, time);

CREATE TABLE IF NOT EXISTS conversations (
  cid           TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  agent_id      TEXT,
  model_provider_id TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  switches_json TEXT NOT NULL DEFAULT '[]',
  created_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_uid ON conversations(uid, created_ts);

-- 会话九事件（harness/session/events.ts 词表）：cid = 聊天 cid 或 "task:<taskId>"。
-- event_json 保留九事件完整原文（content 块多态由 harness 类型管校验）；role 为消息类冗余列。
CREATE TABLE IF NOT EXISTS conversation_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cid        TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  role       TEXT,
  event_json TEXT NOT NULL,
  UNIQUE (cid, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON conversation_events(cid, type, seq);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  uid               TEXT NOT NULL,
  name              TEXT NOT NULL,
  persona_md        TEXT NOT NULL DEFAULT '',
  bindings_json     TEXT NOT NULL DEFAULT '{}',
  description       TEXT NOT NULL DEFAULT '',
  emoji             TEXT NOT NULL DEFAULT '',
  color             TEXT NOT NULL DEFAULT '',
  avatar            TEXT,
  language          TEXT NOT NULL DEFAULT '',
  model_provider_id TEXT,
  created_ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_uid ON agents(uid);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  when_to_use TEXT,
  body_md     TEXT NOT NULL DEFAULT '',
  created_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_uid ON skills(uid);

CREATE TABLE IF NOT EXISTS mcps (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  headers_json TEXT,
  created_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcps_uid ON mcps(uid);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  uid               TEXT NOT NULL,
  agent_id          TEXT,
  title             TEXT NOT NULL,
  instruction       TEXT NOT NULL,
  trigger_json      TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  tz_offset_minutes INTEGER NOT NULL DEFAULT 0,
  created_ts        INTEGER NOT NULL,
  last_run_ts       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_uid ON tasks(uid, enabled);

CREATE TABLE IF NOT EXISTS task_runs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uid     TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  status  TEXT NOT NULL CHECK (status IN ('ran','skipped','failed')),
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(uid, task_id, ts);

CREATE TABLE IF NOT EXISTS notifications (
  uid     TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  task_id TEXT,
  text    TEXT NOT NULL,
  read_ts INTEGER,
  PRIMARY KEY (uid, seq)
);

CREATE TABLE IF NOT EXISTS memory_slots (
  uid        TEXT NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('recent','profile','scope','preferences')),
  content_md TEXT NOT NULL DEFAULT '',
  updated_ts INTEGER,
  PRIMARY KEY (uid, slot)
);

CREATE TABLE IF NOT EXISTS memory_meta (
  uid         TEXT PRIMARY KEY,
  last_run_ts INTEGER,
  runs        INTEGER NOT NULL DEFAULT 0
);

-- 记忆条目化（2026-09-10，WeKnora 化重构 Spec §6.1）：条目 = 唯一真相，supersede 链不物理删除；
-- 旧 L1/L2/L3 六表（l1_entities/l1_changes/l2_entries/l2_meta/l3_meta/memory_slots）代码零引用，仅为回滚保留。
-- kind 增 interest（2026-09-18 主题计数晋升）；存量库 CHECK 无 interest，由 ensureInterestKind 重建表迁移。
CREATE TABLE IF NOT EXISTS memory_items (
  uid           TEXT NOT NULL,
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('profile','preference','fact','task','interest')),
  status        TEXT NOT NULL CHECK (status IN ('active','superseded','archived','pending')),
  origin        TEXT NOT NULL CHECK (origin IN ('explicit','extracted','manual')),
  topic         TEXT NOT NULL DEFAULT '',
  norm_key      TEXT NOT NULL,
  content       TEXT NOT NULL,
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source_ref    TEXT,
  valid_from    INTEGER NOT NULL,
  invalid_at    INTEGER,
  superseded_by TEXT,
  expires_at    INTEGER,
  last_used_ts  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS idx_memory_items_key ON memory_items(uid, norm_key, status);
CREATE INDEX IF NOT EXISTS idx_memory_items_live ON memory_items(uid, status, importance, valid_from);

-- 墓碑：只存指纹与主题（不存原文），阻止后台蒸馏复活用户已删除的记忆
CREATE TABLE IF NOT EXISTS memory_tombstones (
  uid         TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT '',
  source_ref  TEXT,
  created_ts  INTEGER NOT NULL,
  PRIMARY KEY (uid, fingerprint)
);

-- 主题计数（2026-09-18，WeKnora memory_topic_stats 移植）：同一主题跨对话重复出现 → 计数，
-- 达阈值自动晋升 interest 记忆；aliases 收录历次说法（归一索引 + interest 向量重建原料）；
-- forgotten_ts = 用户"不再追踪"（永不再自动晋升）；promoted_ts 防重复晋升。
CREATE TABLE IF NOT EXISTS memory_topic_stats (
  uid            TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  topic          TEXT NOT NULL,
  aliases_json   TEXT NOT NULL DEFAULT '[]',
  hits           INTEGER NOT NULL DEFAULT 0,
  last_seen_ts   INTEGER NOT NULL,
  promoted_ts    INTEGER,
  forgotten_ts   INTEGER,
  PRIMARY KEY (uid, normalized_key)
);

-- 记忆三层（2026-09-07，对齐 DeepTutor）：L1 实时镜像快照 + 变更日志；L2 每模块事实 + seen 门控；L3 槽增量 meta。
CREATE TABLE IF NOT EXISTS l1_entities (
  uid         TEXT NOT NULL,
  surface     TEXT NOT NULL CHECK (surface IN ('chat','ledger','tasks')),
  ref         TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (uid, surface, ref)
);
CREATE INDEX IF NOT EXISTS idx_l1_surface ON l1_entities(uid, surface);

CREATE TABLE IF NOT EXISTS l1_changes (
  uid     TEXT NOT NULL,
  surface TEXT NOT NULL,
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL CHECK (kind IN ('added','modified','removed')),
  ref     TEXT NOT NULL,
  label   TEXT NOT NULL DEFAULT '',
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l1_changes_surface ON l1_changes(uid, surface, id);

CREATE TABLE IF NOT EXISTS l2_entries (
  uid        TEXT NOT NULL,
  surface    TEXT NOT NULL CHECK (surface IN ('chat','ledger','tasks')),
  id         TEXT NOT NULL,
  section    TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  refs_json  TEXT NOT NULL DEFAULT '[]',
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER,
  PRIMARY KEY (uid, surface, id)
);
CREATE INDEX IF NOT EXISTS idx_l2_surface ON l2_entries(uid, surface, created_ts);

CREATE TABLE IF NOT EXISTS l2_meta (
  uid            TEXT NOT NULL,
  surface        TEXT NOT NULL,
  seen_refs_json TEXT NOT NULL DEFAULT '[]',
  last_update_ts INTEGER,
  PRIMARY KEY (uid, surface)
);

CREATE TABLE IF NOT EXISTS l3_meta (
  uid            TEXT NOT NULL,
  slot           TEXT NOT NULL CHECK (slot IN ('recent','profile','scope','preferences')),
  seen_json      TEXT NOT NULL DEFAULT '[]',
  last_update_ts INTEGER,
  PRIMARY KEY (uid, slot)
);

CREATE TABLE IF NOT EXISTS model_config (
  uid      TEXT PRIMARY KEY,
  base_url TEXT NOT NULL DEFAULT '',
  model    TEXT NOT NULL DEFAULT '',
  key_enc  TEXT
);

-- 多模型接入（2026-09-07）：model_providers 多行 + model_active 激活指针；model_config 仅作旧数据迁移源。
CREATE TABLE IF NOT EXISTS model_providers (
  id             TEXT PRIMARY KEY,
  uid            TEXT NOT NULL,
  platform       TEXT NOT NULL DEFAULT '',
  base_url       TEXT NOT NULL,
  model          TEXT NOT NULL,
  context_window INTEGER,
  key_enc        TEXT,
  created_ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_providers_uid ON model_providers(uid, created_ts);

CREATE TABLE IF NOT EXISTS model_active (
  uid         TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL
);

-- 向量召回（2026-09-18，WeKnora memory_item_embeddings 移植）：BLOB（小端 float32）= 唯一真相；
-- model_id = providerId:model名（换提供方或换模型名 → 旧向量自然失效，由回填按新模型重建）；
-- source_fingerprint = 条目内容指纹（内容变更即重算）。个人规模进程内余弦扫描，不用向量索引扩展。
CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  uid                TEXT NOT NULL,
  item_id            TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  dims               INTEGER NOT NULL,
  vector             BLOB NOT NULL,
  source_fingerprint TEXT NOT NULL,
  created_ts         INTEGER NOT NULL,
  PRIMARY KEY (uid, item_id)
);

-- 查询向量缓存（铁律 2 的确定性面）：同文本同模型只算一次；注入块因此 = 库状态（含本表）+ 日志内
-- query 文本 的确定性推导，重放无需任何外部调用。
CREATE TABLE IF NOT EXISTS query_vectors (
  uid         TEXT NOT NULL,
  text_key    TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  created_ts  INTEGER NOT NULL,
  PRIMARY KEY (uid, text_key, model_id)
);

CREATE TABLE IF NOT EXISTS archives (
  uid        TEXT PRIMARY KEY,
  list_json  TEXT NOT NULL DEFAULT '[]',
  updated_ts INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 存量库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列） */
function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * 存量库 memory_items 的 kind CHECK 不含 interest（SQLite 改 CHECK 只能重建表）：
 * 检测建表 SQL 里没有 interest 即重建（数据原样搬运 + 重建索引）；幂等，新库直接跳过。
 */
function ensureInterestKind(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'").get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("'interest'")) return;
  db.exec(`
    CREATE TABLE memory_items_rebuild (
      uid           TEXT NOT NULL,
      id            TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('profile','preference','fact','task','interest')),
      status        TEXT NOT NULL CHECK (status IN ('active','superseded','archived','pending')),
      origin        TEXT NOT NULL CHECK (origin IN ('explicit','extracted','manual')),
      topic         TEXT NOT NULL DEFAULT '',
      norm_key      TEXT NOT NULL,
      content       TEXT NOT NULL,
      importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
      source_ref    TEXT,
      valid_from    INTEGER NOT NULL,
      invalid_at    INTEGER,
      superseded_by TEXT,
      expires_at    INTEGER,
      last_used_ts  INTEGER,
      use_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (uid, id)
    );
    INSERT INTO memory_items_rebuild (uid, id, kind, status, origin, topic, norm_key, content, importance, source_ref, valid_from, invalid_at, superseded_by, expires_at, last_used_ts, use_count)
      SELECT uid, id, kind, status, origin, topic, norm_key, content, importance, source_ref, valid_from, invalid_at, superseded_by, expires_at, last_used_ts, use_count FROM memory_items;
    DROP TABLE memory_items;
    ALTER TABLE memory_items_rebuild RENAME TO memory_items;
    CREATE INDEX IF NOT EXISTS idx_memory_items_key ON memory_items(uid, norm_key, status);
    CREATE INDEX IF NOT EXISTS idx_memory_items_live ON memory_items(uid, status, importance, valid_from);
  `);
}

/** 打开（或创建）数据库：DDL 幂等；":memory:" 供测试 */
export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=FULL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(DDL);
  ensureColumn(db, "conversations", "model_provider_id", "TEXT"); // 会话级模型绑定（2026-09-07）
  ensureColumn(db, "conversations", "pinned", "INTEGER NOT NULL DEFAULT 0"); // 置顶（定时提醒会话）
  // 伙伴创建向导（2026-09-07，对齐 DeepTutor）：身份字段 + 回复语言 + 默认模型；persona_md 语义升级为「灵魂」
  ensureColumn(db, "agents", "description", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "agents", "emoji", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "agents", "color", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "agents", "avatar", "TEXT"); // data:image/* data URL，≤200KB
  ensureColumn(db, "agents", "language", "TEXT NOT NULL DEFAULT ''"); // ''=自动跟随 | zh | en
  ensureColumn(db, "agents", "model_provider_id", "TEXT"); // 伙伴默认模型；NULL = 跟随会话/全局
  // 记忆条目化（2026-09-10）：调度与水位线状态扩列（chat 水位线 / ledger 水位线 / tasks 指纹 / 去抖计划 / 在飞 / 提取节流 / 整理时钟）
  ensureColumn(db, "memory_meta", "extract_cursor", "INTEGER");
  ensureColumn(db, "memory_meta", "ledger_cursor", "INTEGER");
  ensureColumn(db, "memory_meta", "tasks_fingerprint", "TEXT");
  ensureColumn(db, "memory_meta", "scheduled_ts", "INTEGER");
  ensureColumn(db, "memory_meta", "in_flight_since", "INTEGER");
  ensureColumn(db, "memory_meta", "last_extract_ts", "INTEGER");
  ensureColumn(db, "memory_meta", "consolidated_ts", "INTEGER");
  // 主题计数与向量召回（2026-09-18）：晋升阈值（NULL=默认 3）+ 记忆绑定的 embedding 提供方（NULL=语义召回关闭）
  ensureColumn(db, "memory_meta", "interest_threshold", "INTEGER");
  ensureColumn(db, "memory_meta", "embedding_provider_id", "TEXT");
  ensureColumn(db, "model_providers", "kind", "TEXT NOT NULL DEFAULT 'chat'"); // 提供方用途（chat|embedding，2026-09-18）
  ensureInterestKind(db); // 存量库 kind CHECK 补 interest（重建表，幂等）
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}
