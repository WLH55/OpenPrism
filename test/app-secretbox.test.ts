// 批次1·secretbox：BYOK Key 的 AES-256-GCM 密封 + 主密钥落盘 + 多模型供应商 CRUD（model_providers/model_active 表）。

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeModelId,
  addModelProvider,
  listModelProviders,
  loadOrCreateMasterKey,
  open,
  platformFromBaseURL,
  readModelConfig,
  readModelProviderConfig,
  removeModelProvider,
  seal,
  setActiveModel,
  updateModelProvider,
} from "../src/app/secretbox";
import { testDb } from "./helpers-db";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "op-app-secret-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("seal/open", () => {
  const master = Buffer.alloc(32, 7);

  it("往返还原明文", () => {
    const sealed = seal(master, "sk-abc123");
    expect(open(master, sealed)).toBe("sk-abc123");
  });

  it("每次密封使用新 iv（密文不同）", () => {
    expect(seal(master, "same")).not.toBe(seal(master, "same"));
  });

  it("篡改一个字节即抛错", () => {
    const sealed = seal(master, "sk-abc123");
    const buf = Buffer.from(sealed, "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => open(master, buf.toString("base64"))).toThrow();
  });

  it("主密钥不符即抛错", () => {
    const sealed = seal(master, "sk-abc123");
    expect(() => open(Buffer.alloc(32, 9), sealed)).toThrow();
  });
});

describe("loadOrCreateMasterKey", () => {
  it("首次生成 32B 并落盘；再读返回同一把钥匙", async () => {
    const dataRoot = join(root, "d1");
    const k1 = await loadOrCreateMasterKey(dataRoot);
    expect(k1.length).toBe(32);
    const onDisk = await readFile(join(dataRoot, "secret.key"));
    expect(k1.equals(onDisk)).toBe(true);
    const k2 = await loadOrCreateMasterKey(dataRoot);
    expect(k1.equals(k2)).toBe(true);
  });
});

describe("platformFromBaseURL", () => {
  it("常见平台自动识别；未知回退 hostname；非法返回空串", () => {
    expect(platformFromBaseURL("https://api.deepseek.com")).toBe("DeepSeek");
    expect(platformFromBaseURL("https://open.bigmodel.cn/api/paas/v4")).toBe("智谱 GLM");
    expect(platformFromBaseURL("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("通义千问 Qwen");
    expect(platformFromBaseURL("http://127.0.0.1:8000/v1")).toBe("本地服务");
    expect(platformFromBaseURL("https://example.unknowndomain.io/v1")).toBe("example.unknowndomain.io");
    expect(platformFromBaseURL("::::")).toBe("");
  });
});

describe("模型供应商 CRUD（model_providers/model_active）", () => {
  it("add 首个自动激活；readModelConfig 返回激活行（含 contextWindow，keyEnc 不外泄到列表视图）", async () => {
    const db = testDb();
    expect(await readModelConfig(db, "u1")).toBeNull();
    const first = addModelProvider(db, "u1", {
      baseURL: "https://api.deepseek.com",
      model: "deepseek-chat",
      contextWindow: 128000,
      keyEnc: seal(Buffer.alloc(32, 1), "sk-x"),
    });
    expect(activeModelId(db, "u1")).toBe(first.id);
    const active = await readModelConfig(db, "u1");
    expect(active).toMatchObject({
      id: first.id,
      platform: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-chat",
      contextWindow: 128000,
    });
    const view = (await listModelProviders(db, "u1"))[0]!;
    expect(view.hasKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sk-x");
  });

  it("多供应商：新增不改激活；setActiveModel 切换；update 改窗口/URL 重推平台", async () => {
    const db = testDb();
    const a = addModelProvider(db, "u1", { baseURL: "https://api.deepseek.com", model: "deepseek-chat" });
    const b = addModelProvider(db, "u1", { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" });
    expect(activeModelId(db, "u1")).toBe(a.id); // 新增不抢激活
    setActiveModel(db, "u1", b.id);
    expect((await readModelConfig(db, "u1"))?.platform).toBe("智谱 GLM");
    updateModelProvider(db, "u1", b.id, { contextWindow: 200000 });
    expect((await readModelConfig(db, "u1"))?.contextWindow).toBe(200000);
    updateModelProvider(db, "u1", b.id, { baseURL: "https://api.moonshot.cn/v1" });
    expect((await readModelConfig(db, "u1"))?.platform).toBe("Moonshot Kimi"); // URL 变了平台重推
    expect(listModelProviders(db, "u1")).toHaveLength(2);
  });

  it("删除激活供应商 → 自动切到最近剩余；删光 → 无激活；用户隔离", async () => {
    const db = testDb();
    const a = addModelProvider(db, "u1", { baseURL: "https://api.deepseek.com", model: "deepseek-chat" });
    const b = addModelProvider(db, "u1", { baseURL: "https://open.bigmodel.cn", model: "glm-4.6" });
    setActiveModel(db, "u1", a.id);
    removeModelProvider(db, "u1", a.id);
    expect(activeModelId(db, "u1")).toBe(b.id);
    removeModelProvider(db, "u1", b.id);
    expect(activeModelId(db, "u1")).toBeNull();
    expect(await readModelConfig(db, "u1")).toBeNull();
    addModelProvider(db, "u2", { baseURL: "https://api.deepseek.com", model: "deepseek-chat" });
    expect(await readModelConfig(db, "u1")).toBeNull();
  });

  it("readModelProviderConfig：按 id 取完整配置（含 keyEnc，测试连接用）", () => {
    const db = testDb();
    const a = addModelProvider(db, "u1", { baseURL: "https://api.deepseek.com", model: "deepseek-chat", keyEnc: seal(Buffer.alloc(32, 2), "sk-y") });
    const full = readModelProviderConfig(db, "u1", a.id);
    expect(open(Buffer.alloc(32, 2), full!.keyEnc!)).toBe("sk-y");
    expect(readModelProviderConfig(db, "u1", "nope")).toBeNull();
  });
});
