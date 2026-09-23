// BYOK Key 密封（Q8 铁律的技术面）：Key 只以 AES-256-GCM 密文落盘（model_config 表的 key_enc），
// 明文只在内存中短暂存在、只发往用户配置的 baseURL。主密钥 32B 落 data/secret.key（已 gitignore，不入库——
// 钥匙不锁在保险箱里）。

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function seal(master: Buffer, plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function open(master: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", master, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export async function loadOrCreateMasterKey(dataRoot: string, path?: string): Promise<Buffer> {
  const keyPath = path ?? `${dataRoot}/secret.key`;
  try {
    const key = await readFile(keyPath);
    if (key.length === 32) return key;
  } catch {
    // 首次启动：不存在
  }
  const key = randomBytes(32);
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, key, { mode: 0o600 });
  return key;
}

export interface ModelConfig {
  id?: string;
  platform?: string;
  baseURL: string;
  model: string;
  /** 上下文窗口 tokens（压缩器判压用）；缺省 = harness 默认 64K */
  contextWindow?: number;
  keyEnc?: string;
  /** 提供方用途（2026-09-18）：chat=对话/提取，embedding=记忆向量；缺省 chat */
  kind?: ModelProviderKind;
  /** 该模型是否支持图片识别（多模态）：对话里发图的前提；缺省 false */
  multimodal?: boolean;
}

export type ModelProviderKind = "chat" | "embedding";

export interface ModelProviderView {
  id: string;
  platform: string;
  baseURL: string;
  model: string;
  contextWindow: number | null;
  hasKey: boolean;
  kind: ModelProviderKind;
  multimodal: boolean;
}

const PLATFORM_PATTERNS: [RegExp, string][] = [
  [/deepseek/i, "DeepSeek"],
  [/bigmodel\.cn|zhipu/i, "智谱 GLM"],
  [/dashscope|aliyuncs/i, "通义千问 Qwen"],
  [/moonshot/i, "Moonshot Kimi"],
  [/openrouter/i, "OpenRouter"],
  [/openai\.com/i, "OpenAI"],
  [/siliconflow/i, "硅基流动"],
  [/volces\.com/i, "火山方舟"],
  [/minimax/i, "MiniMax"],
  [/baidu|qianfan/i, "百度千帆"],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0/i, "本地服务"],
];

/** baseURL → 平台显示名（保存时推导落库；识别不出回退 hostname） */
export function platformFromBaseURL(baseURL: string): string {
  for (const [pattern, name] of PLATFORM_PATTERNS) {
    if (pattern.test(baseURL)) return name;
  }
  try {
    return new URL(baseURL).hostname;
  } catch {
    return "";
  }
}

interface ProviderRow {
  id: string;
  uid: string;
  platform: string;
  base_url: string;
  model: string;
  context_window: number | null;
  key_enc: string | null;
  created_ts: number;
  kind: string | null;
  multimodal: number;
}

function rowToConfig(row: ProviderRow): ModelConfig {
  return {
    id: row.id,
    platform: row.platform,
    baseURL: row.base_url,
    model: row.model,
    ...(row.context_window !== null ? { contextWindow: row.context_window } : {}),
    ...(row.key_enc !== null ? { keyEnc: row.key_enc } : {}),
    kind: row.kind === "embedding" ? "embedding" : "chat",
    ...(row.multimodal === 1 ? { multimodal: true } : {}),
  };
}

function getRow(db: DatabaseSync, uid: string, id: string): ProviderRow | undefined {
  return db
    .prepare("SELECT * FROM model_providers WHERE id = ? AND uid = ?")
    .get(id, uid) as unknown as ProviderRow | undefined;
}

function activateIfFirst(db: DatabaseSync, uid: string, id: string): void {
  const has = db.prepare("SELECT provider_id FROM model_active WHERE uid = ?").get(uid);
  if (!has) db.prepare("INSERT INTO model_active (uid, provider_id) VALUES (?, ?)").run(uid, id);
}

export function addModelProvider(
  db: DatabaseSync,
  uid: string,
  input: { baseURL: string; model: string; contextWindow?: number | null; keyEnc?: string; platform?: string; kind?: ModelProviderKind; multimodal?: boolean },
): ModelConfig & { id: string } {
  const config: ModelConfig = {
    baseURL: input.baseURL,
    model: input.model,
    ...(input.contextWindow !== undefined && input.contextWindow !== null ? { contextWindow: input.contextWindow } : {}),
    ...(input.keyEnc !== undefined ? { keyEnc: input.keyEnc } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.multimodal ? { multimodal: true } : {}),
  };
  const id = randomUUID();
  const platform = input.platform?.trim() !== "" && input.platform !== undefined ? input.platform.trim() : platformFromBaseURL(input.baseURL);
  db.prepare(
    "INSERT INTO model_providers (id, uid, platform, base_url, model, context_window, key_enc, created_ts, kind, multimodal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    uid,
    platform,
    config.baseURL,
    config.model,
    config.contextWindow ?? null,
    config.keyEnc ?? null,
    Date.now(),
    config.kind ?? "chat",
    config.multimodal ? 1 : 0,
  );
  activateIfFirst(db, uid, id);
  return { ...config, id, platform };
}

