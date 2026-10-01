// 遗留清理（2026-10-01，schema v2）：model_config 老库吸收 + 七张遗留表 DROP。
// JSONL 一次性导入器已随遗留数据文件删除，其 fixture 测试随之移除。

import { describe, expect, it } from "vitest";
import { testDb } from "./helpers-db";
import { dropLegacyTables } from "../src/app/db";
import { migrateLegacyModelConfig } from "../src/app/migrate";
import { migrateLegacyMemory } from "../src/app/memory-extract";

const LEGACY_TABLES = ["l1_entities", "l1_changes", "l2_entries", "l2_meta", "l3_meta", "memory_slots", "model_config"] as const;

/** 模拟 schema v1 老库的七张遗留表（列结构与被删的旧 DDL 一致） */
function createLegacyTables(db: ReturnType<typeof testDb>): void {
  db.exec(`
    CREATE TABLE memory_slots (uid TEXT NOT NULL, slot TEXT NOT NULL, content_md TEXT NOT NULL DEFAULT '', updated_ts INTEGER, PRIMARY KEY (uid, slot));
    CREATE TABLE l1_entities (uid TEXT NOT NULL, surface TEXT NOT NULL, ref TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL DEFAULT 0, fingerprint TEXT NOT NULL DEFAULT '', PRIMARY KEY (uid, surface, ref));
    CREATE TABLE l1_changes (uid TEXT NOT NULL, surface TEXT NOT NULL, id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL);
    CREATE TABLE l2_entries (uid TEXT NOT NULL, surface TEXT NOT NULL, id TEXT NOT NULL, section TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '[]', created_ts INTEGER NOT NULL, updated_ts INTEGER, PRIMARY KEY (uid, surface, id));
    CREATE TABLE l2_meta (uid TEXT NOT NULL, surface TEXT NOT NULL, seen_refs_json TEXT NOT NULL DEFAULT '[]', last_update_ts INTEGER, PRIMARY KEY (uid, surface));
    CREATE TABLE l3_meta (uid TEXT NOT NULL, slot TEXT NOT NULL, seen_json TEXT NOT NULL DEFAULT '[]', last_update_ts INTEGER, PRIMARY KEY (uid, slot));
    CREATE TABLE model_config (uid TEXT PRIMARY KEY, base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', key_enc TEXT);
  `);
}

function tableNames(db: ReturnType<typeof testDb>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map((r) => r.name);
}

describe("migrateLegacyModelConfig", () => {
  it("老库 model_config → model_providers + 激活；providers 非空跳过（幂等）", () => {
    const db = testDb();
    createLegacyTables(db);
    db.prepare("INSERT INTO model_config (uid, base_url, model, key_enc) VALUES ('u-1', 'https://api.x.com', 'm-1', 'enc')").run();

    migrateLegacyModelConfig(db);
    const provider = db.prepare("SELECT uid, platform, base_url, model, key_enc FROM model_providers").get() as unknown as {
      uid: string;
      platform: string;
      base_url: string;
      model: string;
      key_enc: string;
    };
    expect(provider).toMatchObject({ uid: "u-1", base_url: "https://api.x.com", model: "m-1", key_enc: "enc" });
    const active = db.prepare("SELECT provider_id FROM model_active WHERE uid = 'u-1'").get() as unknown as { provider_id: string };
    expect(active.provider_id).toBeTruthy();

    migrateLegacyModelConfig(db); // providers 非空即跳过
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as unknown as { n: number }).n).toBe(1);
  });

  it("空配置不迁；表不存在（新库/已删表）直接返回不抛", () => {
    const db = testDb();
    expect(() => migrateLegacyModelConfig(db)).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as unknown as { n: number }).n).toBe(0);
  });
});

describe("dropLegacyTables", () => {
  it("七表全删、幂等、活表不受影响", () => {
    const db = testDb();
    createLegacyTables(db);
    dropLegacyTables(db);
    const names = tableNames(db);
    for (const legacy of LEGACY_TABLES) expect(names).not.toContain(legacy);
    for (const live of ["users", "memory_items", "memory_meta", "model_providers", "ledger_entries"]) expect(names).toContain(live);
    expect(() => dropLegacyTables(db)).not.toThrow(); // 二次调用幂等
  });
});

describe("老库升级链（main.ts 同序：吸收 → 删表）", () => {
  it("l2/slots/model_config 数据落新表后删旧表；删表后二次启动迁移函数不抛", () => {
    const db = testDb();
    createLegacyTables(db);
    db.prepare("INSERT INTO model_config (uid, base_url, model, key_enc) VALUES ('u-1', 'https://api.x.com', 'm-1', 'enc')").run();
    db.prepare("INSERT INTO l2_entries (uid, surface, id, section, text, refs_json, created_ts) VALUES ('u-1', 'chat', 'old1', '话题', '用户在测试旧链', '[\"chat:c1\"]', 100)").run();
    db.prepare("INSERT INTO memory_slots (uid, slot, content_md, updated_ts) VALUES ('u-1', 'profile', '旧画像工程师', 200)").run();

    migrateLegacyModelConfig(db);
    migrateLegacyMemory(db, { now: () => 1000, randomUUID: () => "r1" });
    dropLegacyTables(db);

    expect((db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as unknown as { n: number }).n).toBe(1);
    const fact = db.prepare("SELECT content, source_ref FROM memory_items WHERE uid = 'u-1' AND kind = 'fact'").get() as unknown as { content: string; source_ref: string };
    expect(fact).toMatchObject({ content: "用户在测试旧链", source_ref: "chat:c1" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE uid = 'u-1' AND kind = 'profile'").get() as unknown as { n: number }).n).toBe(1);

    // 二次启动（表已删）：两个迁移函数都走防御分支，不抛不重复
    expect(() => {
      migrateLegacyModelConfig(db);
      migrateLegacyMemory(db, { now: () => 2000, randomUUID: () => "r2" });
    }).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE uid = 'u-1'").get() as unknown as { n: number }).n).toBe(2);
  });
});
