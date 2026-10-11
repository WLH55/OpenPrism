// 2026-10-12 工作台化一期（SDD 2026-10-11_23-42）：WidgetStore（今天页自定义卡片）+ 四工具契约。
// 卡片 kind 固定枚举（note|progress），payload 服务端校验全中文报错；uid 严格隔离。

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/harness/index";
import { WidgetStore, createWidgetTools, type ProgressPayload } from "../src/app/widgets";
import { testDb } from "./helpers-db";

const NOW = Date.UTC(2026, 9, 12, 4, 0, 0); // 2026-10-12 12:00 UTC+8
let seq = 0;

function fresh(uid = "u1") {
  const store = new WidgetStore(testDb(), { now: () => NOW, randomUUID: () => `w${(seq += 1)}` });
  const tools = createWidgetTools({ store, uid });
  return { store, tools, by: (name: string) => tools.find((t) => t.name === name)! };
}

const ctx = { signal: new AbortController().signal } as Parameters<ToolDefinition["execute"]>[1];

describe("WidgetStore", () => {
  it("create/list：note 与 progress 各建一张，按创建序（sort 递增）排列", () => {
    const { store } = fresh();
    const note = store.create("u1", { kind: "note", title: "本周聚焦", payload: { text: "搞定发票报销" } });
    const progress = store.create("u1", { kind: "progress", title: "《三体》阅读", payload: { value: 120, target: 300, unit: "页" } });
    const list = store.list("u1");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: note.id, kind: "note", title: "本周聚焦", payload: { text: "搞定发票报销" } });
    expect(list[1]).toMatchObject({ id: progress.id, kind: "progress", payload: { value: 120, target: 300, unit: "页" } });
    expect(list[1]!.sort).toBeGreaterThan(list[0]!.sort);
    expect(list[0]!.createdTs).toBe(NOW);
  });

  it("校验：kind 枚举 / title 空/超长 / note 文本空/超长 / progress 数值非法——全中文报错", () => {
    const { store } = fresh();
    expect(() => store.create("u1", { kind: "counter", title: "x", payload: {} })).toThrow("kind 必须是");
    expect(() => store.create("u1", { kind: "note", title: "  ", payload: { text: "x" } })).toThrow("title 必填");
    expect(() => store.create("u1", { kind: "note", title: "x", payload: { text: "y".repeat(2001) } })).toThrow("正文过长");
    expect(() => store.create("u1", { kind: "note", title: "x", payload: { text: "  " } })).toThrow("正文不能为空");
    expect(() => store.create("u1", { kind: "progress", title: "x", payload: { value: -1, target: 100 } })).toThrow("value");
    expect(() => store.create("u1", { kind: "progress", title: "x", payload: { value: 0, target: 0 } })).toThrow("target");
    expect(() => store.create("u1", { kind: "note", title: "x".repeat(201), payload: { text: "y" } })).toThrow("title 过长");
  });

  it("update：progress 只传 value 字段级合并（target/unit 保留）；title 可改；合并结果整体校验；非对象 payload / 非 string title 拒绝；空串清除单位", () => {
    const { store } = fresh();
    const card = store.create("u1", { kind: "progress", title: "读书", payload: { value: 120, target: 300, unit: "页" } });
    const updated = store.update("u1", card.id, { payload: { value: 150 } });
    expect(updated.payload as ProgressPayload).toEqual({ value: 150, target: 300, unit: "页" });
    const retitled = store.update("u1", card.id, { title: "《三体》阅读" });
    expect(retitled.title).toBe("《三体》阅读");
    expect(() => store.update("u1", card.id, { payload: { value: "abc" } })).toThrow("value");
    expect(() => store.update("u1", card.id, { payload: { target: -5 } })).toThrow("target");
    // 非对象 payload 先拒（展开合并会绕过校验静默 no-op——评审 2026-10-12）；null title 不再变字面量 "null"
    expect(() => store.update("u1", card.id, { payload: "abc" as never })).toThrow("payload 必须是对象");
    expect(() => store.update("u1", card.id, { payload: null as never })).toThrow("payload 必须是对象");
    expect(() => store.update("u1", card.id, { title: null as never })).toThrow("title 需为字符串");
    // 空串 = 清除单位（UI 的 ProgressEdit 保存时始终发 unit 键）
    const cleared = store.update("u1", card.id, { payload: { unit: "" } });
    expect(cleared.payload).toEqual({ value: 150, target: 300 });
  });

  it("uid 隔离：u2 列表见不到 u1 的卡；跨用户更新/删除按不存在拒绝", () => {
    const { store } = fresh();
    const card = store.create("u1", { kind: "note", title: "私卡", payload: { text: "x" } });
    expect(store.list("u2")).toHaveLength(0);
    expect(() => store.update("u2", card.id, { title: "偷改" })).toThrow("不存在");
    expect(() => store.remove("u2", card.id)).toThrow("不存在");
    expect(store.list("u1")).toHaveLength(1);
  });

  it("remove：删除后列表为空；再删按不存在拒绝", () => {
    const { store } = fresh();
    const card = store.create("u1", { kind: "note", title: "x", payload: { text: "y" } });
    store.remove("u1", card.id);
    expect(store.list("u1")).toHaveLength(0);
    expect(() => store.remove("u1", card.id)).toThrow("不存在");
  });
});

