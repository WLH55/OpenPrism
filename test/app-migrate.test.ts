// ADR 0008·迁移器：旧 JSONL/markdown 数据一次性导入 SQLite（幂等标记；旧文件不删）。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateLegacy, migrateLegacyModelConfig } from "../src/app/migrate";
import { testDb } from "./helpers-db";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-migrate-"));

  await writeFile(join(root, "users.jsonl"), JSON.stringify({ uid: "u-1", username: "lathan", password: { salt: "aa", hash: "bb" }, createdTs: 1000 }) + "\n", "utf8");
  await writeFile(
    join(root, "sessions.jsonl"),
    [
      JSON.stringify({ op: "issue", token: "t-live", uid: "u-1", expiresAt: Date.now() + 86400000 }),
      JSON.stringify({ op: "issue", token: "t-gone", uid: "u-1", expiresAt: Date.now() + 86400000 }),
      JSON.stringify({ op: "revoke", token: "t-gone" }),
      JSON.stringify({ op: "issue", token: "t-expired", uid: "u-1", expiresAt: Date.now() - 1000 }),
    ].join("\n") + "\n",
    "utf8",
  );

  const userDir = join(root, "users", "u-1");
  await mkdir(join(userDir, "conversations", "c-1"), { recursive: true });
  await mkdir(join(userDir, "tasks", "t-1"), { recursive: true });
  await mkdir(join(userDir, "agents", "aid-1"), { recursive: true });
  await mkdir(join(userDir, "skills", "sk-1"), { recursive: true });
  await mkdir(join(userDir, "memory"), { recursive: true });

  await writeFile(join(userDir, "life.jsonl"), [
    JSON.stringify({ kind: "event", seq: 0, ts: 100, source: "ui", time: 100, category: "餐饮", value: 28 }),
    JSON.stringify({ kind: "void", seq: 1, ts: 200, source: "ui", targetSeq: 0, reason: "记错" }),
    "{broken",
  ].join("\n") + "\n", "utf8");

  await writeFile(join(userDir, "conversations", "index.jsonl"), JSON.stringify({ id: "c-1", title: "测试", createdTs: 300 }) + "\n", "utf8");
  await writeFile(join(userDir, "conversations", "c-1", "meta.json"), JSON.stringify({ agentId: "aid-1", switches: [{ ts: 1, agentId: "aid-1" }] }), "utf8");
  await writeFile(join(userDir, "conversations", "c-1", "session.jsonl"), [
    JSON.stringify({ type: "turn/start", turn: 1, seq: 0, ts: 400 }),
    JSON.stringify({ type: "user/message", channel: "followup", message: { role: "user", content: [{ type: "text", text: "你好" }] }, seq: 1, ts: 401 }),
  ].join("\n") + "\n", "utf8");

  await writeFile(join(userDir, "tasks", "index.jsonl"), JSON.stringify({ id: "t-1", title: "提醒", instruction: "去睡", trigger: { kind: "daily", time: "23:00" }, enabled: true, tzOffsetMinutes: 480, createdTs: 500 }) + "\n", "utf8");
  await writeFile(join(userDir, "tasks", "t-1", "runs.jsonl"), JSON.stringify({ ts: 600, status: "ran" }) + "\n", "utf8");
  await writeFile(join(userDir, "tasks", "t-1", "session.jsonl"), JSON.stringify({ type: "turn/start", turn: 1, seq: 0, ts: 700 }) + "\n", "utf8");

  await writeFile(join(userDir, "agents", "index.jsonl"), JSON.stringify({ id: "aid-1", name: "教练", createdTs: 800, binding: { skills: ["sk-1"], mcps: [] } }) + "\n", "utf8");
  await writeFile(join(userDir, "agents", "aid-1", "persona.md"), "# 教练\n盯训练。", "utf8");

  await writeFile(join(userDir, "skills", "index.jsonl"), JSON.stringify({ id: "sk-1", name: "健身", description: "健身话题" }) + "\n", "utf8");
  await writeFile(join(userDir, "skills", "sk-1", "SKILL.md"), "---\nname: 健身\n---\n\n# 正文", "utf8");

  await writeFile(join(userDir, "mcps.json"), JSON.stringify([{ id: "mc-1", name: "回声", url: "https://mcp.local" }]), "utf8");
  await writeFile(join(userDir, "memory", "profile.md"), "软件工程师", "utf8");
  await writeFile(join(userDir, "memory", "meta.json"), JSON.stringify({ lastRunTs: 900, runs: 2 }), "utf8");
  await writeFile(join(userDir, "notifications.jsonl"), JSON.stringify({ seq: 0, ts: 950, kind: "task_message", taskId: "t-1", text: "到点" }) + "\n", "utf8");
  await writeFile(join(userDir, "model.json"), JSON.stringify({ baseURL: "https://api.x.com", model: "m-1", keyEnc: "enc" }) + "\n", "utf8");
  await writeFile(join(userDir, "archives.json"), JSON.stringify(["餐饮"]), "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("migrateLegacy", () => {
  it("全量导入：表行数与内容正确；坏行跳过；二次调用幂等", async () => {
    const db = testDb();
    expect(migrateLegacy(db, root)).toBe(true);

    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as unknown as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked = 0").get() as unknown as { n: number }).n).toBe(1); // 只导存活
    // 账本：event + void 入库，坏行拒绝
    const ledger = db.prepare("SELECT kind, category, value, target_seq, reason FROM ledger_entries WHERE uid = 'u-1' ORDER BY seq").all() as unknown as Record<string, unknown>[];
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ kind: "event", category: "餐饮", value: 28 });
    expect(ledger[1]).toMatchObject({ kind: "void", target_seq: 0, reason: "记错" });
    // 会话 + meta + 九事件
    const conv = db.prepare("SELECT title, agent_id FROM conversations WHERE cid = 'c-1'").get() as unknown as { title: string; agent_id: string };
    expect(conv).toMatchObject({ title: "测试", agent_id: "aid-1" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE cid = 'c-1'").get() as unknown as { n: number }).n).toBe(2);
    // 任务会话独立 cid
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE cid = 'task:t-1'").get() as unknown as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as unknown as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_runs").get() as unknown as { n: number }).n).toBe(1);
    // 智能体（persona 内嵌）+ 技能（正文内嵌）
    const agent = db.prepare("SELECT name, persona_md, bindings_json FROM agents WHERE id = 'aid-1'").get() as unknown as { name: string; persona_md: string };
    expect(agent.name).toBe("教练");
    expect(agent.persona_md).toContain("盯训练");
    const skill = db.prepare("SELECT name, body_md FROM skills WHERE id = 'sk-1'").get() as unknown as { name: string; body_md: string };
    expect(skill.body_md).toContain("# 正文");
    // mcps / memory / notifications / model / archives
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcps").get() as unknown as { n: number }).n).toBe(1);
    const profile = db.prepare("SELECT content_md FROM memory_slots WHERE uid = 'u-1' AND slot = 'profile'").get() as unknown as { content_md: string };
    expect(profile.content_md).toBe("软件工程师");
    const memoryMeta = db.prepare("SELECT runs FROM memory_meta WHERE uid = 'u-1'").get() as unknown as { runs: number };
    expect(memoryMeta.runs).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as unknown as { n: number }).n).toBe(1);
    const model = db.prepare("SELECT base_url, key_enc FROM model_config WHERE uid = 'u-1'").get() as unknown as { base_url: string; key_enc: string };
    expect(model).toMatchObject({ base_url: "https://api.x.com", key_enc: "enc" });
    const archives = db.prepare("SELECT list_json FROM archives WHERE uid = 'u-1'").get() as unknown as { list_json: string };
    expect(JSON.parse(archives.list_json)).toEqual(["餐饮"]);

    // 幂等：二次导入不重复
    expect(migrateLegacy(db, root)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get() as unknown as { n: number }).n).toBe(2);
  });

  it("旧单模型 model_config → model_providers + 激活（migrateLegacyModelConfig，幂等）", async () => {
    const db = testDb();
    migrateLegacy(db, root); // fixture 里 model.json → model_config
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
    // 幂等：再跑不重复
    migrateLegacyModelConfig(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as unknown as { n: number }).n).toBe(1);
  });
});
