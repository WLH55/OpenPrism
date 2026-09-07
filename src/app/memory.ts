// 长期记忆（D5，ADR 0008 领域表）：L1 = 会话日志复用（不新建）；L3 = memory_slots 四槽 markdown + memory_meta。
// 2026-09-07 三层改版：L1→L2→L3 流水线移入 memory-layers.ts（L2 模块事实为 L3 提供证据链）；
// 本模块保留槽存储/注入（剥脚注）/save_preference 窄工具。
// 注入 = 四槽拼接 + 剥溯源脚注，随人设进 system prompt（5.2 全量自动）；模型写 = save_preference 窄工具（appendPreference）。

import type { DatabaseSync } from "node:sqlite";

export const MEMORY_SLOTS = ["recent", "profile", "scope", "preferences"] as const;
export type MemorySlot = (typeof MEMORY_SLOTS)[number];

const SLOT_LABELS: Record<MemorySlot, string> = {
  recent: "近期动态",
  profile: "画像",
  scope: "当前主线",
  preferences: "偏好",
};

const PREFERENCE_LIMIT = 240;

/** 剥溯源脚注：`[^n]: …` 定义行与行内 `[^n]` 引用（给人查出处的锚不喂模型，5.2） */
export function stripFootnotes(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*\[\^\d+\]\s*:/.test(line))
    .join("\n")
    .replace(/\[\^\d+\]/g, "")
    .trimEnd();
}

export interface MemoryStoreDeps {
  db: DatabaseSync;
  now(): number;
}

export interface MemoryMeta {
  lastRunTs?: number;
  runs: number;
}

export class MemoryStore {
  constructor(private deps: MemoryStoreDeps) {}

  async read(uid: string): Promise<Record<MemorySlot, string>> {
    const result = {} as Record<MemorySlot, string>;
    for (const slot of MEMORY_SLOTS) result[slot] = "";
    const rows = this.deps.db.prepare("SELECT slot, content_md FROM memory_slots WHERE uid = ?").all(uid) as unknown as {
      slot: string;
      content_md: string;
    }[];
    for (const row of rows) {
      if ((MEMORY_SLOTS as readonly string[]).includes(row.slot)) result[row.slot as MemorySlot] = row.content_md;
    }
    return result;
  }

  async writeSlot(uid: string, slot: MemorySlot, markdown: string): Promise<void> {
    this.deps.db
      .prepare(
        "INSERT INTO memory_slots (uid, slot, content_md, updated_ts) VALUES (?, ?, ?, ?) ON CONFLICT(uid, slot) DO UPDATE SET content_md = excluded.content_md, updated_ts = excluded.updated_ts",
      )
      .run(uid, slot, markdown, this.deps.now());
  }

  async meta(uid: string): Promise<MemoryMeta> {
    const row = this.deps.db.prepare("SELECT last_run_ts, runs FROM memory_meta WHERE uid = ?").get(uid) as
      | { last_run_ts: number | null; runs: number }
      | undefined;
    if (!row) return { runs: 0 };
    return { ...(row.last_run_ts !== null ? { lastRunTs: row.last_run_ts } : {}), runs: row.runs };
  }

  /** 记一次全链凝练（memory-layers.runAll 完成后调用；保留「上次凝练/累计」语义） */
  async markRun(uid: string): Promise<void> {
    const meta = await this.meta(uid);
    this.deps.db
      .prepare(
        "INSERT INTO memory_meta (uid, last_run_ts, runs) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET last_run_ts = excluded.last_run_ts, runs = excluded.runs",
      )
      .run(uid, this.deps.now(), meta.runs + 1);
  }

  /** save_preference 存储面：仅 preferences 槽、显式偏好、≤240 字、一次一条 */
  async appendPreference(uid: string, line: string, ts: number): Promise<void> {
    const text = line.trim();
    if (text === "") throw new Error("preference 不能为空");
    if (text.length > PREFERENCE_LIMIT) throw new Error(`preference ${text.length} 字符超过 ${PREFERENCE_LIMIT} 上限`);
    const date = new Date(ts);
    const stamp = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const current = (await this.read(uid)).preferences.replace(/\n+$/, "");
    const next = `${current}${current ? "\n" : ""}- ${text}（${stamp} 用户显式表达）`;
    await this.writeSlot(uid, "preferences", next + "\n");
  }

  /** 同步注入块（systemPrompt 闭包是同步的；node:sqlite 同步查询，四行小表开销可忽略） */
  injectionBlockSync(uid: string): string {
    const rows = this.deps.db.prepare("SELECT slot, content_md FROM memory_slots WHERE uid = ?").all(uid) as unknown as {
      slot: string;
      content_md: string;
    }[];
    const content: Partial<Record<MemorySlot, string>> = {};
    for (const row of rows) {
      if ((MEMORY_SLOTS as readonly string[]).includes(row.slot)) content[row.slot as MemorySlot] = row.content_md;
    }
    const parts: string[] = [];
    for (const slot of MEMORY_SLOTS) {
      const stripped = stripFootnotes(content[slot] ?? "").trim();
      if (stripped !== "") parts.push(`【${SLOT_LABELS[slot]}】\n${stripped}`);
    }
    return parts.join("\n\n");
  }
}

/** 模型写记忆的唯一通道：窄工具（仅 preferences、仅显式偏好、≤240、一次一条） */
export function createSavePreferenceTool(deps: { store: MemoryStore; uid: string; now(): number }): import("../harness/index").ToolDefinition {
  return {
    name: "save_preference",
    description: "用户显式表达了偏好或要求（如称呼、语气、习惯）时，用这个工具记住。只记用户明确说出的，不要猜、不要推断。一次一条。",
    parameters: {
      type: "object",
      required: ["preference"],
      properties: { preference: { type: "string", description: "用户原话或忠实转述，≤240 字" } },
    },
    output: {
      schema: { type: "object", required: ["saved"], properties: { saved: { type: "boolean" } } },
      render: () => [{ type: "text", text: "已记住这条偏好" }],
    },
    async execute(args) {
      const preference = String((args as { preference?: string })?.preference ?? "");
      await deps.store.appendPreference(deps.uid, preference, deps.now());
      return { saved: true };
    },
    isConcurrencySafe: () => false,
  };
}