export function updateModelProvider(
  db: DatabaseSync,
  uid: string,
  id: string,
  patch: { baseURL?: string; model?: string; contextWindow?: number | null; keyEnc?: string; kind?: ModelProviderKind; multimodal?: boolean },
): void {
  const row = getRow(db, uid, id);
  if (!row) throw new Error(`model provider "${id}" 不存在`);
  const next = {
    baseURL: patch.baseURL ?? row.base_url,
    model: patch.model ?? row.model,
    contextWindow: patch.contextWindow !== undefined ? patch.contextWindow : row.context_window,
    keyEnc: patch.keyEnc !== undefined ? patch.keyEnc : row.key_enc,
    kind: patch.kind ?? (row.kind === "embedding" ? "embedding" : "chat"),
    multimodal: patch.multimodal !== undefined ? (patch.multimodal ? 1 : 0) : row.multimodal,
  };
  const platform = patch.baseURL !== undefined ? platformFromBaseURL(next.baseURL) : row.platform;
  db.prepare(
    "UPDATE model_providers SET base_url = ?, model = ?, context_window = ?, key_enc = ?, platform = ?, kind = ?, multimodal = ? WHERE id = ? AND uid = ?",
  ).run(next.baseURL, next.model, next.contextWindow, next.keyEnc, platform, next.kind, next.multimodal, id, uid);
}

export function removeModelProvider(db: DatabaseSync, uid: string, id: string): void {
  const result = db.prepare("DELETE FROM model_providers WHERE id = ? AND uid = ?").run(id, uid);
  if (result.changes === 0) throw new Error(`model provider "${id}" 不存在`);
  // 引用清理（防悬空 409）：会话级绑定与伙伴默认模型一并置空（回落全局激活）；记忆 embedding 绑定同此
  db.prepare("UPDATE conversations SET model_provider_id = NULL WHERE uid = ? AND model_provider_id = ?").run(uid, id);
  db.prepare("UPDATE agents SET model_provider_id = NULL WHERE uid = ? AND model_provider_id = ?").run(uid, id);
  db.prepare("UPDATE memory_meta SET embedding_provider_id = NULL WHERE uid = ? AND embedding_provider_id = ?").run(uid, id);
  const active = db.prepare("SELECT provider_id FROM model_active WHERE uid = ?").get(uid) as
    | { provider_id: string }
    | undefined;
  if (active?.provider_id === id) {
    // 删的是激活行：自动切到最近配置的剩余供应商；没有剩余则清空激活
    const latest = db
      .prepare("SELECT id FROM model_providers WHERE uid = ? ORDER BY created_ts DESC, id LIMIT 1")
      .get(uid) as unknown as { id: string } | undefined;
    if (latest) db.prepare("UPDATE model_active SET provider_id = ? WHERE uid = ?").run(latest.id, uid);
    else db.prepare("DELETE FROM model_active WHERE uid = ?").run(uid);
  }
}

export function listModelProviders(db: DatabaseSync, uid: string): ModelProviderView[] {
  const rows = db
    .prepare("SELECT * FROM model_providers WHERE uid = ? ORDER BY created_ts, id")
    .all(uid) as unknown as ProviderRow[];
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    baseURL: row.base_url,
    model: row.model,
    contextWindow: row.context_window,
    hasKey: row.key_enc !== null,
    kind: row.kind === "embedding" ? "embedding" : "chat",
    multimodal: row.multimodal === 1,
  }));
}

export function activeModelId(db: DatabaseSync, uid: string): string | null {
  const row = db.prepare("SELECT provider_id FROM model_active WHERE uid = ?").get(uid) as
    | { provider_id: string }
    | undefined;
  return row?.provider_id ?? null;
}

export function setActiveModel(db: DatabaseSync, uid: string, id: string): void {
  const row = getRow(db, uid, id);
  if (!row) throw new Error(`model provider "${id}" 不存在`);
  db
    .prepare("INSERT INTO model_active (uid, provider_id) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET provider_id = excluded.provider_id")
    .run(uid, id);
}

/** 激活供应商的运行时视图（adapterFactory / 压缩器判压用）；无激活 → null */
export async function readModelConfig(db: DatabaseSync, uid: string): Promise<ModelConfig | null> {
  const id = activeModelId(db, uid);
  if (id === null) return null;
  return readModelProviderConfig(db, uid, id);
}

/** 按 id 取完整运行时配置（含 keyEnc；连接测试用） */
export function readModelProviderConfig(db: DatabaseSync, uid: string, id: string): ModelConfig | null {
  const row = getRow(db, uid, id);
  if (!row) return null;
  return rowToConfig(row);
}
