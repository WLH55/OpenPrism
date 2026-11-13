// 工具描述预算护栏（SDD 2026-11-13_09-54）：单条 ≤250 字符、仓库内工具面 description 合计 ≤2500 字符。
// 超限时不改测试数字——修描述本身（或经评审上调预算并回写 SDD）；MCP 外部工具不在此列。
// parameters schema 不设上限（功能契约，砍说明损害调用正确性），体积经 request/header.toolsChars 度量。

import { describe, expect, it } from "vitest";
import { allAppTools } from "./helpers-tools";

const PER_TOOL_LIMIT = 250;
const TOTAL_BUDGET = 2500;

describe("工具描述预算", () => {
  it("单条 description ≤ 250 字符，超限逐条列出", async () => {
    const tools = await allAppTools();
    const over = tools
      .filter((tool) => tool.description.length > PER_TOOL_LIMIT)
      .map((tool) => `${tool.name}(${tool.description.length})`);
    expect(over, `超限条目：${over.join("、")}`).toEqual([]);
  });

  it("description 合计 ≤ 2500 字符", async () => {
    const tools = await allAppTools();
    const total = tools.reduce((sum, tool) => sum + tool.description.length, 0);
    expect(total, `当前合计 ${total} 字符（${tools.length} 条）`).toBeLessThanOrEqual(TOTAL_BUDGET);
  });
});
