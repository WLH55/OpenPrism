// 智能体三段配置之「人设卡 + 能力绑定」（D4/4.1）：
// persona.md = 纯自由 markdown（名字随 H1 重推导）；binding.json = 内置工具开关 + 技能/MCP 绑定。

import { join } from "node:path";
import type { FileIO } from "../harness/index";
import type { AppPaths } from "./store";
import { extractAgentName } from "./persona";

export interface AgentEntry {
  id: string;
  name: string;
  createdTs: number;
}

export interface AgentBinding {
  /** 启用的内置工具名（缺省/空 = 全部四工具） */
  tools?: string[];
  skills: string[];
  mcps: string[];
}

interface AgentIndexEntry extends AgentEntry {
  binding: AgentBinding;
}

export interface AgentStoreDeps {
  fileIO: FileIO;
  paths: AppPaths;
  now(): number;
  randomUUID(): string;
}

const INDEX = "index.jsonl";

/** persona.md 的规范路径（conversations 的 systemPrompt 每步同步重取用） */
export function agentPersonaFile(paths: AppPaths, uid: string, aid: string): string {
  return join(paths.userDir(uid), "agents", aid, "persona.md");
}

/** agents 索引的规范路径 */
export function agentIndexFile(paths: AppPaths, uid: string): string {
  return join(paths.userDir(uid), "agents", INDEX);
}

export class AgentStore {
  constructor(private deps: AgentStoreDeps) {}

  private dir(uid: string): string {
    return join(this.deps.paths.userDir(uid), "agents");
  }
  private indexFile(uid: string): string {
    return join(this.dir(uid), INDEX);
  }
  private agentDir(uid: string, aid: string): string {
    return join(this.dir(uid), aid);
  }
  private personaFile(uid: string, aid: string): string {
    return join(this.agentDir(uid, aid), "persona.md");
  }
  private bindingFile(uid: string, aid: string): string {
    return join(this.agentDir(uid, aid), "binding.json");
  }

  private async loadIndex(uid: string): Promise<AgentIndexEntry[]> {
    const entries: AgentIndexEntry[] = [];
    for (const line of await this.deps.fileIO.readAll(this.indexFile(uid))) {
      try {
        const entry = JSON.parse(line) as AgentIndexEntry;
        if (typeof entry?.id === "string") entries.push(entry);
      } catch {
        // 崩溃半行
      }
    }
    return entries;
  }

  async list(uid: string): Promise<(AgentEntry & { binding: AgentBinding })[]> {
    return this.loadIndex(uid);
  }

  async create(uid: string, input: { persona: string; binding?: AgentBinding }): Promise<AgentEntry> {
    const id = this.deps.randomUUID();
    const entry: AgentIndexEntry = {
      id,
      name: extractAgentName(input.persona) || "助手",
      createdTs: this.deps.now(),
      binding: input.binding ?? { skills: [], mcps: [] },
    };
    await this.deps.fileIO.appendLine(this.indexFile(uid), JSON.stringify(entry));
    // 人设正文原样落盘（不走 JSONL 语义）
    const { mkdir, writeFile } = await import("node:fs/promises");
    const file = this.personaFile(uid, id);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, input.persona, "utf8");
    return { id: entry.id, name: entry.name, createdTs: entry.createdTs };
  }

  async persona(uid: string, aid: string): Promise<string> {
    // markdown 正文含空行，须原样读（FileIO.readAll 的 JSONL 语义会滤掉空行）
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(this.personaFile(uid, aid), "utf8");
    } catch {
      throw new Error(`agent "${aid}" 不存在`);
    }
  }

  async updatePersona(uid: string, aid: string, markdown: string): Promise<AgentEntry> {
    await this.persona(uid, aid); // 不存在则抛
    const { rename, writeFile } = await import("node:fs/promises");
    const file = this.personaFile(uid, aid);
    const tmp = file + ".tmp";
    await writeFile(tmp, markdown, "utf8");
    await rename(tmp, file);
    const name = extractAgentName(markdown) || "助手";
    const entries = await this.loadIndex(uid);
    const entry = entries.find((e) => e.id === aid)!;
    entry.name = name;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.dir(uid), { recursive: true });
    await writeFile(this.indexFile(uid), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return { id: aid, name, createdTs: entry.createdTs };
  }

  async updateBinding(uid: string, aid: string, binding: AgentBinding): Promise<void> {
    const entries = await this.loadIndex(uid);
    const entry = entries.find((e) => e.id === aid);
    if (!entry) throw new Error(`agent "${aid}" 不存在`);
    entry.binding = binding;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.indexFile(uid), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  async remove(uid: string, aid: string): Promise<void> {
    const entries = await this.loadIndex(uid);
    if (!entries.some((e) => e.id === aid)) throw new Error(`agent "${aid}" 不存在`);
    const kept = entries.filter((e) => e.id !== aid);
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(this.indexFile(uid), kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    await rm(this.agentDir(uid, aid), { recursive: true, force: true }).catch(() => undefined);
  }
}
