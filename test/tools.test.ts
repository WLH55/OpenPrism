// H4·tools 层：契约校验、注册表指纹、七路 isError 归一化、超时、并发池、顺序、concludeTurn。

import { describe, expect, it } from "vitest";
import { runToolCalls, type RunToolCallsDeps, type ToolRunOutcome } from "../src/harness/tools/pipeline";
import { ToolRegistry, type ToolDefinition } from "../src/harness/tools/registry";
import { validateAgainstJsonSchema } from "../src/harness/tools/schema";
import { fakeEnv, sleep, textTool } from "./helpers";

function setup(defs: ToolDefinition[] = []) {
  const registry = new ToolRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

function call(id: string, name: string, args: unknown = {}) {
  return { type: "tool_call" as const, id, name, arguments: args };
}

async function run(calls: ReturnType<typeof call>[], registry: ToolRegistry, deps?: Partial<RunToolCallsDeps>) {
  const order: string[] = [];
  const outcomes: ToolRunOutcome[] = [];
  const controller = new AbortController();
  const result = await runToolCalls(calls, {
    registry,
    env: fakeEnv(),
    signal: controller.signal,
    onToolCall: async (c) => {
      order.push(`call:${c.id}`);
    },
    onToolResult: async (outcome) => {
      outcomes.push(outcome);
      order.push(`result:${outcome.id}`);
    },
    ...deps,
  });
  return { ...result, order, outcomes, controller };
}

describe("schema 校验器", () => {
  it("type/required/嵌套/enum/integer", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer" } },
      required: ["name"],
    };
    expect(validateAgainstJsonSchema({ name: "a", count: 3 }, schema)).toBeNull();
    expect(validateAgainstJsonSchema({ count: 3.5 }, schema)).toMatch(/name/);
    expect(validateAgainstJsonSchema({ name: "a", count: 3.5 }, schema)).toMatch(/integer/);
    expect(validateAgainstJsonSchema("str", schema)).toMatch(/\$: expected object/);
    expect(validateAgainstJsonSchema("a", { type: "string", enum: ["a", "b"] })).toBeNull();
    expect(validateAgainstJsonSchema("c", { type: "string", enum: ["a", "b"] })).toMatch(/enum/);
  });
});

describe("注册表", () => {
  it("重名注册抛错；指纹稳定且随描述变化", () => {
    const registry = setup([]);
    const def = textTool("echo", async () => ({ ok: true }));
    registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/);
    const before = registry.fingerprint();
    expect(registry.fingerprint()).toBe(before);
    registry.unregister("echo");
    registry.register(textTool("echo", async () => ({ ok: true }), { description: "变了" }));
    expect(registry.fingerprint()).not.toBe(before);
  });
});

describe("执行管线：isError 七路归一化", () => {
  it("正常路径：canonical value → schema 校验 → render 落内容块；tool/call 先于执行", async () => {
    const order: string[] = [];
    const registry = setup([
      textTool("ok", async () => {
        order.push("exec");
        return { ok: true };
      }),
    ]);
    const { order: pipelineOrder, outcomes } = await run([call("c1", "ok")], registry);
    expect(order).toEqual(["exec"]);
    expect(pipelineOrder).toEqual(["call:c1", "result:c1"]); // 先落日志再执行 → 回调序
    expect(outcomes[0]!.isError).toBe(false);
    expect(outcomes[0]!.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });

  it("① 工具体抛错 → TOOL_ERROR", async () => {
    const registry = setup([textTool("boom", async () => { throw new Error("炸了"); })]);
    const { outcomes } = await run([call("c1", "boom")], registry);
    expect(outcomes[0]).toMatchObject({ isError: true, code: "TOOL_ERROR" });
    expect((outcomes[0]!.content[0] as { text: string }).text).toBe("Error: 炸了");
  });

  it("② 输出违约 → TOOL_OUTPUT_INVALID", async () => {
    const registry = setup([textTool("bad", async () => 42)]); // 契约要求 object
    const { outcomes } = await run([call("c1", "bad")], registry);
    expect(outcomes[0]).toMatchObject({ isError: true, code: "TOOL_OUTPUT_INVALID" });
  });

  it("③ 快照失败（render 抛错）→ TOOL_RENDER_FAILED", async () => {
    const def = textTool("renderfail", async () => ({ ok: true }));
    def.output.render = () => { throw new Error("render 炸了"); };
    const registry = setup([def]);
    const { outcomes } = await run([call("c1", "renderfail")], registry);
    expect(outcomes[0]).toMatchObject({ isError: true, code: "TOOL_RENDER_FAILED" });
  });

  it("④ 超时 → TOOL_TIMEOUT，消息含毫秒数", async () => {
    const registry = setup([textTool("slow", async () => { await sleep(120); return { ok: true }; }, { timeoutMs: 20 })]);
    const { outcomes } = await run([call("c1", "slow")], registry);
    expect(outcomes[0]).toMatchObject({ isError: true, code: "TOOL_TIMEOUT" });
    expect((outcomes[0]!.content[0] as { text: string }).text).toBe("Error: tool call timed out after 20ms");
  });

  it("⑤ 取消前（派发前信号已中止）→ ABORTED_BEFORE_DISPATCH，工具体不执行", async () => {
    let executed = false;
    const registry = setup([textTool("never", async () => { executed = true; return { ok: true }; })]);
    const controller = new AbortController();
    controller.abort();
    const outcomes: ToolRunOutcome[] = [];
    await runToolCalls([call("c1", "never")], {
      registry,
      env: fakeEnv(),
      signal: controller.signal,
      onToolResult: async (outcome) => { outcomes.push(outcome); },
    });
    expect(executed).toBe(false);
    expect(outcomes[0]).toMatchObject({ isError: true, code: "ABORTED_BEFORE_DISPATCH" });
  });

  it("⑥ 取消后（执行中信号中止）→ ABORTED", async () => {
    const registry = setup([
      textTool("hanging", (args, ctx) => new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("AbortError")));
      })),
    ]);
    const controller = new AbortController();
    const promise = runToolCalls([call("c1", "hanging")], {
      registry,
      env: fakeEnv(),
      signal: controller.signal,
    });
    await sleep(10);
    controller.abort();
    const { outcomes } = await promise;
    expect(outcomes[0]).toMatchObject({ isError: true, code: "ABORTED" });
  });

  it("⑦ 管线自身抛错（onToolCall 钩子失败）→ TOOL_PIPELINE_ERROR", async () => {
    const registry = setup([textTool("ok", async () => ({ ok: true }))]);
    const { outcomes } = await run([call("c1", "ok")], registry, {
      onToolCall: async () => { throw new Error("钩子炸了"); },
    });
    expect(outcomes[0]).toMatchObject({ isError: true, code: "TOOL_PIPELINE_ERROR" });
  });

  it("未知工具 → TOOL_NOT_FOUND（模型幻觉名字也收到合法结果）", async () => {
    const registry = setup([]);
    const { outcomes } = await run([call("c1", "不存在")], registry);
    expect(outcomes[0]).toMatchObject({ isError: true, code: "TOOL_NOT_FOUND" });
  });
});

