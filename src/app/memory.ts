// 长期记忆（D5）：L1 = 会话日志复用（不新建）；L3 = 四槽位 markdown + meta。
// 凝练（LLM 批处理，fail-safe：解析失败不落盘）触发 = 手动/启动惰性（定时器归批次 3 调度器）；
// 注入 = 四槽拼接 + 剥溯源脚注，随人设进 system prompt（5.2 全量自动）；模型写 = save_preference 窄工具（appendPreference）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileIO, LlmAdapter } from "../harness/index";
import type { AppPaths } from "./store";

export const MEMORY_SLOTS = ["recent", "profile", "scope", "preferences"] as const;
export type MemorySlot = (typeof MEMORY_SLOTS)[number];

const SLOT_LABELS: Record<MemorySlot, string> = {
  recent: "近期动态",
  profile: "画像",
  scope: "当前主线",
  preferences: "偏好",
};

const PREFERENCE_LIMIT = 240;

/** 四槽 markdown 的规范目录（conversations 的 systemPrompt 每步同步重取用） */
export function memoryDir(pathsLike: { userDir(uid: string): string }, uid: string): string {
  return join(pathsLike.userDir(uid), "memory");
}

/** 同步版注入块（systemPrompt 闭包是同步的；槽位文件小，读盘开销可忽略） */
export function syncInjectionBlock(pathsLike: { userDir(uid: string): string }, uid: string): string {
  const parts: string[] = [];
  for (const slot of MEMORY_SLOTS) {
    let content = "";
    try {
      content = readFileSync(join(memoryDir(pathsLike, uid), `${slot}.md`), "utf8");
    } catch {
      continue;
    }
    const stripped = stripFootnotes(content).trim();
    if (stripped !== "") parts.push(`【${SLOT_LABELS[slot]}】\n${stripped}`);
  }
  return parts.join("\n\n");
}

/** 剥溯源脚注：`[^n]: …` 定义行与行内 `[^n]` 引用（给人查出处的锚不喂模型，5.2） */
export function stripFootnotes(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*\[\^\d+\]\s*:/.test(line))
    .join("\n")
    .replace(/\[\^\d+\]/g, "")
    .trimEnd();
}

export function buildConsolidationPrompt(sessionTexts: string[], currentMemory: Record<MemorySlot, string>): string {
  const memorySection = MEMORY_SLOTS.map((slot) => `### ${slot}（${SLOT_LABELS[slot]}）\n${currentMemory[slot] || "（空）"}`).join("\n\n");
  return `你在为用户维护长期记忆文档。下面是近期对话摘录与现有记忆，请凝练/更新为四段 markdown。

规则：
- 只保留跨会话仍然成立的信息；近期动态只留最近的事，旧的删掉。
- 不确定的不要写；没有内容的槽写空（输出里仍保留槽标记）。
- 每段格式必须是：<!-- slot: 槽名 --> 独占一行，随后是正文。
- 槽名只能用：${MEMORY_SLOTS.join(" / ")}，标记样例依次为：<!-- slot: recent -->、<!-- slot: profile -->、<!-- slot: scope -->、<!-- slot: preferences -->。
- 偏好（preferences）保持无序列表，一条一行。

近期对话摘录：
${sessionTexts.join("\n") || "（无）"}

现有记忆：
${memorySection}`;
}

export interface MemoryStoreDeps {
  fileIO: FileIO;
  paths: AppPaths;
  now(): number;
}

interface MemoryMeta {
  lastRunTs?: number;
  runs: number;
}

export class MemoryStore {
  constructor(private deps: MemoryStoreDeps) {}

  private slotFile(uid: string, slot: MemorySlot): string {
    return join(this.deps.paths.userDir(uid), "memory", `${slot}.md`);
  }
  private metaFile(uid: string): string {
    return join(this.deps.paths.userDir(uid), "memory", "meta.json");
  }

  async read(uid: string): Promise<Record<MemorySlot, string>> {
    const result = {} as Record<MemorySlot, string>;
    for (const slot of MEMORY_SLOTS) {
      try {
        result[slot] = await readFile(this.slotFile(uid, slot), "utf8");
      } catch {
        result[slot] = "";
      }
    }
    return result;
  }

  private async writeRaw(path: string, content: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = path + ".tmp";
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  }

  async writeSlot(uid: string, slot: MemorySlot, markdown: string): Promise<void> {
    await this.writeRaw(this.slotFile(uid, slot), markdown);
  }

  async meta(uid: string): Promise<MemoryMeta> {
    try {
      return JSON.parse(await readFile(this.metaFile(uid), "utf8")) as MemoryMeta;
    } catch {
      return { runs: 0 };
    }
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

  /** 注入块：非空槽拼接（带槽标题）+ 剥脚注；全空返回空串 */
  async injectionBlock(uid: string): Promise<string> {
    const memory = await this.read(uid);
    const parts: string[] = [];
    for (const slot of MEMORY_SLOTS) {
      const stripped = stripFootnotes(memory[slot]).trim();
      if (stripped !== "") parts.push(`【${SLOT_LABELS[slot]}】\n${stripped}`);
    }
    return parts.join("\n\n");
  }

  private parseSlotOutput(text: string): Partial<Record<MemorySlot, string>> {
    const parsed: Partial<Record<MemorySlot, string>> = {};
    const marker = /<!--\s*slot:\s*([a-z]+)\s*-->/g;
    let match: RegExpExecArray | null;
    const positions: { slot: string; start: number; contentStart: number }[] = [];
    while ((match = marker.exec(text)) !== null) {
      positions.push({ slot: match[1]!, start: match.index, contentStart: match.index + match[0].length });
    }
    for (let i = 0; i < positions.length; i++) {
      const slot = positions[i]!.slot as MemorySlot;
      if (!(MEMORY_SLOTS as readonly string[]).includes(slot)) continue;
      const end = i + 1 < positions.length ? positions[i + 1]!.start : text.length;
      const content = text.slice(positions[i]!.contentStart, end).trim();
      parsed[slot] = content;
    }
    return parsed;
  }

  /** 凝练：一次 LLM 批处理 → 四段输出 → 原子落盘 + meta；解析失败 fail-safe 不写 */
  async consolidate(input: { uid: string; adapter: LlmAdapter; model: string; sessionTexts: string[] }): Promise<{ changed: boolean }> {
    const current = await this.read(input.uid);
    const response = await input.adapter.complete({
      provider: "memory",
      model: input.model,
      system: buildConsolidationPrompt(input.sessionTexts, current),
      messages: [{ role: "user", content: [{ type: "text", text: "请凝练并输出四段记忆。" }] }],
    });
    const text = response.message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const parsed = this.parseSlotOutput(text);
    const slots = MEMORY_SLOTS.filter((slot) => parsed[slot] !== undefined && parsed[slot] !== "");
    if (slots.length === 0) return { changed: false };
    for (const slot of slots) {
      await this.writeSlot(input.uid, slot, parsed[slot]! + "\n");
    }
    const meta = await this.meta(input.uid);
    await this.writeRaw(this.metaFile(input.uid), JSON.stringify({ lastRunTs: this.deps.now(), runs: meta.runs + 1 }));
    return { changed: true };
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
