// 主题计数（2026-09-18，WeKnora topic_resolve.go / service.go observeTopics 移植）：
// 提取每段附带输出 topics（用户在谈什么主题）→ 三级归一（精确/别名 → 字面模糊 → 模型批量裁决）
// → memory_topic_stats 计数 → 达阈值自动晋升 interest 条目（常驻注入）。
// 设计取舍（WeKnora 注释原意）：漏合并只是延迟晋升，错合并把两件事的计数混在一起且不可察觉——
// 所以模糊门槛故意高（Dice ≥0.80 且 ≥4 字）、裁决守卫只许更具体不许更宽泛、拿不准就判不同。

import type { DatabaseSync } from "node:sqlite";
import type { LlmAdapter } from "../harness/index";
import { memoryItemKey, normalizeTopicKey, sanitizeMemoryContent } from "./memory";
import type { MemoryItem, MemoryStore } from "./memory";

// ── 常量（WeKnora 同值） ──────────

export const TOPIC_FUZZY_THRESHOLD = 0.8; // 模糊归一门槛：字面 Dice 相似度
export const TOPIC_CANDIDATE_LIMIT = 40; // 归一与裁决时展示的已有主题数上限（个人规模绰绰有余）
export const TOPIC_MAX_ALIASES = 12; // 单主题别名上限
export const TOPIC_MAX_RUNES = 40; // 主题名字数上限
export const TOPIC_FUZZY_MIN_RUNES = 4; // 短标签不许模糊匹配（一个重合字占大半分数，误合并不可察）
export const TOPIC_ANCHOR_MIN = 0.3; // 裁决合并名与两侧的最低锚定相似度
export const TOPIC_LABEL_MAX_RUNES = 80; // 裁决合并名长度上限

export interface TopicStat {
  /** 路由与引用标识 = normalized_key（表无独立 uuid，个人规模单键足够） */
  id: string;
  topic: string;
  normalizedKey: string;
  aliases: string[];
  hits: number;
  lastSeenTs: number;
  promotedTs?: number;
  forgottenTs?: number;
}

// ── 纯函数（WeKnora internal/types/memory.go 移植） ──────────

/** 主题名净化：折叠空白/控制符 + 截长（模型输出防御） */
export function sanitizeTopicLabel(text: string): string {
  return [...sanitizeMemoryContent(text)].slice(0, TOPIC_MAX_RUNES).join("");
}

function topicBigrams(label: string): Set<string> {
  const runes = [...normalizeTopicKey(label)];
  const grams = new Set<string>();
  if (runes.length === 0) return grams;
  if (runes.length === 1) {
    grams.add(runes[0]!);
    return grams;
  }
  for (let i = 0; i + 1 < runes.length; i++) grams.add(runes[i]! + runes[i + 1]!);
  return grams;
}

/** 字面相似度：规范化后的字符 bigram Dice（对一方更长更宽容——模型爱加限定词的常见形态） */
export function topicSimilarity(a: string, b: string): number {
  const left = topicBigrams(a);
  const right = topicBigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** 模糊匹配资格：规范化后 ≥4 字（短标签走精确与裁决两级，不让字面碰运气） */
export function topicIsSpecificEnough(label: string): boolean {
  return [...normalizeTopicKey(label)].length >= TOPIC_FUZZY_MIN_RUNES;
}

/**
 * 裁决合并名守卫：提议名只能更完整、绝不更宽泛（被现名包含或比现名短 = 泛化，拒），
 * 且必须与合并两侧都锚定（相似 ≥0.30，防凭空发明）——防"每合并一次主题就宽一点"的棘轮。
 */
export function topicLabelIsAnImprovement(canonical: string, incoming: string, proposed: string): boolean {
  const proposedKey = normalizeTopicKey(proposed);
  const canonicalKey = normalizeTopicKey(canonical);
  if (proposedKey === "" || proposedKey === canonicalKey) return false;
  if (proposed.length > TOPIC_LABEL_MAX_RUNES) return false;
  if (canonicalKey.includes(proposedKey)) return false;
  if (proposedKey.length < canonicalKey.length) return false;
  return topicSimilarity(proposed, canonical) >= TOPIC_ANCHOR_MIN && topicSimilarity(proposed, incoming) >= TOPIC_ANCHOR_MIN;
}

// ── 存储 ──────────

interface TopicRow {
  normalized_key: string;
  topic: string;
  aliases_json: string;
  hits: number;
  last_seen_ts: number;
  promoted_ts: number | null;
  forgotten_ts: number | null;
}

function rowToStat(row: TopicRow): TopicStat {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases_json) as unknown;
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    // 坏行按空别名处理
  }
  return {
    id: row.normalized_key,
    topic: row.topic,
    normalizedKey: row.normalized_key,
    aliases,
    hits: row.hits,
    lastSeenTs: row.last_seen_ts,
    ...(row.promoted_ts !== null ? { promotedTs: row.promoted_ts } : {}),
    ...(row.forgotten_ts !== null ? { forgottenTs: row.forgotten_ts } : {}),
  };
}

