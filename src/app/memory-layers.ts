// 记忆三层（2026-09-07，对齐 DeepTutor）：L1 工作区镜像（live 适配器 + 指纹快照 + 变更日志）
// → L2 每模块事实（LLM 抽取，section+refs 证据链，seen_refs 增量门控）
// → L3 跨模块知识（只吃 L2 新事实，脚注引模块名；preferences 永不自动综合，工具直写）。
// 注入对话仍只有 L3（MemoryStore.injectionBlockSync 剥脚注）；L1/L2 供人查看与策展。

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LlmAdapter } from "../harness/index";
import { MEMORY_SLOTS, type MemorySlot, type MemoryStore } from "./memory";
import type { Ledger, LedgerRecord } from "./ledger";
import type { TaskDef, TaskTrigger, TaskRun } from "./tasks";

export const L1_SURFACES = ["chat", "ledger", "tasks"] as const;
export type L1Surface = (typeof L1_SURFACES)[number];

export const SURFACE_LABELS: Record<L1Surface, string> = { chat: "对话", ledger: "生活账本", tasks: "提醒" };

export const L2_SECTIONS: Record<L1Surface, string[]> = {
  chat: ["话题", "习惯", "误解", "掌握"],
  ledger: ["消费", "饮食", "健康", "作息"],
  tasks: ["坚持中", "常错过", "意愿"],
};

/** 自动综合的 L3 槽（preferences 由 save_preference 工具直写，与 DeepTutor 一致永不自动综合） */
export const L3_AUTO_SLOTS = ["recent", "profile", "scope"] as const;
export type L3AutoSlot = (typeof L3_AUTO_SLOTS)[number];

const SLOT_LABELS: Record<MemorySlot, string> = { recent: "近期动态", profile: "画像", scope: "当前主线", preferences: "偏好" };
const SLOT_HINTS: Record<L3AutoSlot, string> = {
  recent: "近期动态只保留最近 1-4 周的事，旧的删掉，按时间倒序",
  profile: "画像只收有模块事实支撑的稳定判断（身份、性格、长期状态）",
  scope: "当前主线按「推进中 / 卡住 / 已完成」组织正在发生的事",
};

const CHAT_CONTENT_CAP = 6000; // 单会话实体内容截断
const L2_INPUT_CAP = 15000; // L2 抽取输入尾部截断
const L2_FACT_CAP = 240; // 单条事实字数上限（DeepTutor 同款）

/** 每晚定时窗口（本地 2–5 点）与门槛：服务常驻不重启也能日更（2026-09-08，区别于启动惰性检查） */
export const NIGHTLY_WINDOW = { startHour: 2, endHour: 5 };
export const MEMORY_STALE_MS = 20 * 3600 * 1000;

/** 夜间定时判定：窗口内 + 距上次全链 ≥20h；tz 缺省 = 服务器本地时区。纯函数（测试注入 tz 保确定性） */
export function nightlyDue(lastRunTs: number | undefined, now: number, tzOffsetMinutes?: number): boolean {
  const tz = tzOffsetMinutes ?? -new Date(now).getTimezoneOffset();
  const hour = new Date(now + tz * 60000).getUTCHours();
  const inWindow = hour >= NIGHTLY_WINDOW.startHour && hour < NIGHTLY_WINDOW.endHour;
  const stale = lastRunTs === undefined || now - lastRunTs >= MEMORY_STALE_MS;
  return inWindow && stale;
}

export interface L1Entity {
  ref: string;
  label: string;
  ts: number;
  content: string;
  fingerprint: string;
}

export interface L1Diff {
  added: number;
  modified: number;
  removed: number;
}

export interface L2Entry {
  id: string;
  section: string;
  text: string;
  refs: string[];
  createdTs: number;
  updatedTs?: number;
}

export interface MemoryLayerDeps {
  db: DatabaseSync;
  now(): number;
  randomUUID(): string;
  ledgerFor(uid: string): Promise<Ledger>;
  tasks: import("./tasks").TaskStore;
}

// ── L1 live 适配器（不落原始内容，按 ref 现查） ──────────────────