describe("执行管线：并发调度", () => {
  function trackingTool(name: string, ms: number, safe: boolean) {
    const spans: { name: string; start: number; end: number }[] = [];
    const def = textTool(name, async () => {
      const start = Date.now();
      await sleep(ms);
      spans.push({ name, start, end: Date.now() });
      return { ok: true };
    });
    if (!safe) def.isConcurrencySafe = () => false;
    return { def, spans };
  }

  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && b.start < a.end;

  it("parallel 组并发执行；结果按模型给定顺序提交（完成顺序不同）", async () => {
    const slow = trackingTool("slow", 60, true);
    const fast = trackingTool("fast", 5, true);
    const registry = setup([slow.def, fast.def]);
    const { outcomes } = await run([call("c1", "slow"), call("c2", "fast")], registry);
    expect(overlaps(slow.spans[0]!, fast.spans[0]!)).toBe(true); // 真并发
    expect(outcomes.map((outcome) => outcome.id)).toEqual(["c1", "c2"]); // 模型顺序
    expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
  });

  it("exclusive 单独成组即屏障：不安全工具串行", async () => {
    const a = trackingTool("a", 40, false);
    const b = trackingTool("b", 40, false);
    const registry = setup([a.def, b.def]);
    await run([call("c1", "a"), call("c2", "b")], registry);
    expect(overlaps(a.spans[0]!, b.spans[0]!)).toBe(false);
  });

  it("fail-closed：isConcurrencySafe 抛错/非 true 一律 exclusive", async () => {
    const throwing = textTool("throwing", async () => ({ ok: true }));
    throwing.isConcurrencySafe = () => { throw new Error("炸"); };
    const falsy = textTool("falsy", async () => ({ ok: true }));
    falsy.isConcurrencySafe = () => false;
    const a = trackingTool("x", 40, false);
    const registry = setup([throwing, falsy, a.def]);
    const { outcomes } = await run([call("c1", "throwing"), call("c2", "falsy"), call("c3", "x")], registry);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
  });

  it("有界滚动池：maxParallelToolCalls=2 时峰值并发 ≤ 2 且组内全部完成", async () => {
    let active = 0;
    let peak = 0;
    const defs = Array.from({ length: 6 }, (_, i) =>
      textTool(`t${i}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(25);
        active -= 1;
        return { ok: true };
      }),
    );
    const registry = setup(defs);
    const calls = defs.map((def, i) => call(`c${i}`, def.name));
    const { outcomes } = await run(calls, registry, { maxParallelToolCalls: 2 });
    expect(peak).toBe(2);
    expect(outcomes).toHaveLength(6);
    expect(outcomes.map((outcome) => outcome.id)).toEqual(calls.map((c) => c.id));
  });

  it("concludeTurn：工具可主动结束 Turn，但本 step 全部工具照常提交", async () => {
    const concluding = textTool("finisher", async () => ({ ok: true }), { concludeTurn: () => true });
    const after = textTool("after", async () => ({ ok: true }));
    const registry = setup([concluding, after]);
    const { outcomes, concludeTurn } = await run([call("c1", "finisher"), call("c2", "after")], registry);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
    expect(concludeTurn).toBe(true);
  });
});