function parseAliases(stat: TopicStat): string {
  return JSON.stringify(stat.aliases);
}

/** 计数 upsert：hits+1，新说法进别名（≤12），规范名保持首次记录值不随模型改口漂移 */
export function bumpTopic(db: DatabaseSync, uid: string, now: number, canonical: string, key: string, surface: string): TopicStat {
  const existing = getTopicByKey(db, uid, key);
  if (!existing) {
    const stat: TopicStat = {
      id: key,
      topic: canonical,
      normalizedKey: key,
      aliases: surface !== canonical ? [surface] : [],
      hits: 1,
      lastSeenTs: now,
    };
    db.prepare("INSERT INTO memory_topic_stats (uid, normalized_key, topic, aliases_json, hits, last_seen_ts) VALUES (?, ?, ?, ?, ?, ?)").run(uid, key, canonical, parseAliases(stat), 1, now);
    return stat;
  }
  const aliases = [...existing.aliases];
  if (surface !== existing.topic && !aliases.some((a) => normalizeTopicKey(a) === normalizeTopicKey(surface))) {
    if (aliases.length < TOPIC_MAX_ALIASES) aliases.push(surface);
  }
  const updated: TopicStat = { ...existing, aliases, hits: existing.hits + 1, lastSeenTs: now };
  db.prepare("UPDATE memory_topic_stats SET aliases_json = ?, hits = ?, last_seen_ts = ? WHERE uid = ? AND normalized_key = ?").run(parseAliases(updated), updated.hits, now, uid, key);
  return updated;
}

export function getTopicByKey(db: DatabaseSync, uid: string, key: string): TopicStat | null {
  const row = db.prepare("SELECT * FROM memory_topic_stats WHERE uid = ? AND normalized_key = ?").get(uid, key) as unknown as TopicRow | undefined;
  return row ? rowToStat(row) : null;
}

/** 未晋升且未遗忘的主题（前端主题区块；前端 id = normalized_key） */
export function listUnpromotedTopics(db: DatabaseSync, uid: string, limit = 100, offset = 0): TopicStat[] {
  const rows = db
    .prepare("SELECT * FROM memory_topic_stats WHERE uid = ? AND promoted_ts IS NULL AND forgotten_ts IS NULL ORDER BY hits DESC, last_seen_ts DESC LIMIT ? OFFSET ?")
    .all(uid, limit, offset) as unknown as TopicRow[];
  return rows.map(rowToStat);
}

/** 计数与裁决用的头部主题（按热度） */
export function listTopTopics(db: DatabaseSync, uid: string, limit = TOPIC_CANDIDATE_LIMIT): TopicStat[] {
  const rows = db
    .prepare("SELECT * FROM memory_topic_stats WHERE uid = ? AND forgotten_ts IS NULL ORDER BY hits DESC, last_seen_ts DESC LIMIT ?")
    .all(uid, limit) as unknown as TopicRow[];
  return rows.map(rowToStat);
}

export function markTopicPromoted(db: DatabaseSync, uid: string, key: string, ts: number): void {
  db.prepare("UPDATE memory_topic_stats SET promoted_ts = ? WHERE uid = ? AND normalized_key = ? AND promoted_ts IS NULL").run(ts, uid, key);
}

/** 手动晋升（前端"立即成为兴趣"）：不等计数达标，写入 interest 并标 promoted；遗忘行拒绝。
 *  写入成功即回调嵌入向量（与提取晋升同款，不等夜间回填） */
