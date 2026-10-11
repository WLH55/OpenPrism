// 今天页自定义卡片（2026-10-12，工作台化一期，SDD 2026-10-11_23-42）：
// 「让 Agent 造面板」的最小形态——Agent/用户创建的配置驱动小卡，挂「今天」页驾驶舱。
// kind 固定枚举（note 便签 | progress 进度），payload 服务端校验，前端按 kind 分发渲染，
// 不做任意 HTML/代码渲染（安全边界）；排序按创建序（sort 追加递增），拖拽后置。
// 需求闸门（借 dsh workbench-standard）：create_widget 描述要求先确认用途/数据来源/更新方式再创建。

import type { DatabaseSync } from "node:sqlite";
import type { ToolDefinition } from "../harness/index";

export type WidgetKind = "note" | "progress";

export interface NotePayload {
  text: string;
}

export interface ProgressPayload {
  value: number;
  target: number;
  unit?: string;
}

export type WidgetPayload = NotePayload | ProgressPayload;

export interface Widget {
  id: string;
  kind: WidgetKind;
  title: string;
  payload: WidgetPayload;
  sort: number;
  createdTs: number;
}

const TITLE_MAX = 200;
const TEXT_MAX = 2000;
const UNIT_MAX = 20;
const WIDGET_KINDS: readonly WidgetKind[] = ["note", "progress"];

interface WidgetRow {
  id: string;
  kind: string;
  title: string;
  payload_json: string;
  sort: number;
  created_ts: number;
}

export interface WidgetStoreDeps {
  now(): number;
  randomUUID(): string;
}

/** 校验并归一 payload（update 时与现值合并后整体校验） */
function validatePayload(kind: WidgetKind, payload: unknown): WidgetPayload {
  if (typeof payload !== "object" || payload === null) throw new Error("payload 必须是对象");
  const input = payload as Record<string, unknown>;
  if (kind === "note") {
    if (typeof input.text !== "string") throw new Error("note 卡的 payload 需要正文字段 text");
    const text = input.text.trim();
    if (text === "") throw new Error("note 卡正文不能为空");
    if (text.length > TEXT_MAX) throw new Error(`note 卡正文过长（≤${TEXT_MAX} 字）`);
    return { text };
  }
  // progress：value ≥ 0（允许超额，进度条前端封顶显示）；target > 0
  const value = Number(input.value);
  const target = Number(input.target);
  if (!Number.isFinite(value) || value < 0) throw new Error("progress 卡的 value 需为 ≥0 的数字");
  if (!Number.isFinite(target) || target <= 0) throw new Error("progress 卡的 target 需为 >0 的数字");
  if (input.unit !== undefined && typeof input.unit !== "string") throw new Error("progress 卡的 unit 需为字符串（空串 = 清除单位）");
  const unit = input.unit === undefined ? undefined : String(input.unit).trim();
  if (unit !== undefined && unit.length > UNIT_MAX) throw new Error(`progress 卡单位过长（≤${UNIT_MAX} 字）`);
  return { value, target, ...(unit !== undefined && unit !== "" ? { unit } : {}) };
}

function rowToWidget(row: WidgetRow): Widget {
  let payload: WidgetPayload;
  try {
    payload = JSON.parse(row.payload_json) as WidgetPayload;
  } catch {
    payload = row.kind === "note" ? { text: "" } : { value: 0, target: 1 };
  }
  return { id: row.id, kind: row.kind as WidgetKind, title: row.title, payload, sort: row.sort, createdTs: row.created_ts };
}

const SELECT_COLUMNS = "id, kind, title, payload_json, sort, created_ts";

export class WidgetStore {
  constructor(private db: DatabaseSync, private deps: WidgetStoreDeps) {}

  list(uid: string): Widget[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM widgets WHERE uid = ? ORDER BY sort, created_ts, id`)
      .all(uid) as unknown as WidgetRow[];
    return rows.map(rowToWidget);
  }

  create(uid: string, input: { kind: string; title: string; payload: unknown }): Widget {
    const kind = WIDGET_KINDS.find((k) => k === input.kind);
    if (!kind) throw new Error(`kind 必须是 ${WIDGET_KINDS.join(" | ")}`);
    const title = String(input.title ?? "").trim();
    if (title === "") throw new Error("title 必填");
    if (title.length > TITLE_MAX) throw new Error(`title 过长（≤${TITLE_MAX} 字）`);
    const payload = validatePayload(kind, input.payload);
    const maxSort = (this.db.prepare("SELECT MAX(sort) AS m FROM widgets WHERE uid = ?").get(uid) as { m: number | null }).m ?? 0;
    // 全长 UUID：8 位截断的碰撞面只 32 bit，主键冲突会以英文 UNIQUE 报错从工具/REST 露出
    const widget: Widget = { id: `wid-${this.deps.randomUUID()}`, kind, title, payload, sort: maxSort + 1, createdTs: this.deps.now() };
    this.db
      .prepare("INSERT INTO widgets (id, uid, kind, title, payload_json, sort, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(widget.id, uid, kind, title, JSON.stringify(payload), widget.sort, widget.createdTs);
    return widget;
  }

  /** 部分更新：title 与 payload 字段级合并（progress 可只改 value），合并结果整体校验 */
  update(uid: string, id: string, patch: { title?: string; payload?: unknown }): Widget {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM widgets WHERE id = ? AND uid = ?`).get(id, uid) as unknown as WidgetRow | undefined;
    if (!row) throw new Error(`卡片 "${id}" 不存在`);
    const current = rowToWidget(row);
    let title = current.title;
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string") throw new Error("title 需为字符串");
      title = patch.title.trim();
      if (title === "") throw new Error("title 不能为空");
      if (title.length > TITLE_MAX) throw new Error(`title 过长（≤${TITLE_MAX} 字）`);
    }
    let payload = current.payload;
    if (patch.payload !== undefined) {
      // 非对象（字符串/数字/null）先拒：展开合并会绕过 payload 校验静默 no-op（评审 2026-10-12）
      if (typeof patch.payload !== "object" || patch.payload === null) throw new Error("payload 必须是对象");
      const raw = patch.payload as Record<string, unknown>;
      payload = validatePayload(
        current.kind,
        current.kind === "note"
          ? { ...current.payload, ...raw }
          : { ...(current.payload as ProgressPayload), ...raw },
      );
    }
    this.db.prepare("UPDATE widgets SET title = ?, payload_json = ? WHERE id = ? AND uid = ?").run(title, JSON.stringify(payload), id, uid);
    return { ...current, title, payload };
  }

  remove(uid: string, id: string): void {
    const result = this.db.prepare("DELETE FROM widgets WHERE id = ? AND uid = ?").run(id, uid);
    if (result.changes === 0) throw new Error(`卡片 "${id}" 不存在`);
  }
}

