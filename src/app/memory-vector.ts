// 向量召回服务（2026-09-18，WeKnora vector.go / memory_vector.go 移植）：
// 记忆条目 → embedding（小端 float32 存 BLOB，BLOB 为唯一真相）→ 查询向量（缓存表，铁律 2 确定性面）
// → 进程内余弦全量扫描（个人规模毫秒级；WeKnora 无 pgvector 时同款退路）→ 交 fuseRankings 与词法融合。
// 一切失败都降级：embedding 未配置/超时/报错 → 返回 null，注入与深查退回纯词法，聊天链路零感知。

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LlmAdapter } from "../harness/index";
import { memoryFingerprint, type MemoryItem, type MemoryVectorHit } from "./memory";
import { normalizeTopicKey } from "./memory";

// ── 常量（WeKnora 同值） ──────────

export const VECTOR_MIN_COSINE = 0.5; // 低于此不算命中（词法融合仍在，可捞回字面精确匹配）
export const QUERY_EMBED_TIMEOUT_MS = 2000; // 查询侧限时：召回站在每个回答前面，语义匹配只值零点几秒
export const WRITE_EMBED_TIMEOUT_MS = 10_000; // 写入侧宽松：不在响应路径上
export const BACKFILL_PER_RUN = 200; // 每轮回填上限（每条一次计费调用，限速）
export const VECTOR_FANOUT = 8; // 注入融合的向量候选数（> 情境上限 5，给融合留余地）

// ── 向量编解码（小端 float32 ↔ BLOB；x86/ARM 内存即小端，读写零转换） ──────────

export function encodeVector(vector: number[]): Uint8Array {
  const out = new Uint8Array(vector.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i]!, true);
  return out;
}

export function decodeVector(data: Uint8Array | ArrayBuffer): number[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length % 4 !== 0) throw new Error(`vector blob 长度 ${bytes.length} 不是 4 的倍数`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < bytes.length / 4; i++) out.push(view.getFloat32(i * 4, true));
  return out;
}

