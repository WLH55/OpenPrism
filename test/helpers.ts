// 测试公共件：零网络假 env、延迟工具、简单工具定义。

import type { PlatformEnv } from "../src/harness/env";
import type { ToolDefinition, ToolRunContext } from "../src/harness/tools/registry";

export function fakeEnv(): PlatformEnv {
  let n = 0;
  return {
    fetch: async () => {
      throw new Error("tests: no network");
    },
    now: () => 12345,
    randomUUID: () => `uuid-${++n}`,
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const echoTool: ToolDefinition = {
  name: "echo",
  description: "回声：原样返回 text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output: {
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }],
  },
  execute: async (args) => ({ text: String((args as { text?: string })?.text ?? "") }),
  isConcurrencySafe: () => true,
};

export function textTool(
  name: string,
  run: (args: unknown, ctx: ToolRunContext) => Promise<unknown>,
  extra?: Partial<ToolDefinition>,
): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: run,
    isConcurrencySafe: () => true,
    ...extra,
  };
}