export async function promoteTopicManually(deps: {
  db: DatabaseSync;
  now(): number;
  memory: MemoryStore;
  uid: string;
  key: string;
  embedNewItems?: (uid: string, items: MemoryItem[]) => Promise<void> | void;
}): Promise<TopicStat | null> {
  const stat = getTopicByKey(deps.db, deps.uid, deps.key);
  if (!stat || stat.forgottenTs !== undefined) return null;
  const inserted = deps.memory.insertItem(deps.uid, {
    kind: "interest",
    content: stat.topic,
    topic: stat.topic,
    importance: 3,
    origin: "extracted",
    inferred: false,
  });
  markTopicPromoted(deps.db, deps.uid, stat.normalizedKey, deps.now());
  if (inserted.item) await deps.embedNewItems?.(deps.uid, [inserted.item]);
  return stat;
}

/** "不再追踪"：永不再自动计数晋升（已晋升的 interest 条目不受影响） */
export function forgetTopic(db: DatabaseSync, uid: string, key: string, ts: number): void {
  db.prepare("UPDATE memory_topic_stats SET forgotten_ts = ? WHERE uid = ? AND normalized_key = ?").run(ts, uid, key);
}

export function restoreTopic(db: DatabaseSync, uid: string, key: string): void {
  db.prepare("UPDATE memory_topic_stats SET forgotten_ts = NULL WHERE uid = ? AND normalized_key = ?").run(uid, key);
}

/** 裁决给出更好名字时改写规范名（保持计数与别名；目标键被占则放弃改名，不合并行） */
function renameTopic(db: DatabaseSync, uid: string, stat: TopicStat, label: string): TopicStat {
  const nextKey = normalizeTopicKey(label);
  if (nextKey === "" || nextKey === stat.normalizedKey) return stat;
  if (getTopicByKey(db, uid, nextKey)) return stat;
  db.prepare("UPDATE memory_topic_stats SET topic = ?, normalized_key = ? WHERE uid = ? AND normalized_key = ?").run(label, nextKey, uid, stat.normalizedKey);
  return { ...stat, topic: label, normalizedKey: nextKey, id: nextKey };
}

// ── 三级归一 ──────────

export interface TopicResolution {
  surface: string;
  /** 命中的已有主题；null = 本次新出现（同 run 内折叠后仍各自成行） */
  canonical: TopicStat | null;
  tier: "reused" | "exact" | "fuzzy" | "model" | "new";
  /** 裁决提议且过守卫的更好名字（canonical 行随之改名） */
  mergedLabel?: string;
}

export type TopicAdjudicator = (
  existing: string[],
  unresolved: string[],
) => Promise<Map<number, { sameAs: number; label?: string }>>;

/** 同一 run 内新说法彼此折叠：规范化相同 → 指向同一 surface，避免一次提取生成两行同义主题 */
function collapseNewTopicsWithinRun(resolutions: TopicResolution[]): void {
  for (let i = 0; i < resolutions.length; i++) {
    if (resolutions[i]!.canonical !== null) continue;
    for (let j = 0; j < i; j++) {
      if (resolutions[j]!.canonical !== null) continue;
      if (normalizeTopicKey(resolutions[i]!.surface) === normalizeTopicKey(resolutions[j]!.surface)) {
        resolutions[i]!.surface = resolutions[j]!.surface;
        break;
      }
    }
  }
}

/**
 * 把本次提取产出的主题名映射到已跟踪主题，代价从低到高：
 * tier1 精确（规范化相等或命中别名；模型复用已跟踪标签记 reused）→
 * tier2 模糊（Dice ≥0.80 且两侧 ≥4 字）→ tier3 模型批量裁决（只处理未决标签）。
 * 裁决不可用/失败 → 未决标签各自成新行（可见的欠合并优于不可见的错合并）。
 */