function fingerprintOf(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

function describeTrigger(trigger: TaskTrigger): string {
  switch (trigger.kind) {
    case "once":
      return `单次 ${new Date(trigger.at).toLocaleString()}`;
    case "daily":
      return `每天 ${trigger.time}`;
    case "weekly":
      return trigger.days.join("、").length > 0 ? `每周${trigger.days.join("、")} ${trigger.time}` : `每周 ${trigger.time}`;
    case "monthly":
      return `每月 ${trigger.day} 日 ${trigger.time}`;
    case "yearly":
      return `每年 ${trigger.month}-${trigger.day} ${trigger.time}`;
    case "interval": {
      const unit = { minute: "分钟", hour: "小时", day: "天", week: "周", month: "个月", year: "年" }[trigger.unit];
      const freq = trigger.every === 1 ? `每${unit}` : `每 ${trigger.every} ${unit}`;
      return trigger.time ? `${freq} ${trigger.time}` : freq;
    }
    case "cron":
      return `cron ${trigger.expr}`;
  }
}

export class MemoryLayers {
  constructor(
    private deps: MemoryLayerDeps,
    private memory: MemoryStore, // L3 槽读写复用
  ) {}

  // ── L1 ──

  /** 实时扫描某 surface 的工作区实体 */
  async l1Live(uid: string, surface: L1Surface): Promise<L1Entity[]> {
    switch (surface) {
      case "chat": {
        const convs = this.deps.db
          .prepare("SELECT cid, title, created_ts FROM conversations WHERE uid = ? ORDER BY created_ts")
          .all(uid) as unknown as { cid: string; title: string; created_ts: number }[];
        const rows = this.deps.db
          .prepare(
            `SELECT ce.cid, ce.role, ce.event_json FROM conversation_events ce
             JOIN conversations c ON c.cid = ce.cid
             WHERE c.uid = ? AND ce.type IN ('user/message','assistant/message') ORDER BY ce.id`,
          )
          .all(uid) as unknown as { cid: string; role: string | null; event_json: string }[];
        const byCid = new Map<string, string[]>();
        for (const row of rows) {
          try {
            const event = JSON.parse(row.event_json) as { message?: { content?: { type: string; text?: string }[] } };
            const text = (event.message?.content ?? [])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
              .trim();
            if (text === "") continue;
            const list = byCid.get(row.cid) ?? [];
            list.push(`[${row.role === "assistant" ? "助手" : "用户"}] ${text}`);
            byCid.set(row.cid, list);
          } catch {
            // 坏行跳过
          }
        }
        return convs.map((c) => {
          const content = (byCid.get(c.cid) ?? []).join("\n");
          const capped = content.length > CHAT_CONTENT_CAP ? `…（前文略）\n${content.slice(-CHAT_CONTENT_CAP)}` : content;
          return {
            ref: `chat:${c.cid}`,
            label: c.title || "未命名会话",
            ts: c.created_ts,
            content: capped,
            fingerprint: fingerprintOf(capped),
          };
        });
      }
      case "ledger": {
        const ledger = await this.deps.ledgerFor(uid);
        const records = ledger.readAll().filter((r): r is Exclude<LedgerRecord, { kind: "void" }> => r.kind !== "void");
        const planTitles = new Map<string, string>();
        for (const r of records) if (r.kind === "plan") planTitles.set(r.planId, r.title);
        const fmtDate = (ts: number): string => new Date(ts).toLocaleDateString("zh-CN");
        return records.map((r) => {
          let text: string;
          switch (r.kind) {
            case "event": {
              const amount = r.value !== undefined ? ` ${r.value}${r.unit ?? ""}` : "";
              text = `流水：${r.category}${r.note ? `（${r.note}）` : ""}${amount}`;
              break;
            }
            case "plan":
              text = `计划：${r.title}（${r.scope}${r.due ? `，截止 ${r.due}` : ""}）`;
              break;
            case "checkin":
              text = `打卡：${planTitles.get(r.planId) ?? r.planId} ${r.done ? "完成" : "未完成"}`;
              break;
          }
          const content = `${fmtDate(r.ts)} ${text}`;
          return { ref: `ledger:${r.seq}`, label: text.slice(0, 40), ts: r.ts, content, fingerprint: fingerprintOf(content) };
        });
      }
      case "tasks": {
        const tasks = await this.deps.tasks.list(uid);
        return tasks.map((t: TaskDef) => {
          const lastRun = t.lastRunTs !== undefined ? new Date(t.lastRunTs).toLocaleString() : "未跑过";
          const content = `${t.title}\n指令：${t.instruction}\n触发：${describeTrigger(t.trigger)}\n状态：${t.enabled ? "启用" : "停用"}\n上次运行：${lastRun}`;
          return { ref: `task:${t.id}`, label: t.title, ts: t.createdTs, content, fingerprint: fingerprintOf(content) };
        });
      }
    }
  }

  private storedRefs(uid: string, surface: L1Surface): Map<string, string> {
    const rows = this.deps.db
      .prepare("SELECT ref, fingerprint FROM l1_entities WHERE uid = ? AND surface = ?")
      .all(uid, surface) as unknown as { ref: string; fingerprint: string }[];
    return new Map(rows.map((r) => [r.ref, r.fingerprint]));
  }

  /** diff 预览（不落盘） */
  async l1Pending(uid: string, surface: L1Surface): Promise<L1Diff> {
    const stored = this.storedRefs(uid, surface);
    const live = await this.l1Live(uid, surface);
    return MemoryLayers.diff(stored, live);
  }

  private static diff(stored: Map<string, string>, live: L1Entity[]): L1Diff {
    let added = 0;
    let modified = 0;
    const liveRefs = new Set<string>();
    for (const entity of live) {
      liveRefs.add(entity.ref);
      const fp = stored.get(entity.ref);
      if (fp === undefined) added += 1;
      else if (fp !== entity.fingerprint) modified += 1;
    }
    let removed = 0;
    for (const ref of stored.keys()) if (!liveRefs.has(ref)) removed += 1;
    return { added, modified, removed };
  }

  /** 记录变化：diff 落盘（快照更新 + changes 追加）；无变化时不动 changes */
  async l1Refresh(uid: string, surface: L1Surface): Promise<L1Diff> {
    const stored = this.storedRefs(uid, surface);
    const live = await this.l1Live(uid, surface);
    const diff = MemoryLayers.diff(stored, live);
    if (diff.added + diff.modified + diff.removed === 0) return diff;
    const now = this.deps.now();
    const liveRefs = new Set(live.map((e) => e.ref));
    for (const entity of live) {
      const fp = stored.get(entity.ref);
      if (fp === entity.fingerprint) continue;
      this.deps.db
        .prepare(
          "INSERT INTO l1_entities (uid, surface, ref, label, ts, fingerprint) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uid, surface, ref) DO UPDATE SET label = excluded.label, ts = excluded.ts, fingerprint = excluded.fingerprint",
        )
        .run(uid, surface, entity.ref, entity.label, entity.ts, entity.fingerprint);
      const kind = fp === undefined ? "added" : "modified";
      this.deps.db
        .prepare("INSERT INTO l1_changes (uid, surface, kind, ref, label, ts) VALUES (?, ?, ?, ?, ?, ?)")
        .run(uid, surface, kind, entity.ref, entity.label, now);
    }
    for (const ref of stored.keys()) {
      if (!liveRefs.has(ref)) {
        this.deps.db.prepare("DELETE FROM l1_entities WHERE uid = ? AND surface = ? AND ref = ?").run(uid, surface, ref);
        this.deps.db
          .prepare("INSERT INTO l1_changes (uid, surface, kind, ref, label, ts) VALUES (?, ?, 'removed', ?, ?, ?)")
          .run(uid, surface, ref, "", now);
      }
    }
    return diff;
  }

  l1Changes(uid: string, surface: L1Surface, limit = 50): { kind: string; ref: string; label: string; ts: number }[] {
    const rows = this.deps.db
      .prepare("SELECT kind, ref, label, ts FROM l1_changes WHERE uid = ? AND surface = ? ORDER BY id DESC LIMIT ?")
      .all(uid, surface, limit) as unknown as { kind: string; ref: string; label: string; ts: number }[];
    return rows;
  }

  // ── L2 ──

  l2Entries(uid: string, surface: L1Surface): L2Entry[] {
    const rows = this.deps.db
      .prepare("SELECT id, section, text, refs_json, created_ts, updated_ts FROM l2_entries WHERE uid = ? AND surface = ? ORDER BY created_ts, id")
      .all(uid, surface) as unknown as { id: string; section: string; text: string; refs_json: string; created_ts: number; updated_ts: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      section: row.section,
      text: row.text,
      refs: JSON.parse(row.refs_json) as string[],
      createdTs: row.created_ts,
      ...(row.updated_ts !== null ? { updatedTs: row.updated_ts } : {}),
    }));
  }

  l2EntryCount(uid: string, surface: L1Surface): number {
    const row = this.deps.db.prepare("SELECT COUNT(*) AS n FROM l2_entries WHERE uid = ? AND surface = ?").get(uid, surface) as unknown as { n: number };
    return row.n;
  }

  async l2EditEntry(uid: string, surface: L1Surface, id: string, patch: { text?: string; section?: string }): Promise<void> {
    const row = this.deps.db.prepare("SELECT id FROM l2_entries WHERE uid = ? AND surface = ? AND id = ?").get(uid, surface, id);
    if (!row) throw new Error(`l2 entry "${id}" 不存在`);
    if (patch.section !== undefined && !L2_SECTIONS[surface].includes(patch.section)) throw new Error(`section 非法：${patch.section}`);
    const text = patch.text?.trim();
    if (text === "") throw new Error("text 不能为空");
    this.deps.db
      .prepare("UPDATE l2_entries SET text = COALESCE(?, text), section = COALESCE(?, section), updated_ts = ? WHERE uid = ? AND surface = ? AND id = ?")
      .run(text ?? null, patch.section ?? null, this.deps.now(), uid, surface, id);
  }

  l2RemoveEntry(uid: string, surface: L1Surface, id: string): void {
    const result = this.deps.db.prepare("DELETE FROM l2_entries WHERE uid = ? AND surface = ? AND id = ?").run(uid, surface, id);
    if (result.changes === 0) throw new Error(`l2 entry "${id}" 不存在`);
  }

  /** 清空某 surface 的消费门控（不删已抽条目）：下轮更新全量重喂（修正提示词/换模型后补救用） */
  l2ResetGate(uid: string, surface: L1Surface): void {
    this.deps.db.prepare("DELETE FROM l2_meta WHERE uid = ? AND surface = ?").run(uid, surface);
  }

  private l2SeenRefs(uid: string, surface: L1Surface): Set<string> {
    const row = this.deps.db.prepare("SELECT seen_refs_json FROM l2_meta WHERE uid = ? AND surface = ?").get(uid, surface) as
      | { seen_refs_json: string }
      | undefined;
    return new Set(row ? (JSON.parse(row.seen_refs_json) as string[]) : []);
  }

  /** 门控键：ref#fingerprint——实体内容变化（如会话追加消息）即视为新输入重喂（2026-09-07 修正：只记 ref 会让长会话记忆停滞） */
  private static gateKey(entity: L1Entity): string {
    return `${entity.ref}#${entity.fingerprint}`;
  }

  static renderEntitiesForL2(entities: L1Entity[]): string {
    return entities
      .map((e) => `=== @${e.ref} ===\nlabel: ${e.label}\ntime: ${new Date(e.ts).toISOString()}\n${e.content}`)
      .join("\n\n");
  }

  /** L2 抽取：新实体（ref ∉ seen_refs）→ LLM 抽事实（section+refs 校验）→ 落条目 + meta 门控推进 */
  async l2Update(
    uid: string,
    surface: L1Surface,
    adapter: LlmAdapter,
    model: string,
  ): Promise<{ added: number; skipped?: "no_new_input" | "bad_output" | "no_valid_facts" }> {
    const seen = this.l2SeenRefs(uid, surface);
    const live = await this.l1Live(uid, surface);
    const fresh = live.filter((e) => !seen.has(MemoryLayers.gateKey(e)));
    if (fresh.length === 0) return { added: 0, skipped: "no_new_input" };

    const existing = this.l2Entries(uid, surface);
    const existingBlock =
      existing.length === 0 ? "（暂无）" : existing.map((e) => `- [${e.section}] ${e.text}`).join("\n").slice(-3000);
    const block = MemoryLayers.renderEntitiesForL2(fresh);
    const capped = block.length > L2_INPUT_CAP ? `…（较早材料略）\n${block.slice(-L2_INPUT_CAP)}` : block;

    const response = await adapter.complete({
      provider: "memory",
      model,
      system: buildL2Prompt(surface, existingBlock, capped),
      messages: [{ role: "user", content: [{ type: "text", text: "请抽取事实并只输出约定 JSON。" }] }],
    });
    const text = response.message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const facts = parseFactsJson(text);
    if (facts === null) return { added: 0, skipped: "bad_output" };

    const validRefs = new Set(fresh.map((e) => e.ref));
    const sections = L2_SECTIONS[surface];
    const fallbackSection = sections[0]!; // 模型没按目录输出时就近落档，不丢事实（可后续编辑）
    const now = this.deps.now();
    let added = 0;
    for (const fact of facts) {
      if (fact.text.trim() === "") continue;
      const refs = fact.refs.filter((r) => validRefs.has(r));
      if (refs.length === 0) continue; // 无出处 = 不收（证据链铁律）
      const section = sections.includes(fact.section) ? fact.section : fallbackSection;
      const id = `m_${this.deps.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      this.deps.db
        .prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(uid, surface, id, section, fact.text.trim().slice(0, L2_FACT_CAP), JSON.stringify(refs), now);
      added += 1;
    }
    // 门控推进：解析成功但所有事实都被拒（引用无效）→ 不推进，下次重试；空 facts = 模型判定无可抽 → 推进
    if (facts.length > 0 && added === 0) return { added: 0, skipped: "no_valid_facts" };
    const seenJson = JSON.stringify(live.map((e) => MemoryLayers.gateKey(e)));
    this.deps.db
      .prepare(
        "INSERT INTO l2_meta (uid, surface, seen_refs_json, last_update_ts) VALUES (?, ?, ?, ?) ON CONFLICT(uid, surface) DO UPDATE SET seen_refs_json = excluded.seen_refs_json, last_update_ts = excluded.last_update_ts",
      )
      .run(uid, surface, seenJson, now);
    return { added };
  }

  // ── L3 ──

  private l3Seen(uid: string, slot: L3AutoSlot): Set<string> {
    const row = this.deps.db.prepare("SELECT seen_json FROM l3_meta WHERE uid = ? AND slot = ?").get(uid, slot) as
      | { seen_json: string }
      | undefined;
    return new Set(row ? (JSON.parse(row.seen_json) as string[]) : []);
  }

  /** 某槽是否还有未综合的 L2 新事实（总览徽标用） */
  l3Pending(uid: string, slot: L3AutoSlot): number {
    const seen = this.l3Seen(uid, slot);
    let pending = 0;
    for (const surface of L1_SURFACES) {
      for (const entry of this.l2Entries(uid, surface)) {
        if (!seen.has(`${surface}:${entry.id}`)) pending += 1;
      }
    }
    return pending;
  }

  /** L3 综合：只吃 L2 新事实（对冲表述 + 模块脚注证据）；preferences 永不进这里 */
  async l3Update(uid: string, slot: L3AutoSlot, adapter: LlmAdapter, model: string): Promise<{ changed: boolean; skipped?: "no_new_input" | "bad_output" }> {
    const seen = this.l3Seen(uid, slot);
    const groups: string[] = [];
    const allRefs: string[] = [];
    for (const surface of L1_SURFACES) {
      const fresh = this.l2Entries(uid, surface).filter((e) => !seen.has(`${surface}:${e.id}`));
      if (fresh.length === 0) continue;
      allRefs.push(...fresh.map((e) => `${surface}:${e.id}`));
      groups.push(`### ${SURFACE_LABELS[surface]}（${surface}）\n${fresh.map((e) => `- [${e.section}] ${e.text}`).join("\n")}`);
    }
    if (groups.length === 0) return { changed: false, skipped: "no_new_input" };

    const current = (await this.memory.read(uid))[slot as MemorySlot] ?? "";
    const response = await adapter.complete({
      provider: "memory",
      model,
      system: buildL3Prompt(slot, current, groups.join("\n\n")),
      messages: [{ role: "user", content: [{ type: "text", text: "请综合并只输出该槽的 markdown 正文。" }] }],
    });
    const text = response.message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text === "") return { changed: false, skipped: "bad_output" };

    await this.memory.writeSlot(uid, slot as MemorySlot, `${text}\n`);
    const now = this.deps.now();
    this.deps.db
      .prepare(
        "INSERT INTO l3_meta (uid, slot, seen_json, last_update_ts) VALUES (?, ?, ?, ?) ON CONFLICT(uid, slot) DO UPDATE SET seen_json = excluded.seen_json, last_update_ts = excluded.last_update_ts",
      )
      .run(uid, slot, JSON.stringify(allRefs), now);
    return { changed: true };
  }

  /** 全链：L1 refresh ×3 → L2 update ×3 → L3 update ×3；并推进 memory_meta 总计数 */
  async runAll(uid: string, adapter: LlmAdapter, model: string): Promise<{
    l1: Record<L1Surface, L1Diff>;
    l2: Record<L1Surface, { added: number; skipped?: string }>;
    l3: Record<L3AutoSlot, { changed: boolean; skipped?: string }>;
  }> {
    // per-surface 失败隔离：任一步 LLM 异常（网络/配额）记 error 跳过，不阻塞其余层（部分进度可见）
    const l1 = {} as Record<L1Surface, L1Diff>;
    const l2 = {} as Record<L1Surface, { added: number; skipped?: string }>;
    for (const surface of L1_SURFACES) {
      l1[surface] = await this.l1Refresh(uid, surface);
      try {
        l2[surface] = await this.l2Update(uid, surface, adapter, model);
      } catch {
        l2[surface] = { added: 0, skipped: "error" };
      }
    }
    const l3 = {} as Record<L3AutoSlot, { changed: boolean; skipped?: string }>;
    for (const slot of L3_AUTO_SLOTS) {
      try {
        l3[slot] = await this.l3Update(uid, slot, adapter, model);
      } catch {
        l3[slot] = { changed: false, skipped: "error" };
      }
    }
    return { l1, l2, l3 };
  }
}

