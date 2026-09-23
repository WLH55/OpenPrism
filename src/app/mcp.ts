// MCP 客户端（D4b.1，ADR 0008 领域表）：remote URL 型工具服务器，Streamable HTTP JSON-RPC 最小实现
// （POST + JSON/SSE 双响应解析 + Mcp-Session-Id 传递）。仅 remote 型——本地 command 型不做（公网禁令天然满足）。
// 安装 = 自带自装：URL + 可选头；信任边界 = 安装时连接测试一次，绑定即授权（运行中无逐次审批）。

import type { DatabaseSync } from "node:sqlite";
import type { PlatformEnv, ToolDefinition } from "../harness/index";

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

let nextRpcId = 1;

async function parseResponse(contentType: string | null, response: { json(): Promise<unknown>; body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null }): Promise<unknown> {
  if (contentType && contentType.includes("text/event-stream") && response.body) {
    // SSE 帧：取第一条 data: 行
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      const line = buffer.split("\n").find((l) => l.startsWith("data:"));
      if (line) return JSON.parse(line.slice(5).trim());
    }
    throw new Error("SSE 响应没有 data 帧");
  }
  return response.json();
}

export async function mcpCall(env: PlatformEnv, server: McpServerConfig, method: string, params?: unknown): Promise<unknown> {
  const envelope: JsonRpcEnvelope = { jsonrpc: "2.0", id: nextRpcId++, method, ...(params !== undefined ? { params } : {}) };
  const response = await env.fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(server.headers ?? {}),
    },
    body: JSON.stringify(envelope),
  });
  if (!response.ok) throw new Error(`MCP ${server.name}: HTTP ${response.status}`);
  const payload = (await parseResponse(response.headers.get("content-type"), response)) as { result?: unknown; error?: { message?: string } };
  if (payload?.error) throw new Error(`MCP ${server.name}: ${payload.error.message ?? "rpc error"}`);
  return payload?.result ?? {};
}

export interface McpRegistryDeps {
  env: PlatformEnv;
  db: DatabaseSync;
  now(): number;
  randomUUID(): string;
}

function wrapTool(env: PlatformEnv, server: McpServerConfig, tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? `来自 MCP「${server.name}」的工具`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    output: {
      schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
    },
    async execute(args) {
      const result = (await mcpCall(env, server, "tools/call", { name: tool.name, arguments: args ?? {} })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content ?? []).map((block) => block.text ?? "").join("\n") || JSON.stringify(result);
      if (result.isError) throw new Error(text);
      return { text };
    },
    isConcurrencySafe: () => false,
  };
}

export class McpRegistry {
  constructor(private deps: McpRegistryDeps) {}

  async list(uid: string): Promise<McpServerConfig[]> {
    const rows = this.deps.db
      .prepare("SELECT id, name, url, headers_json FROM mcps WHERE uid = ? ORDER BY created_ts, id")
      .all(uid) as unknown as { id: string; name: string; url: string; headers_json: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      ...(row.headers_json !== null ? { headers: JSON.parse(row.headers_json) as Record<string, string> } : {}),
    }));
  }

  async add(uid: string, input: { name: string; url: string; headers?: Record<string, string> }): Promise<McpServerConfig> {
    if (!/^https?:\/\//.test(input.url)) throw new Error("url 需以 http(s):// 开头（仅 remote 型 MCP）");
    // 安装时连接测试一次（信任边界：一次说清）
    const probe: McpServerConfig = { id: "probe", name: input.name, url: input.url, ...(input.headers ? { headers: input.headers } : {}) };
    await mcpCall(this.deps.env, probe, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "openprism", version: "0.1.0" },
    });
    const config: McpServerConfig = {
      id: this.deps.randomUUID(),
      name: input.name,
      url: input.url,
      ...(input.headers ? { headers: input.headers } : {}),
    };
    this.deps.db
      .prepare("INSERT INTO mcps (id, uid, name, url, headers_json, created_ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(config.id, uid, config.name, config.url, config.headers ? JSON.stringify(config.headers) : null, this.deps.now());
    return config;
  }

  async remove(uid: string, id: string): Promise<void> {
    const result = this.deps.db.prepare("DELETE FROM mcps WHERE id = ? AND uid = ?").run(id, uid);
    if (result.changes === 0) throw new Error(`mcp "${id}" 不存在`);
  }

  /** initialize + tools/list → 包装为 harness 工具（exclusive；名称用服务器原名，重名在注册时暴露） */
  async toolsFor(uid: string, id: string): Promise<ToolDefinition[]> {
    const config = (await this.list(uid)).find((c) => c.id === id);
    if (!config) throw new Error(`mcp "${id}" 不存在`);
    const result = (await mcpCall(this.deps.env, config, "tools/list")) as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    };
    return (result.tools ?? []).map((tool) => wrapTool(this.deps.env, config, tool));
  }
}
