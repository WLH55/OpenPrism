// ToolDefinition 契约 + 注册表（设计 §6.1）。
// 工具体返回 canonical JSON value（非文本块）——registry 负责 schema 校验与 render，
// UI 呈现与模型输入分离。timeoutMs 自声明、绝不发给模型。

import type { PlatformEnv } from "../env";
import type { ToolPublicSchema } from "../llm/adapter";
import type { ContentBlock, JsonSchema } from "../types";
import { fnv1a } from "../util";

export interface ToolRunContext {
  signal: AbortSignal;
  env: PlatformEnv;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** 发给模型的参数 schema */
  parameters: JsonSchema;
  output: {
    /** execute 返回值的契约 */
    schema: JsonSchema;
    /** 把 canonical value 渲染为内容块（模型输入与 UI 呈现共用） */
    render(args: unknown, value: unknown): ContentBlock[];
  };
  /** 返回 canonical JSON value */
  execute(args: unknown, ctx: ToolRunContext): Promise<unknown>;
  timeoutMs?: number;
  /** 未声明/抛错/非 true 一律 exclusive（fail-closed） */
  isConcurrencySafe?(args: unknown): boolean;
  /** 工具可主动结束 Turn（dsh 同款）：本 step 工具全部提交后不再发下一条模型请求 */
  concludeTurn?(): boolean;
}

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.defs.has(def.name)) {
      throw new Error(`tool "${def.name}" already registered`);
    }
    this.defs.set(def.name, def);
  }

  unregister(name: string): boolean {
    return this.defs.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.defs.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  publicSchemas(): ToolPublicSchema[] {
    return this.list().map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }));
  }

  /** 工具表指纹（request/header 用）：内容或顺序变更即变 */
  fingerprint(): string {
    const parts = this.list().map((def) => JSON.stringify([def.name, def.description, def.parameters]));
    return fnv1a(parts.join("\n"));
  }
}