// ── prompt 构造（zh，参照 DeepTutor prompts/zh 的约束风格） ──────────

export function buildL2Prompt(surface: L1Surface, existingBlock: string, entityBlock: string): string {
  const sections = L2_SECTIONS[surface].join(" / ");
  return `你在为用户维护「${SURFACE_LABELS[surface]}」模块的长期记忆事实（L2）。下面给出该模块新增的原始材料，请抽取对跨会话仍有价值的事实。

规则：
- 只输出一个 JSON 对象：{"facts":[{"text":"...","section":"...","refs":["..."]}]}，不要输出其他文字、解释或代码块围栏。
- text：≤${L2_FACT_CAP} 字的陈述句；禁用"彻底/总是/从不"等绝对化表述（除非引用原话）；拿不准的不写。
- section：必须取自：${sections}
- refs：该事实依据的实体 ref 数组（从材料的 @ref 标记里取），至少 1 个。
- 不要重复「已有条目」里已记录的事实。

已有条目（不要重复）：
${existingBlock}

新增实体材料：
${entityBlock}`;
}

export function buildL3Prompt(slot: L3AutoSlot, current: string, freshBlock: string): string {
  return `你在维护用户的跨模块长期记忆（L3）「${SLOT_LABELS[slot]}」槽。输入是各模块（对话 chat / 生活账本 ledger / 提醒 tasks）新整理出的 L2 事实，请综合更新这个槽的 markdown。

规则：
- ${SLOT_HINTS[slot]}
- 每条命题末尾附证据引用标记（如 [^1]），文末给出脚注定义，脚注内容只能是模块名：chat / ledger / tasks。
- 判断必须对冲表述：说明依据规模，如"在多次 chat 对话中，用户……"；单条 ≤${L2_FACT_CAP} 字；单模块孤立的一次事件不下稳定结论。
- 输出纯 markdown 正文，不要代码块围栏、不要解释。

现有「${SLOT_LABELS[slot]}」内容（在其基础上增删改）：
${current.trim() || "（空）"}

各模块新事实：
${freshBlock}`;
}

/** 从模型输出里解析事实 JSON（容忍代码围栏）；解析失败返回 null（fail-safe 不落盘） */
export function parseFactsJson(text: string): { text: string; section: string; refs: string[] }[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { facts?: { text?: string; section?: string; refs?: unknown }[] };
    if (!Array.isArray(parsed.facts)) return null;
    return parsed.facts
      .filter((f) => typeof f.text === "string" && typeof f.section === "string")
      .map((f) => ({
        text: f.text as string,
        section: f.section as string,
        refs: Array.isArray(f.refs) ? (f.refs as unknown[]).filter((r): r is string => typeof r === "string") : [],
      }));
  } catch {
    return null;
  }
}
