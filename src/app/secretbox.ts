// BYOK Key 密封（Q8 铁律的技术面）：Key 只以 AES-256-GCM 密文落盘（model.json 的 keyEnc），
// 明文只在内存中短暂存在、只发往用户配置的 baseURL。主密钥 32B 落 data/secret.key（已 gitignore）。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileIO } from "../harness/index";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function seal(master: Buffer, plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function open(master: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", master, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export async function loadOrCreateMasterKey(dataRoot: string): Promise<Buffer> {
  const path = `${dataRoot}/secret.key`;
  try {
    const key = await readFile(path);
    if (key.length === 32) return key;
  } catch {
    // 首次启动：不存在
  }
  const key = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, key, { mode: 0o600 });
  return key;
}

export interface ModelConfig {
  baseURL: string;
  model: string;
  /** AES-256-GCM 密文（seal 产物）；未配置 Key 时缺省 */
  keyEnc?: string;
}

export async function readModelConfig(fileIO: FileIO, path: string): Promise<ModelConfig | null> {
  const lines = await fileIO.readAll(path);
  if (lines.length === 0) return null;
  try {
    const config = JSON.parse(lines[lines.length - 1]) as ModelConfig;
    if (typeof config?.baseURL === "string" && typeof config?.model === "string") return config;
    return null;
  } catch {
    return null;
  }
}

export async function writeModelConfig(fileIO: FileIO, path: string, config: ModelConfig): Promise<void> {
  const tmp = path + ".tmp";
  await fileIO.appendLine(tmp, JSON.stringify(config));
  await rename(tmp, path); // 原子替换；Node 的 rename 跨平台覆盖已存在目标
}