export interface WidgetToolsDeps {
  store: WidgetStore;
  uid: string;
}

export function createWidgetTools(deps: WidgetToolsDeps): ToolDefinition[] {
  const { store, uid } = deps;

  const createWidget: ToolDefinition = {
    name: "create_widget",
    description:
      "在用户的「今天」页驾驶舱创建一张自定义卡片（note 便签 = 标题+正文；progress 进度 = 标题+当前值/目标值）。创建前必须先向用户确认三件事：这张卡的用途、数据从哪来、以后怎么更新——说不清就先问，不要自行编造目标值或进度。卡片是驾驶舱不是便签墙，用户明确要才建。",
    parameters: {
      type: "object",
      required: ["kind", "title", "payload"],
      properties: {
        kind: { type: "string", description: "note | progress" },
        title: { type: "string", description: "卡片标题（如「《三体》阅读进度」）" },
        payload: {
          type: "object",
          description: "note: {text}；progress: {value, target, unit?}（value=当前值，target=目标值，unit=单位如 页/章）",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["id", "kind", "title"],
        properties: { id: { type: "string" }, kind: { type: "string" }, title: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { kind: string; title: string };
        return [{ type: "text", text: `已在「今天」页创建${v.kind === "progress" ? "进度卡" : "便签卡"}「${v.title}」` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { kind?: string; title?: string; payload?: unknown };
      const widget = store.create(uid, { kind: String(input.kind ?? ""), title: String(input.title ?? ""), payload: input.payload });
      return { id: widget.id, kind: widget.kind, title: widget.title };
    },
    isConcurrencySafe: () => false,
  };

  const updateWidget: ToolDefinition = {
    name: "update_widget",
    description:
      "更新「今天」页的自定义卡片：progress 卡推进度（payload 只传要改的字段，如 {value: 150}）、note 卡改正文，也可改标题。id 在创建回执或 list_widgets 里。",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        payload: { type: "object", description: "部分更新：progress 传 {value?, target?, unit?}，note 传 {text}" },
      },
    },
    output: {
      schema: {
        type: "object",
        required: ["id", "title"],
        properties: { id: { type: "string" }, title: { type: "string" }, payload: { type: "object" } },
      },
      render: (_args, value) => {
        const v = value as { title: string; payload?: { value?: number; target?: number; unit?: string } };
        const progress = v.payload?.value !== undefined ? `（当前 ${v.payload.value}${v.payload.unit ?? ""}/${v.payload.target ?? "?"}）` : "";
        return [{ type: "text", text: `已更新卡片「${v.title}」${progress}` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { id?: string; title?: string; payload?: unknown };
      if (input.id === undefined || String(input.id).trim() === "") throw new Error("id 必填");
      const widget = store.update(uid, String(input.id), {
        ...(input.title !== undefined ? { title: String(input.title) } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      });
      return { id: widget.id, title: widget.title, payload: widget.payload };
    },
    isConcurrencySafe: () => false,
  };

  const deleteWidget: ToolDefinition = {
    name: "delete_widget",
    description: "删除「今天」页的自定义卡片。删前告知用户删的是哪张；id 在 list_widgets 里。",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    output: {
      schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      render: (_args, value) => {
        const v = value as { id: string };
        return [{ type: "text", text: `已删除卡片 ${v.id}` }];
      },
    },
    async execute(args) {
      const input = (args ?? {}) as { id?: string };
      if (input.id === undefined || String(input.id).trim() === "") throw new Error("id 必填");
      store.remove(uid, String(input.id));
      return { id: String(input.id) };
    },
    isConcurrencySafe: () => false,
  };

  const listWidgets: ToolDefinition = {
    name: "list_widgets",
    description: "列出「今天」页现有的自定义卡片（标题/类型/当前值）。建卡前先看一眼避免重复建。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        required: ["widgets"],
        properties: { widgets: { type: "array", items: { type: "object" } } },
      },
      render: (_args, value) => {
        const list = (value as { widgets: { id: string; kind: string; title: string }[] }).widgets;
        if (list.length === 0) return [{ type: "text", text: "「今天」页还没有自定义卡片" }];
        return [{ type: "text", text: `现有 ${list.length} 张卡片：${list.map((w) => `「${w.title}」(${w.kind})`).join("、")}` }];
      },
    },
    async execute() {
      return { widgets: store.list(uid).map((w) => ({ id: w.id, kind: w.kind, title: w.title, payload: w.payload })) };
    },
    isConcurrencySafe: () => true,
  };

  return [createWidget, updateWidget, deleteWidget, listWidgets];
}
