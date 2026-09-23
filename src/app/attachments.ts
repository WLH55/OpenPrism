// 对话附件（2026-09-19）：浏览器上传的图片与文本文件 → harness 内容块。
// 图片以 base64 随消息入会话日志（可重放、可跨进程重建请求），文本文件正文直接内联为文本附件块。
// 二进制文档（PDF/Office/压缩包）不做自行解析：显式拒绝并说明可用的格式。

import type { ContentBlock } from "../harness/index";

/** 单张图片（base64 解码后）上限 */
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
/** 单个文本附件正文上限（字符） */
export const FILE_MAX_CHARS = 400_000;
/** 一条消息的附件个数上限 */
export const ATTACHMENT_MAX_COUNT = 6;
/** 一条消息里图片个数上限（一次请求多图很贵） */
export const IMAGE_MAX_COUNT = 4;
/** 一条消息全部附件合计上限（字节，图片按解码后计、文本按 UTF-8 计） */
export const ATTACHMENT_TOTAL_MAX_BYTES = 12 * 1024 * 1024;
export const FILE_NAME_MAX = 200;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** 线上入参（浏览器 → 服务器） */
export interface AttachmentInput {
  kind: "image" | "file";
  name: string;
  mediaType: string;
  /** kind=image：base64 裸数据（无 data: 前缀） */
  dataBase64?: string;
  /** kind=file：正文 */
  text?: string;
}

export interface ParsedAttachments {
  blocks: ContentBlock[];
  /** 图片块个数（多模态能力校验用） */
  imageCount: number;
}

/** 图片字节签名与声明的 MIME 是否一致（防错标类型） */
function matchesSignature(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === "image/png") return bytes.length > 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG";
  if (mediaType === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/gif") return bytes.length > 6 && bytes.subarray(0, 4).toString("latin1") === "GIF8";
  if (mediaType === "image/webp") return bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

/**
 * 附件入参 → 内容块序列。任何非法输入就地抛错（路由层转为 400），不做静默丢弃。
 */
export function parseAttachments(input: unknown): ParsedAttachments {
  const list = input === undefined || input === null ? [] : input;
  if (!Array.isArray(list)) throw new Error("attachments 需要数组");
  if (list.length > ATTACHMENT_MAX_COUNT) throw new Error(`一条消息最多 ${ATTACHMENT_MAX_COUNT} 个附件`);
  const blocks: ContentBlock[] = [];
  let imageCount = 0;
  let totalBytes = 0;
  for (const raw of list) {
    const item = raw as AttachmentInput | null;
    const name = String(item?.name ?? "").trim().slice(0, FILE_NAME_MAX) || "附件";
    const kind = String(item?.kind ?? "");
    if (kind === "image") {
      const mediaType = String(item?.mediaType ?? "").trim().toLowerCase();
      if (!(IMAGE_TYPES as readonly string[]).includes(mediaType)) {
        throw new Error(`图片「${name}」类型是 ${mediaType || "未知"}，只支持 PNG / JPEG / WebP / GIF`);
      }
      const data = String(item?.dataBase64 ?? "").replace(/\s/g, "");
      if (data === "") throw new Error(`图片「${name}」没有数据`);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`图片「${name}」不是合法 base64`);
      const bytes = Buffer.from(data, "base64");
      if (bytes.length === 0) throw new Error(`图片「${name}」不是合法 base64`);
      if (bytes.length > IMAGE_MAX_BYTES) throw new Error(`图片「${name}」超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB`);
      if (!matchesSignature(mediaType, bytes)) throw new Error(`图片「${name}」的内容与类型 ${mediaType} 不符`);
      imageCount += 1;
      if (imageCount > IMAGE_MAX_COUNT) throw new Error(`一条消息最多 ${IMAGE_MAX_COUNT} 张图片`);
      totalBytes += bytes.length;
      blocks.push({ type: "image", mediaType, data });
      continue;
    }
    if (kind === "file") {
      const text = String(item?.text ?? "");
      if (text.trim() === "") throw new Error(`文件「${name}」内容为空`);
      if (text.length > FILE_MAX_CHARS) throw new Error(`文件「${name}」超过 ${FILE_MAX_CHARS} 字上限`);
      totalBytes += Buffer.byteLength(text, "utf8");
      blocks.push({ type: "file", name, mediaType: String(item?.mediaType ?? "").trim() || "text/plain", text });
      continue;
    }
    throw new Error("附件 kind 只支持 image | file");
  }
  if (totalBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
    throw new Error(`附件合计超过 ${Math.round(ATTACHMENT_TOTAL_MAX_BYTES / 1024 / 1024)}MB`);
  }
  return { blocks, imageCount };
}
