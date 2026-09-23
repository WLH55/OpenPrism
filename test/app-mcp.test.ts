// 批次2·mcp：Streamable HTTP JSON-RPC 最小客户端——JSON 与 SSE 两种响应、注册表持久化、toolsFor 包装为 harness 工具。
// fake MCP 服务器 = 测试内真实 node:http（零外呼）。

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv } from "../src/app/env";
import { McpRegistry, mcpCall } from "../src/app/mcp";
import type { PlatformEnv } from "../src/harness/index";
import { testDb } from "./helpers-db";

let jsonServer: Server;
let jsonUrl: string;
let sseServer: Server;
let sseUrl: string;

beforeAll(async () => {
  // JSON 响应版 fake MCP
  jsonServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      let result: unknown;
      if (method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-json" } };
      else if (method === "tools/list")
        result = { tools: [{ name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
      else if (method === "tools/call")
        result = { content: [{ type: "text", text: " echoed" }], isError: false };
      else result = {};
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => jsonServer.listen(0, "127.0.0.1", r));
  jsonUrl = `http://127.0.0.1:${(jsonServer.address() as { port: number }).port}/mcp`;

  // SSE 响应版 fake MCP
  sseServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      const result = method === "tools/list" ? { tools: [] } : {};
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => sseServer.listen(0, "127.0.0.1", r));
  sseUrl = `http://127.0.0.1:${(sseServer.address() as { port: number }).port}/mcp`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => jsonServer.close(() => r())),
    new Promise<void>((r) => sseServer.close(() => r())),
  ]);
});

describe("mcpCall", () => {
  it("JSON 响应解析 result；错误响应抛错", async () => {
    const server = { id: "m1", name: "fake", url: jsonUrl };
    const result = (await mcpCall(nodeEnv, server, "initialize", {})) as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe("fake-json");
    await expect(mcpCall(nodeEnv, { id: "m1", name: "fake", url: "http://127.0.0.1:1/mcp" }, "initialize")).rejects.toThrow();
  });

  it("SSE 响应解析 data 帧里的 result", async () => {
    const server = { id: "m2", name: "fake-sse", url: sseUrl };
    const result = (await mcpCall(nodeEnv, server, "tools/list")) as { tools: unknown[] };
    expect(result.tools).toEqual([]);
  });
});

describe("McpRegistry", () => {
  it("add/list/remove 持久化；toolsFor 包装为 exclusive 工具且 execute 走 tools/call", async () => {
    const registry = new McpRegistry({ env: nodeEnv, db: testDb(), now: () => 1, randomUUID: () => "mc-1" });
    const added = await registry.add("u1", { name: "回声服务", url: jsonUrl });
    expect(added.name).toBe("回声服务");
    expect((await registry.list("u1")).map((m) => m.id)).toEqual(["mc-1"]);

    const tools = await registry.toolsFor("u1", "mc-1");
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    const echo = tools[0]!;
    expect(echo.isConcurrencySafe?.({})).toBeFalsy();
    const ctx = { signal: new AbortController().signal, env: nodeEnv as PlatformEnv };
    const value = (await echo.execute({ text: "hi" }, ctx)) as { text: string };
    expect(value.text).toContain("echoed");

    await registry.remove("u1", "mc-1");
    expect(await registry.list("u1")).toHaveLength(0);
    await expect(registry.toolsFor("u1", "mc-1")).rejects.toThrow();
  });
});