describe("widget 工具契约", () => {
  it("四工具名与并发标记：list_widgets 只读并发安全，其余写库不安全", () => {
    const { tools } = fresh();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_widget", "delete_widget", "list_widgets", "update_widget"]);
    expect(tools.find((t) => t.name === "list_widgets")!.isConcurrencySafe?.({})).toBe(true);
    expect(tools.filter((t) => t.name !== "list_widgets").every((t) => !t.isConcurrencySafe?.({}))).toBe(true);
  });

  it("create_widget：描述内嵌需求闸门（用途/数据来源/更新方式）；执行落库回执中文", async () => {
    const { by, store } = fresh();
    const tool = by("create_widget");
    expect(tool.description).toContain("用途");
    expect(tool.description).toContain("更新");
    const value = await tool.execute({ kind: "progress", title: "《三体》阅读", payload: { value: 120, target: 300, unit: "页" } }, ctx);
    expect(value).toMatchObject({ kind: "progress", title: "《三体》阅读" });
    expect(store.list("u1")).toHaveLength(1);
    expect(tool.output.render({}, value)[0]).toMatchObject({ type: "text", text: "已在「今天」页创建进度卡「《三体》阅读」" });
  });

  it("update_widget：推进度回执带当前值；id 必填中文报错", async () => {
    const { by, store } = fresh();
    const card = store.create("u1", { kind: "progress", title: "读书", payload: { value: 120, target: 300, unit: "页" } });
    const value = await by("update_widget").execute({ id: card.id, payload: { value: 150 } }, ctx);
    expect((value as { payload: ProgressPayload }).payload.value).toBe(150);
    expect(by("update_widget").output.render({}, value)[0]).toMatchObject({ type: "text", text: "已更新卡片「读书」（当前 150页/300）" });
    await expect(by("update_widget").execute({}, ctx)).rejects.toThrow("id 必填");
  });

  it("delete_widget / list_widgets：删后列表空回执；列表含 payload 概览", async () => {
    const { by, store } = fresh();
    const card = store.create("u1", { kind: "note", title: "聚焦", payload: { text: "发票" } });
    const empty = await by("list_widgets").execute({}, ctx);
    expect(by("list_widgets").output.render({}, empty)[0]).toMatchObject({ type: "text", text: "现有 1 张卡片：「聚焦」(note)" });
    await by("delete_widget").execute({ id: card.id }, ctx);
    const after = await by("list_widgets").execute({}, ctx);
    expect(by("list_widgets").output.render({}, after)[0]).toMatchObject({ type: "text", text: "「今天」页还没有自定义卡片" });
  });

  it("错误路径中文：非法 kind / 缺 payload 从工具侧拒绝", async () => {
    const { by } = fresh();
    await expect(by("create_widget").execute({ kind: "chart", title: "x", payload: {} }, ctx)).rejects.toThrow("kind 必须是");
    await expect(by("create_widget").execute({ kind: "note", title: "x" }, ctx)).rejects.toThrow("payload");
    await expect(by("delete_widget").execute({}, ctx)).rejects.toThrow("id 必填");
  });
});
