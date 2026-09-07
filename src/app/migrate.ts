// 旧版 JSONL/markdown 数据一次性导入（ADR 0008 迁移器）：meta.migrated 幂等标记，二次启动不重复；
// 旧文件原样保留（永不破坏），导入完成打印统计。覆盖：users/sessions/life/conversations(+meta+session)/
// tasks(+runs+session)/agents(+persona)/skills(+SKILL.md)/mcps/memory(+meta)/notifications/model/archives。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { UserRecord } from "./auth";
import { insertLedgerRecord, type LedgerRecord } from "./ledger";
import { platformFromBaseURL } from "./secretbox";

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function migrateLegacy(db: DatabaseSync, dataRoot: string): boolean {
  const flag = db.prepare("SELECT value FROM meta WHERE key = 'migrated'").get();
  if (flag) return false;

  const counts = { users: 0, sessions: 0, ledger: 0, conversations: 0, events: 0, tasks: 0, agents: 0, skills: 0, mcps: 0, notifications: 0 };

  // ── 用户表 ──
  for (const line of readLines(join(dataRoot, "users.jsonl"))) {
    try {
      const user = JSON.parse(line) as UserRecord;
      if (typeof user?.uid !== "string") continue;
      db.prepare("INSERT OR IGNORE INTO users (uid, username, salt, pwd_hash, created_ts) VALUES (?, ?, ?, ?, ?)").run(
        user.uid,
        user.username,
        user.password.salt,
        user.password.hash,
        user.createdTs,
      );
      counts.users += 1;
    } catch {
      // 坏行
    }
  }

  // ── 会话令牌（只导存活：未吊销且未过期） ──
  const issued = new Map<string, { uid: string; expiresAt: number }>();
  const revoked = new Set<string>();
  for (const line of readLines(join(dataRoot, "sessions.jsonl"))) {
    try {
      const row = JSON.parse(line) as { op: "issue" | "revoke"; token: string; uid?: string; expiresAt?: number };
      if (row.op === "issue" && row.token && row.uid !== undefined && row.expiresAt !== undefined) {
        issued.set(row.token, { uid: row.uid, expiresAt: row.expiresAt });
      } else if (row.op === "revoke" && row.token) {
        revoked.add(row.token);
      }
    } catch {
      // 坏行
    }
  }
  const now = Date.now();
  for (const [token, session] of issued) {
    if (revoked.has(token) || session.expiresAt <= now) continue;
    db.prepare("INSERT OR IGNORE INTO sessions (token, uid, expires_at, revoked) VALUES (?, ?, ?, 0)").run(token, session.uid, session.expiresAt);
    counts.sessions += 1;
  }

  // ── 用户目录 ──
  const usersDir = join(dataRoot, "users");
  if (existsSync(usersDir)) {
    for (const uid of readdirSync(usersDir)) {
      const userDir = join(usersDir, uid);

      // 账本
      for (const line of readLines(join(userDir, "life.jsonl"))) {
        try {
          const record = JSON.parse(line) as LedgerRecord;
          if (typeof record?.seq !== "number") continue;
          insertLedgerRecord(db, uid, record);
          counts.ledger += 1;
        } catch {
          // 坏行
        }
      }

      // 聊天会话：index + meta + session
      const convDir = join(userDir, "conversations");
      for (const line of readLines(join(convDir, "index.jsonl"))) {
        try {
          const entry = JSON.parse(line) as { id: string; title?: string; createdTs?: number };
          if (typeof entry?.id !== "string") continue;
          db.prepare("INSERT OR IGNORE INTO conversations (cid, uid, title, created_ts) VALUES (?, ?, ?, ?)").run(
            entry.id,
            uid,
            entry.title ?? "",
            entry.createdTs ?? now,
          );
          counts.conversations += 1;
        } catch {
          // 坏行
        }
      }
      const convEntriesDir = join(convDir);
      if (existsSync(convEntriesDir)) {
        for (const cid of readdirSync(convEntriesDir)) {
          const entryDir = join(convEntriesDir, cid);
          const metaRaw = readRaw(join(entryDir, "meta.json"));
          if (metaRaw !== null) {
            try {
              const meta = JSON.parse(metaRaw) as { agentId?: string; switches?: { ts: number; agentId: string }[] };
              db.prepare("UPDATE conversations SET agent_id = ?, switches_json = ? WHERE cid = ? AND uid = ?").run(
                meta.agentId ?? null,
                JSON.stringify(Array.isArray(meta.switches) ? meta.switches : []),
                cid,
                uid,
              );
            } catch {
              // 坏 meta
            }
          }
          for (const line of readLines(join(entryDir, "session.jsonl"))) {
            if (insertEvent(db, cid, line)) counts.events += 1;
          }
        }
      }

      // 任务：index + runs + 任务专属会话
      const tasksDir = join(userDir, "tasks");
      if (existsSync(tasksDir)) {
        for (const line of readLines(join(tasksDir, "index.jsonl"))) {
          try {
            const task = JSON.parse(line) as {
              id: string;
              agentId?: string;
              title: string;
              instruction: string;
              trigger: unknown;
              enabled: boolean;
              tzOffsetMinutes: number;
              createdTs: number;
              lastRunTs?: number;
            };
            if (typeof task?.id !== "string") continue;
            db.prepare(
              "INSERT OR IGNORE INTO tasks (id, uid, agent_id, title, instruction, trigger_json, enabled, tz_offset_minutes, created_ts, last_run_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              task.id,
              uid,
              task.agentId ?? null,
              task.title,
              task.instruction,
              JSON.stringify(task.trigger),
              task.enabled ? 1 : 0,
              task.tzOffsetMinutes ?? 0,
              task.createdTs ?? now,
              task.lastRunTs ?? null,
            );
            counts.tasks += 1;
          } catch {
            // 坏行
          }
        }
        for (const taskId of readdirSync(tasksDir)) {
          const taskDir = join(tasksDir, taskId);
          for (const line of readLines(join(taskDir, "runs.jsonl"))) {
            try {
              const run = JSON.parse(line) as { ts: number; status: "ran" | "skipped" | "failed"; detail?: string };
              db.prepare("INSERT INTO task_runs (uid, task_id, ts, status, detail) VALUES (?, ?, ?, ?, ?)").run(
                uid,
                taskId,
                run.ts,
                run.status,
                run.detail ?? null,
              );
            } catch {
              // 坏行
            }
          }
          for (const line of readLines(join(taskDir, "session.jsonl"))) {
            if (insertEvent(db, `task:${taskId}`, line)) counts.events += 1;
          }
        }
      }

      // 智能体（persona.md 正文内嵌）
      const agentsDir = join(userDir, "agents");
      if (existsSync(agentsDir)) {
        for (const line of readLines(join(agentsDir, "index.jsonl"))) {
          try {
            const agent = JSON.parse(line) as { id: string; name: string; createdTs?: number; binding?: unknown };
            if (typeof agent?.id !== "string") continue;
            const persona = readRaw(join(agentsDir, agent.id, "persona.md")) ?? "";
            db.prepare("INSERT OR IGNORE INTO agents (id, uid, name, persona_md, bindings_json, created_ts) VALUES (?, ?, ?, ?, ?, ?)").run(
              agent.id,
              uid,
              agent.name || "助手",
              persona,
              JSON.stringify(agent.binding ?? { skills: [], mcps: [] }),
              agent.createdTs ?? now,
            );
            counts.agents += 1;
          } catch {
            // 坏行
          }
        }
      }

      // 技能（SKILL.md 正文内嵌）
      const skillsDir = join(userDir, "skills");
      if (existsSync(skillsDir)) {
        for (const line of readLines(join(skillsDir, "index.jsonl"))) {
          try {
            const meta = JSON.parse(line) as { id: string; name: string; description: string; whenToUse?: string };
            if (typeof meta?.id !== "string") continue;
            const body = readRaw(join(skillsDir, meta.id, "SKILL.md")) ?? "";
            db.prepare("INSERT OR IGNORE INTO skills (id, uid, name, description, when_to_use, body_md, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              meta.id,
              uid,
              meta.name,
              meta.description,
              meta.whenToUse ?? null,
              body,
              now,
            );
            counts.skills += 1;
          } catch {
            // 坏行
          }
        }
      }

      // MCP 注册表（last-line-wins 单文件）
      const mcpsRaw = readRaw(join(userDir, "mcps.json"));
      if (mcpsRaw !== null) {
        for (const line of mcpsRaw.split("\n")) {
          if (line.trim() === "") continue;
          try {
            const configs = JSON.parse(line) as { id: string; name: string; url: string; headers?: Record<string, string> }[];
            if (!Array.isArray(configs)) continue;
            for (const config of configs) {
              db.prepare("INSERT OR IGNORE INTO mcps (id, uid, name, url, headers_json, created_ts) VALUES (?, ?, ?, ?, ?, ?)").run(
                config.id,
                uid,
                config.name,
                config.url,
                config.headers ? JSON.stringify(config.headers) : null,
                now,
              );
              counts.mcps += 1;
            }
            break; // 只取最后一行
          } catch {
            // 坏行，继续找前一行
          }
        }
      }

      // 记忆四槽 + meta
      const memoryDir = join(userDir, "memory");
      for (const slot of ["recent", "profile", "scope", "preferences"]) {
        const content = readRaw(join(memoryDir, `${slot}.md`));
        if (content !== null) {
          db.prepare("INSERT OR IGNORE INTO memory_slots (uid, slot, content_md, updated_ts) VALUES (?, ?, ?, NULL)").run(uid, slot, content);
        }
      }
      const memoryMetaRaw = readRaw(join(memoryDir, "meta.json"));
      if (memoryMetaRaw !== null) {
        try {
          const meta = JSON.parse(memoryMetaRaw) as { lastRunTs?: number; runs?: number };
          db.prepare("INSERT OR IGNORE INTO memory_meta (uid, last_run_ts, runs) VALUES (?, ?, ?)").run(
            uid,
            meta.lastRunTs ?? null,
            meta.runs ?? 0,
          );
        } catch {
          // 坏 meta
        }
      }

      // 通知
      for (const line of readLines(join(userDir, "notifications.jsonl"))) {
        try {
          const row = JSON.parse(line) as { seq: number; ts: number; kind: string; taskId?: string; text: string; readTs?: number };
          if (typeof row?.seq !== "number") continue;
          db.prepare("INSERT OR IGNORE INTO notifications (uid, seq, ts, kind, task_id, text, read_ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            uid,
            row.seq,
            row.ts,
            row.kind,
            row.taskId ?? null,
            row.text,
            row.readTs ?? null,
          );
          counts.notifications += 1;
        } catch {
          // 坏行
        }
      }

      // 模型配置（last-line-wins 单行 JSONL）
      const modelLines = readLines(join(userDir, "model.json"));
      if (modelLines.length > 0) {
        try {
          const config = JSON.parse(modelLines[modelLines.length - 1]!) as { baseURL?: string; model?: string; keyEnc?: string };
          db.prepare("INSERT OR IGNORE INTO model_config (uid, base_url, model, key_enc) VALUES (?, ?, ?, ?)").run(
            uid,
            config.baseURL ?? "",
            config.model ?? "",
            config.keyEnc ?? null,
          );
        } catch {
          // 坏行
        }
      }

      // 面板归档名单（last-line-wins）
      const archiveLines = readLines(join(userDir, "archives.json"));
      if (archiveLines.length > 0) {
        try {
          const list = JSON.parse(archiveLines[archiveLines.length - 1]!) as string[];
          if (Array.isArray(list)) {
            db.prepare("INSERT OR IGNORE INTO archives (uid, list_json, updated_ts) VALUES (?, ?, ?)").run(uid, JSON.stringify(list), now);
          }
        } catch {
          // 坏行
        }
      }
    }
  }

  db.prepare("INSERT INTO meta (key, value) VALUES ('migrated', ?)").run(String(now));
  process.stdout.write(
    `[migrate] users=${counts.users} sessions=${counts.sessions} ledger=${counts.ledger} conversations=${counts.conversations} events=${counts.events} tasks=${counts.tasks} agents=${counts.agents} skills=${counts.skills} mcps=${counts.mcps} notifications=${counts.notifications}\n`,
  );
  return true;
}