export async function resolveTopics(deps: {
  db: DatabaseSync;
  uid: string;
  surfaces: string[];
  adjudicate?: TopicAdjudicator;
}): Promise<TopicResolution[]> {
  if (deps.surfaces.length === 0) return [];
  const existing = listTopTopics(deps.db, deps.uid);
  const resolutions: TopicResolution[] = [];
  const unresolvedIdx: number[] = [];
  for (const surface of deps.surfaces) {
    const resolution: TopicResolution = { surface, canonical: null, tier: "new" };
    const key = normalizeTopicKey(surface);
    const exact = key !== "" ? existing.find((s) => s.normalizedKey === key || s.aliases.some((a) => normalizeTopicKey(a) === key)) : undefined;
    if (exact) {
      resolution.canonical = exact;
      resolution.tier = surface === exact.topic ? "reused" : "exact";
    } else if (topicIsSpecificEnough(surface)) {
      let best: TopicStat | undefined;
      let bestScore = 0;
      for (const stat of existing) {
        if (!topicIsSpecificEnough(stat.topic)) continue;
        const score = topicSimilarity(surface, stat.topic);
        if (score > bestScore) {
          best = stat;
          bestScore = score;
        }
      }
      if (best && bestScore >= TOPIC_FUZZY_THRESHOLD) {
        resolution.canonical = best;
        resolution.tier = "fuzzy";
      }
    }
    if (resolution.canonical === null) unresolvedIdx.push(resolutions.length);
    resolutions.push(resolution);
  }

  if (unresolvedIdx.length > 0 && existing.length > 0 && deps.adjudicate) {
    const decisions = await deps.adjudicate(
      existing.map((s) => s.topic),
      unresolvedIdx.map((i) => resolutions[i]!.surface),
    );
    for (const [offset, decision] of decisions) {
      const idx = unresolvedIdx[offset];
      if (idx === undefined) continue;
      if (decision.sameAs < 0 || decision.sameAs >= existing.length) continue;
      const resolution = resolutions[idx]!;
      if (resolution.canonical !== null) continue; // 只动未决标签，不覆盖更可靠层级的判定
      resolution.canonical = existing[decision.sameAs]!;
      resolution.tier = "model";
      const proposed = decision.label !== undefined ? sanitizeTopicLabel(decision.label) : "";
      if (proposed !== "" && topicLabelIsAnImprovement(resolution.canonical.topic, resolution.surface, proposed)) {
        resolution.mergedLabel = proposed;
      }
    }
  }

  collapseNewTopicsWithinRun(resolutions);
  return resolutions;
}

// ── 晋升主流程 ──────────

export interface ObserveTopicsResult {
  /** 本次完成计数的主题数（含命中已有主题） */
  counted: number;
  /** 本次晋升为 interest 的主题名 */
  promoted: string[];
  /** 晋升写入成功的 interest 条目（调用方据此写入即嵌入，不等夜间回填） */
  promotedItems: MemoryItem[];
}

/**
 * 计数与晋升（WeKnora observeTopics）：净化 → 三级归一 → 逐个 bump（遗忘主题跳过）→
 * 别名增长时作废对应 interest 的向量（回填按新说法重建）→ 达阈值且未晋升 → 写 interest 条目 → 标 promoted。
 * 晋升写入被拒（墓碑/重复）也照样标 promoted——被遗忘过一次的主题不该每轮重新自荐。
 */
export async function observeTopics(deps: {
  db: DatabaseSync;
  now(): number;
  memory: MemoryStore;
  uid: string;
  topics: string[];
  threshold?: number;
  adjudicate?: TopicAdjudicator;
}): Promise<ObserveTopicsResult> {
  const surfaces = deps.topics.map(sanitizeTopicLabel).filter((t) => t !== "");
  if (surfaces.length === 0) return { counted: 0, promoted: [], promotedItems: [] };
  const resolutions = await resolveTopics({ db: deps.db, uid: deps.uid, surfaces, ...(deps.adjudicate ? { adjudicate: deps.adjudicate } : {}) });
  const threshold = deps.threshold ?? 3;
  const result: ObserveTopicsResult = { counted: 0, promoted: [], promotedItems: [] };

  for (const resolution of resolutions) {
    const canonicalTopic = resolution.canonical !== null ? resolution.canonical.topic : resolution.surface;
    const key = normalizeTopicKey(canonicalTopic);
    if (key === "") continue;
    const before = resolution.canonical !== null ? resolution.canonical : getTopicByKey(deps.db, deps.uid, key);
    if (before?.forgottenTs !== undefined) continue; // 用户不再追踪：不计数、不晋升
    const stat = bumpTopic(deps.db, deps.uid, deps.now(), canonicalTopic, key, resolution.surface);
    result.counted += 1;

    // 裁决给了更好名字 → 改写规范名（promoted 键随行更新，后续计数自然落在新键下）
    const finalTopic = resolution.mergedLabel !== undefined ? renameTopic(deps.db, deps.uid, stat, resolution.mergedLabel).topic : stat.topic;
    const finalKey = normalizeTopicKey(finalTopic);

    // 别名增长 → 该主题 interest 的 embeddableText 变了 → 作废向量，夜间回填重建（别名只进向量）
    if (stat.aliases.length > (before?.aliases.length ?? 0)) {
      deps.db
        .prepare("DELETE FROM memory_item_embeddings WHERE uid = ? AND item_id = (SELECT id FROM memory_items WHERE uid = ? AND kind = 'interest' AND status = 'active' AND norm_key = ? LIMIT 1)")
        .run(deps.uid, deps.uid, memoryItemKey(finalTopic, finalTopic));
    }

    if (stat.promotedTs !== undefined || stat.hits < threshold) continue;
    // 写入结果不分支：被拒（墓碑/重复）也照常标 promoted——遗忘过的主题不该每轮重新自荐
    const inserted = deps.memory.insertItem(deps.uid, {
      kind: "interest",
      content: finalTopic,
      topic: finalTopic,
      importance: 3,
      origin: "extracted",
      inferred: false,
    });
    markTopicPromoted(deps.db, deps.uid, finalKey, deps.now());
    result.promoted.push(finalTopic);
    if (inserted.item) result.promotedItems.push(inserted.item);
  }
  return result;
}

