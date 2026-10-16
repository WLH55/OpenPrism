// 微信入站媒体（2026-10-11）：iLink CDN 媒体的密钥解析 / AES-128-ECB 解密 / 内容探测纯函数。
// 协议事实源 = WeKnora internal/im/wechat/{adapter,crypto}.go（parseAESKey 三格式、容错 PKCS#7）。
// node:crypto 仅 app 层可用（harness 零平台依赖铁律不受影响）。

import { createDecipheriv } from "node:crypto";

/** CDN 下载的密文硬顶（防御层：覆盖图片 6MB / 附件合计 12MB 等用途上限 + padding 余量） */
export const WECHAT_DOWNLOAD_MAX_BYTES = 17 * 1024 * 1024;

function isHex(s: string): boolean {
  return s.length > 0 && /^[0-9a-fA-F]+$/.test(s);
}

/** AES key 三格式探测（WeKnora parseAESKey 同款）：raw hex 32 字符 / base64(16 裸字节) / base64(32 位 hex ASCII) */
export function parseAesKey(raw: string): Buffer {
  if (raw === "") throw new Error("aes key 为空");
  if (raw.length === 32 && isHex(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 16) return decoded;
    const asHex = decoded.toString("latin1");
    if (decoded.length === 32 && isHex(asHex)) return Buffer.from(asHex, "hex");
  }
  if (isHex(raw) && raw.length % 2 === 0) return Buffer.from(raw, "hex");
  throw new Error(`无法解析 aes key（输入长度 ${raw.length}）`);
}

/** AES-128-ECB 解密 + 容错 PKCS#7 剥离（iLink 密文可能无 padding——「像 padding 才剥」，WeKnora 同款语义；
 * ECB 无完整性校验，错误 key 解出乱码不抛错——由调用方 sniffImageType 把关） */
export function decryptAes128Ecb(ciphertext: Uint8Array, key: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(`密文长度 ${ciphertext.length} 不是 16 的倍数`);
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const padLen = plain[plain.length - 1]!;
  if (padLen > 0 && padLen <= 16 && padLen <= plain.length) {
    let valid = true;
    for (let i = 0; i < padLen; i++) {
      if (plain[plain.length - 1 - i] !== padLen) {
        valid = false;
        break;
      }
    }
    if (valid) return plain.subarray(0, plain.length - padLen);
  }
  return plain;
}

export type SniffedImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const latin1 = new TextDecoder("latin1");

/** 图片 magic bytes 嗅探（iLink 图片不报格式，WeKnora 盲命名 .png；与 attachments.ts 的签名校验同口径，方向相反：定类型而非验声明） */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length > 12 && latin1.decode(bytes.subarray(0, 4)) === "RIFF" && latin1.decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** 文本文件探测：NUL 字节或非法 UTF-8 → 判二进制（微信「文件」可以是任意类型，只有文本类可内联为 FileBlock） */
export function decodeTextFile(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  if (bytes.includes(0)) return { ok: false };
  try {
    return { ok: true, text: utf8Strict.decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/** 文件名扩展 → MIME（FileBlock 展示用；未知一律 text/plain） */
export function mediaTypeForFileName(name: string | undefined): string {
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "xml") return "text/xml";
  return "text/plain";
}
