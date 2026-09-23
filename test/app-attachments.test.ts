// 对话附件（2026-09-19）：入参校验（类型/签名/base64/上限）→ harness 内容块；
// 以及文本投影 flattenText（界面显示、会话标题、召回 query、记忆提取共用同一套语义）。

import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_COUNT,
  FILE_MAX_CHARS,
  IMAGE_MAX_COUNT,
  parseAttachments,
} from "../src/app/attachments";
import { fileBlocksOf, flattenText, hasImageBlocks, imageBlocksOf, type UserMessage } from "../src/harness/index";

/** 最小 PNG 头（签名校验只看前几字节，测试不依赖真实图片解码） */
const pngBytes = (pad = 0): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(pad, 7)]);

const jpegBytes = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8, 3)]);

const imageInput = (bytes: Buffer = pngBytes(4), overrides: Record<string, unknown> = {}) => ({
  kind: "image",
  name: "screenshot.png",
  mediaType: "image/png",
  dataBase64: bytes.toString("base64"),
  ...overrides,
});

const fileInput = (text: string, overrides: Record<string, unknown> = {}) => ({
  kind: "file",
  name: "note.md",
  mediaType: "text/markdown",
  text,
  ...overrides,
});

describe("parseAttachments", () => {
  it("图片与文本文件按顺序变成内容块；imageCount 只数图片", () => {
    const parsed = parseAttachments([fileInput("# 标题\n正文"), imageInput()]);
    expect(parsed.imageCount).toBe(1);
    expect(parsed.blocks).toEqual([
      { type: "file", name: "note.md", mediaType: "text/markdown", text: "# 标题\n正文" },
      { type: "image", mediaType: "image/png", data: pngBytes(4).toString("base64") },
    ]);
  });

  it("缺省与空数组都是空结果（不带附件的老客户端照常发消息）", () => {
    expect(parseAttachments(undefined)).toEqual({ blocks: [], imageCount: 0 });
    expect(parseAttachments(null)).toEqual({ blocks: [], imageCount: 0 });
    expect(parseAttachments([])).toEqual({ blocks: [], imageCount: 0 });
  });

  it("MIME 大小写归一；声明类型与图片字节签名不符即拒绝", () => {
    const parsed = parseAttachments([imageInput(pngBytes(2), { mediaType: "IMAGE/PNG" })]);
    expect(parsed.blocks[0]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(() => parseAttachments([imageInput(jpegBytes(), { mediaType: "image/png" })])).toThrow(/内容与类型/);
  });

  it("拒绝：非数组、未知 kind、不支持的图片类型、非法 base64、空图片", () => {
    expect(() => parseAttachments({})).toThrow(/attachments 需要数组/);
    expect(() => parseAttachments([{ kind: "video", name: "a.mp4" }])).toThrow(/kind 只支持/);
    expect(() => parseAttachments([imageInput(pngBytes(1), { mediaType: "image/tiff" })])).toThrow(/只支持 PNG/);
    expect(() => parseAttachments([imageInput(pngBytes(1), { dataBase64: "!!!not base64!!!" })])).toThrow(/不是合法 base64/);
    expect(() => parseAttachments([imageInput(pngBytes(1), { dataBase64: "" })])).toThrow(/没有数据/);
  });

  it("拒绝：空文本文件、超长文本文件、附件个数上限、图片张数上限", () => {
    expect(() => parseAttachments([fileInput("   ")])).toThrow(/内容为空/);
    expect(() => parseAttachments([fileInput("字".repeat(FILE_MAX_CHARS + 1))])).toThrow(/字上限/);
    expect(() => parseAttachments(Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, () => fileInput("x")))).toThrow(/最多 6 个附件/);
    expect(() => parseAttachments(Array.from({ length: IMAGE_MAX_COUNT + 1 }, () => imageInput()))).toThrow(/最多 4 张图片/);
  });
});

describe("flattenText（文本投影）", () => {
  const message = (content: UserMessage["content"]): UserMessage => ({ role: "user", content });

  it("文本、附件正文（带文件名抬头）、图片占位符依次拼接", () => {
    const text = flattenText(
      message([
        { type: "text", text: "看看这个" },
        { type: "file", name: "数据.csv", mediaType: "text/csv", text: "a,b\n1,2" },
        { type: "image", mediaType: "image/webp", data: "AAAA" },
      ]),
    );
    expect(text).toBe("看看这个\n【附件 数据.csv】\n" + "a,b\n1,2" + "\n【图片 image/webp】");
    expect(hasImageBlocks(message([{ type: "image", mediaType: "image/png", data: "x" }]))).toBe(true);
    expect(hasImageBlocks(message([{ type: "text", text: "纯文字" }]))).toBe(false);
    expect(fileBlocksOf(message([{ type: "file", name: "a.txt", mediaType: "text/plain", text: "x" }]))).toHaveLength(1);
    expect(imageBlocksOf(message([{ type: "image", mediaType: "image/png", data: "x" }]))).toHaveLength(1);
  });
});