// ── 模型裁决器（注入实现，测试用函数替换） ──────────

const ADJUDICATION_SYSTEM_PROMPT = `你在维护一个人的关注主题列表。下面给出「已有主题」和「新出现的说法」。

对每个新说法，判断它和某个已有主题**说的是不是同一件事**——注意是同一件事，有关系的不同事不算。

算同一件事：同义、换个说法、详略不同（「店员班次安排」和「门店排班管理」）；加了无关紧要的限定词。
不算同一件事：同一领域里的不同问题（「PostgreSQL 连接池」和「PostgreSQL 备份恢复」）；
一个是另一个的具体查询或下位概念（「数据库」和「PostgreSQL 连接池」）。

判为同一件事时，若其中一个名字明显更完整更准确，可在 label 给出应保留的名字（只许更准确，绝不许更宽泛，
也不要把两个名字拼起来）。拿不准就判不同：合并错了计数被污染且看不出来，没合并只是暂时多一行。

只输出 JSON：{"resolutions":[{"index":<新说法序号>,"same_as":<已有主题序号或 null>,"label":<更好的名字或 null>}]}`;

/**
 * 三级归一的模型层：一次调用批量裁决全部未决标签（温度不受 LlmRequest 控制，提示词约束 + 解析防御）。
 * 模型失败/输出不可解析 → 返回空 Map（各说法独立成行，欠合并可见、错合并为零）。
 */
export function createLlmTopicAdjudicator(deps: { adapter: LlmAdapter; model: string; log?(line: string): void }): TopicAdjudicator {
  return async (existing, unresolved) => {
    if (unresolved.length === 0 || existing.length === 0) return new Map();
    const user = [
      `已有主题：\n${existing.map((t, i) => `[${i}] ${t}`).join("\n")}`,
      `新出现的说法：\n${unresolved.map((t, i) => `[${i}] ${t}`).join("\n")}`,
    ].join("\n\n");
    try {
      const response = await deps.adapter.complete({
        provider: "memory",
        model: deps.model,
        system: ADJUDICATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        maxTokens: 800,
      });
      const text = response.message.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) return new Map();
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        resolutions?: { index?: unknown; same_as?: unknown; label?: unknown }[];
      };
      const out = new Map<number, { sameAs: number; label?: string }>();
      for (const item of parsed.resolutions ?? []) {
        if (typeof item.index !== "number" || !Number.isInteger(item.index)) continue;
        if (typeof item.same_as !== "number" || !Number.isInteger(item.same_as)) continue; // same_as=null = 判不同
        if (item.same_as < 0 || item.same_as >= existing.length) continue;
        out.set(item.index, { sameAs: item.same_as, ...(typeof item.label === "string" && item.label.trim() !== "" ? { label: item.label.trim() } : {}) });
      }
      return out;
    } catch (error) {
      deps.log?.(`[openprism] topic adjudication failed: ${String((error as Error)?.message ?? error)}`);
      return new Map();
    }
  };
}