/** 余弦相似度；维度不一致就地抛错（不同模型向量不可比，属编程错误不属运行降级） */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`cosine 维度不一致：${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** 参与向量的文本：主题：内容（主题给出"这句话关于什么"；interest 的别名由调用方拼接） */
export function embeddableText(item: { topic: string; content: string }): string {
  const topic = item.topic.trim();
  const content = item.content.trim();
  if (topic !== "" && topic !== content) return `${topic}：${content}`;
  return content;
}

/** 向量行模型标识：提供方 id + 模型名（任一变更 → 旧向量自然失效，回填按新模型重建） */
export function vectorModelTag(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

function textKey(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

interface EmbeddingRow {
  item_id: string;
  model_id: string;
  dims: number;
  vector: Uint8Array;
  source_fingerprint: string;
}

interface ItemEmbedRow {
  id: string;
  kind: string;
  topic: string;
  content: string;
  e_fp: string | null;
  e_vector: Uint8Array | null;
  e_dims: number | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

export interface MemoryVectorDeps {
  db: DatabaseSync;
  now(): number;
  /** 记忆绑定的 embedding 提供方（memory_meta.embedding_provider_id → 提供方行）；null = 语义召回关闭 */
  embeddingFor(uid: string): Promise<{ adapter: LlmAdapter; model: string; providerId: string } | null>;
  log?(line: string): void;
  /** 超时竞速用睡眠（测试注入即时 resolve 保确定性）；缺省真实 setTimeout（unref） */
  sleep?(ms: number): Promise<void>;
}

export interface RecallHitsOptions {
  /** situational = 注入情境池（fact/task 提取条目）；all = search_memory 深查全库 active */
  scope?: "situational" | "all";
  limit?: number;
}

export function createMemoryVector(deps: MemoryVectorDeps) {
  const sleep = deps.sleep ?? defaultSleep;
  const log = (line: string): void => deps.log?.(line);

  /** 单段文本 → 向量；超时/失败 → null（不抛：embedding 故障永不打断调用方链路） */
  async function embedText(built: { adapter: LlmAdapter; model: string }, text: string, timeoutMs: number): Promise<number[] | null> {
    if (text.trim() === "") return null;
    if (!built.adapter.embed) return null;
    const embedPromise: Promise<number[] | null> = built.adapter
      .embed({ model: built.model, input: text })
      .then((r) => r.vector)
      .catch((error) => {
        log(`[openprism] memory embed failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
        return null;
      });
    const timeoutPromise = sleep(timeoutMs).then(() => null as number[] | null);
    return Promise.race([embedPromise, timeoutPromise]);
  }

  /** 查询向量（缓存表命中直返；未命中调用后落表——注入块因此是库状态的确定性推导，铁律 2） */
  async function queryVectorCached(
    uid: string,
    text: string,
    built: { adapter: LlmAdapter; model: string; providerId: string },
  ): Promise<number[] | null> {
    const tag = vectorModelTag(built.providerId, built.model);
    const key = textKey(text);
    const row = deps.db.prepare("SELECT dims, vector FROM query_vectors WHERE uid = ? AND text_key = ? AND model_id = ?").get(uid, key, tag) as
      | { dims: number; vector: Uint8Array }
      | undefined;
    if (row) return decodeVector(row.vector);
    const vector = await embedText(built, text, QUERY_EMBED_TIMEOUT_MS);
    if (vector === null) return null;
    deps.db
      .prepare("INSERT OR REPLACE INTO query_vectors (uid, text_key, model_id, dims, vector, created_ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(uid, key, tag, vector.length, encodeVector(vector), deps.now());
    return vector;
  }

  /** 候选条目池行集（附 embedding 列）；stale 判定在 JS（指纹/维度不匹配按缺失处理） */
  function candidateRows(uid: string, tag: string, scope: "situational" | "all"): ItemEmbedRow[] {
    const situationalFilter = scope === "situational" ? "AND i.kind IN ('fact','task') AND i.origin = 'extracted'" : "";
    return deps.db
      .prepare(
        `SELECT i.id, i.kind, i.topic, i.content, e.source_fingerprint AS e_fp, e.vector AS e_vector, e.dims AS e_dims
         FROM memory_items i
         LEFT JOIN memory_item_embeddings e ON e.uid = i.uid AND e.item_id = i.id AND e.model_id = ?
         WHERE i.uid = ? AND i.status = 'active' AND (i.expires_at IS NULL OR i.expires_at > ?) ${situationalFilter}
         LIMIT 400`,
      )
      .all(tag, uid, deps.now()) as unknown as ItemEmbedRow[];
  }

  return {
    /** 语义命中（已过余弦门槛、按分数降序）；null = 语义召回不可用（关闭/超时/失败/零命中语义由调用方不区分） */
    async recallHits(uid: string, query: string, options?: RecallHitsOptions): Promise<MemoryVectorHit[] | null> {
      const scope = options?.scope ?? "situational";
      const limit = options?.limit ?? VECTOR_FANOUT;
      const built = await deps.embeddingFor(uid);
      if (!built || !built.adapter.embed) return null;
      const queryVector = await queryVectorCached(uid, query, built);
      if (queryVector === null) return null;
      const tag = vectorModelTag(built.providerId, built.model);
      const hits: MemoryVectorHit[] = [];
      for (const row of candidateRows(uid, tag, scope)) {
        if (row.e_vector === null || row.e_dims === null || row.e_fp === null) continue;
        if (row.e_dims !== queryVector.length) continue; // 维度不符 = 换过模型未回填，当缺失
        if (row.e_fp !== memoryFingerprint(row.content)) continue; // 内容已编辑，旧向量过期
        const score = cosine(queryVector, decodeVector(row.e_vector));
        if (score >= VECTOR_MIN_COSINE) hits.push({ id: row.id, score });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, limit);
    },

    /** 新条目顺手写入向量（best-effort：失败只留日志，夜间回填兜底） */
    async embedNewItems(uid: string, items: MemoryItem[]): Promise<void> {
      if (items.length === 0) return;
      const built = await deps.embeddingFor(uid);
      if (!built || !built.adapter.embed) return;
      const tag = vectorModelTag(built.providerId, built.model);
      for (const item of items) {
        const text = embeddableText(item) + this.interestAliasSuffix(uid, item);
        const vector = await embedText(built, text, WRITE_EMBED_TIMEOUT_MS);
        if (vector === null) continue;
        deps.db
          .prepare("INSERT OR REPLACE INTO memory_item_embeddings (uid, item_id, model_id, dims, vector, source_fingerprint, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(uid, item.id, tag, vector.length, encodeVector(vector), memoryFingerprint(item.content), deps.now());
      }
    },

    /** interest 条目的别名后缀（别名只进向量扩大语义命中面，不进注入块） */
    interestAliasSuffix(uid: string, item: MemoryItem): string {
      if (item.kind !== "interest" || item.topic.trim() === "") return "";
      const key = normalizeTopicKey(item.topic);
      if (key === "") return "";
      const row = deps.db.prepare("SELECT aliases_json FROM memory_topic_stats WHERE uid = ? AND normalized_key = ?").get(uid, key) as
        | { aliases_json: string }
        | undefined;
      if (!row) return "";
      try {
        const aliases = JSON.parse(row.aliases_json) as unknown;
        if (!Array.isArray(aliases)) return "";
        const extra = aliases.filter((a): a is string => typeof a === "string" && a.trim() !== "" && a !== item.topic && a !== item.content);
        return extra.length > 0 ? `；${extra.join("；")}` : "";
      } catch {
        return "";
      }
    },

    /**
     * 夜间回填：缺失向量（无行 / 指纹不匹配）按当前模型补算，每轮限速。
     * 批内一次 embedding 失败即停（后续大概率同样失败，不空转计费）。
     */
    async backfill(uid: string, limit = BACKFILL_PER_RUN): Promise<number> {
      const built = await deps.embeddingFor(uid);
      if (!built || !built.adapter.embed) return 0;
      const tag = vectorModelTag(built.providerId, built.model);
      const rows = candidateRows(uid, tag, "all");
      // 换过提供方/模型 → 新 tag 下全部无行 → 全量视为缺失，由限速逐轮消化
      const missing = rows.filter((row) => row.e_vector === null || row.e_fp === null || row.e_fp !== memoryFingerprint(row.content)).slice(0, limit);
      let filled = 0;
      for (const row of missing) {
        const item: MemoryItem = {
          id: row.id,
          kind: row.kind as MemoryItem["kind"],
          status: "active",
          origin: "extracted",
          topic: row.topic,
          normKey: "",
          content: row.content,
          importance: 3,
          validFrom: 0,
          useCount: 0,
        };
        const text = embeddableText(item) + this.interestAliasSuffix(uid, item);
        const vector = await embedText(built, text, WRITE_EMBED_TIMEOUT_MS);
        if (vector === null) break;
        deps.db
          .prepare("INSERT OR REPLACE INTO memory_item_embeddings (uid, item_id, model_id, dims, vector, source_fingerprint, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(uid, row.id, tag, vector.length, encodeVector(vector), memoryFingerprint(row.content), deps.now());
        filled += 1;
      }
      if (filled > 0) log(`[openprism] memory embeddings backfilled ${filled} for ${uid}`);
      return filled;
    },
  };
}
