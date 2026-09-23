// JSON Schema 子集校验器：type / enum / required / properties / items。
// 用途是工具输出契约检查（设计 §6.1），不是全量 JSON Schema 实现。

import type { JsonSchema } from "../types";

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema, path = "$"): string | null {
  const expected = typeof schema.type === "string" ? schema.type : null;
  const actual = jsonTypeOf(value);
  if (expected && expected !== "any") {
    const matches =
      expected === "integer"
        ? actual === "number" && Number.isInteger(value)
        : expected === actual;
    if (!matches) return `${path}: expected ${expected}, got ${actual}`;
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((candidate) => candidate === value)) {
    return `${path}: value not in enum`;
  }
  if (actual === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in record)) return `${path}: missing required property "${key}"`;
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in record) {
        const error = validateAgainstJsonSchema(record[key], subSchema, `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  if (actual === "array" && schema.items && typeof schema.items === "object") {
    const itemsSchema = schema.items as JsonSchema;
    const items = value as unknown[];
    for (let i = 0; i < items.length; i++) {
      const error = validateAgainstJsonSchema(items[i], itemsSchema, `${path}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}
