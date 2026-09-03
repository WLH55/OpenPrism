// 批次1·secretbox：BYOK Key 的 AES-256-GCM 密封 + 主密钥落盘 + model.json 原子读写。

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeFileIO } from "../src/app/env";
import {
  loadOrCreateMasterKey,
  open,
  readModelConfig,
  seal,
  writeModelConfig,
} from "../src/app/secretbox";

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

describe("model.json 读写", () => {
  it("writeModelConfig 原子写（无残留 tmp），readModelConfig 往返；缺失返回 null", async () => {
    const path = join(root, "model.json");
    expect(await readModelConfig(nodeFileIO, path)).toBeNull();
    await writeModelConfig(nodeFileIO, path, { baseURL: "https://api.deepseek.com", model: "deepseek-chat", keyEnc: seal(Buffer.alloc(32, 1), "sk-x") });
    const loaded = await readModelConfig(nodeFileIO, path);
    expect(loaded?.baseURL).toBe("https://api.deepseek.com");
    expect(loaded?.model).toBe("deepseek-chat");
    expect(open(Buffer.alloc(32, 1), loaded!.keyEnc!)).toBe("sk-x");
    await expect(stat(path + ".tmp")).rejects.toThrow();
  });
});