/** 旧版单模型 model_config 行 → model_providers + 激活（幂等：providers 非空即跳过；每次启动调用） */
export function migrateLegacyModelConfig(db: DatabaseSync): void {
  const has = db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as unknown as { n: number };
  if (has.n > 0) return;
  const rows = db.prepare("SELECT uid, base_url, model, key_enc FROM model_config").all() as unknown as {
    uid: string;
    base_url: string;
    model: string;
    key_enc: string | null;
  }[];
  for (const row of rows) {
    if (row.base_url === "" && row.model === "") continue; // 空配置不迁
    const id = randomUUID();
    db.prepare(
      "INSERT INTO model_providers (id, uid, platform, base_url, model, context_window, key_enc, created_ts) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    ).run(id, row.uid, platformFromBaseURL(row.base_url), row.base_url, row.model, row.key_enc, Date.now());
    db.prepare("INSERT OR IGNORE INTO model_active (uid, provider_id) VALUES (?, ?)").run(row.uid, id);
  }
}

/** 单条九事件导入：返回是否成功（seq/type 缺失拒绝） */
function insertEvent(db: DatabaseSync, cid: string, line: string): boolean {
  try {
    const event = JSON.parse(line) as { seq?: number; ts?: number; type?: string; message?: { role?: string } };
    if (typeof event?.seq !== "number" || typeof event?.type !== "string") return false;
    db.prepare("INSERT OR IGNORE INTO conversation_events (cid, seq, type, ts, role, event_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      cid,
      event.seq,
      event.type,
      event.ts ?? Date.now(),
      event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : null,
      line,
    );
    return true;
  } catch {
    return false;
  }
}
