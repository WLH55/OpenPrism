// 微信桥入站媒体（2026-10-11）：iLink item_list 图片/文件/语音面 + CDN 下载解密 + 附件管线闭环。
// 零网络铁律：CDN 端点由 fake fetch 按前缀分发；密文用 node:crypto AES-128-ECB 在测试内确定性构造；LLM 走 mock adapter。

import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EnvFetchRequest, EnvFetchResponse, PlatformEnv } from "../src/harness/env";
import { buildCdnDownloadUrl, createILinkClient, type ILinkCredentials } from "../src/app/ilink";
import {
  decodeTextFile,
  decryptAes128Ecb,
  mediaTypeForFileName,
  parseAesKey,
  sniffImageType,
  WECHAT_DOWNLOAD_MAX_BYTES,
} from "../src/app/wechat-media";
import { WechatBridge, WECHAT_FEED_CID } from "../src/app/wechat-bridge";
import { ConversationStore } from "../src/app/conversations";
import { AgentStore } from "../src/app/agents";
import { SkillStore } from "../src/app/skills";
import { McpRegistry } from "../src/app/mcp";
import { MemoryStore } from "../src/app/memory";
import { TaskStore } from "../src/app/tasks";
import { NotificationStore } from "../src/app/notify";
import { SqliteSessionLog } from "../src/app/session-log";
import { Ledger } from "../src/app/ledger";
import { IMAGE_MAX_BYTES } from "../src/app/attachments";
import { createMockLlmAdapter, type LlmAdapter, type MockScriptStep } from "../src/harness/index";
import { testDb } from "./helpers-db";

const UID = "u-wxm";
const NOW = () => 67890;
const CREDS: ILinkCredentials = { botToken: "bot-token-1", ilinkBotId: "ib-1", ilinkUserId: "wxuser-1" };
const iLinkOk = { ret: 0, errcode: 0 };

// ── 测试侧加密：确定性构造 CDN 密文 ────────────────────────

const KEY = Buffer.from("0123456789abcdef", "utf8"); // 16 字节 = AES-128

const encryptEcb = (plain: Buffer, pad = true): Buffer => {
  const cipher = createCipheriv("aes-128-ecb", KEY, null);
  cipher.setAutoPadding(pad);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

// ── fake iLink（带二进制响应面） ──────────────────────────

interface RecordedCall {
  url: string;
  init?: EnvFetchRequest;
}

function fakeILink() {
  const calls: RecordedCall[] = [];
  const handlers: { match: (url: string) => boolean; respond: (call: RecordedCall) => Promise<unknown> | unknown }[] = [];
  const fetch = async (url: string, init?: EnvFetchRequest): Promise<EnvFetchResponse> => {
    const call = { url, init };
    calls.push(call);
    for (let i = handlers.length - 1; i >= 0; i--) {
      const handler = handlers[i]!;
      if (!handler.match(url)) continue;
      const result = await handler.respond(call);
      if (result instanceof Error) throw result;
      const status = (result as { __status?: number }).__status ?? 200;
      const bytes = (result as { __bytes?: Uint8Array }).__bytes;
      if (bytes !== undefined) {
        const copy = Buffer.from(bytes);
        return {
          ok: status < 300,
          status,
          headers: { get: () => null },
          json: async () => ({}),
          text: async () => "",
          arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
        };
      }
      const body = typeof result === "string" ? result : JSON.stringify(result);
      return { ok: status < 300, status, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body };
    }
    throw new Error(`fake iLink: no handler for ${url}`);
  };
  return {
    calls,
    fetch,
    on: (match: (url: string) => boolean, respond: (call: RecordedCall) => Promise<unknown> | unknown) => handlers.push({ match, respond }),
  };
}

const envOf = (fetch: PlatformEnv["fetch"]): PlatformEnv => ({ fetch, now: NOW, randomUUID: () => "uuid-wxm" });

// ── 桥级装配（默认多模态模型；可关闭测 AC5 非多模态路径） ──

function makeFixture(script: MockScriptStep[], opts?: { multimodal?: boolean }) {
  const db = testDb();
  const mock = createMockLlmAdapter(script);
  const ledgers = new Map<string, Promise<Ledger>>();
  const ledgerFor = (uid: string): Promise<Ledger> => {
    let ledger = ledgers.get(uid);
    if (!ledger) {
      ledger = Ledger.open(db, uid);
      ledgers.set(uid, ledger);
    }
    return ledger;
  };
  const agents = new AgentStore({ db, now: NOW, randomUUID: () => "aid-wxm" });
  const skills = new SkillStore({ db, now: NOW, randomUUID: () => "skid-wxm" });
  const mcps = new McpRegistry({ env: envOf(async () => { throw new Error("no network"); }), db, now: NOW, randomUUID: () => "mc-wxm" });
  const memory = new MemoryStore({ db, now: NOW, randomUUID: () => "mid-wxm" });
  const tasks = new TaskStore({ db, now: NOW, randomUUID: () => "tid-wxm" });
  const conversations = new ConversationStore(
    {
      env: envOf(async () => { throw new Error("no network"); }),
      sessionLog: (key: string) => Promise.resolve(SqliteSessionLog.open(db, key, NOW)),
      ledgerFor,
      modelConfigFor: async () => ({ baseURL: "https://mock.local", model: "mock-1", ...(opts?.multimodal === false ? {} : { multimodal: true }) }),
      adapterFactory: () => mock.adapter as LlmAdapter,
      now: NOW,
      agents,
      skills,
      // 技能包文件访问面（测试注入空实现：这些用例不触包文件）
      skillFiles: { list: () => [], read: () => { throw new Error("测试不读包文件"); } },
      mcps,
      memory,
      tasks,
    },
    db,
  );
  const notifications = new NotificationStore({ db, now: NOW });
  const iLink = fakeILink();
  const masterKey = Buffer.alloc(32, 7);
  // 聚合窗口（2026-10-17 多图识别）：schedule 收集到期回调不真跑；fireAggregate 手动放行窗口 + 等回合链排空
  const scheduledFns: Array<() => void> = [];
  const bridge = new WechatBridge({
    env: envOf(iLink.fetch),
    db,
    masterKey,
    conversations,
    notifications,
    now: NOW,
    schedule: (fn) => {
      scheduledFns.push(fn);
      return () => {
        const at = scheduledFns.indexOf(fn);
        if (at >= 0) scheduledFns.splice(at, 1);
      };
    },
  });
  const fireAggregate = async () => {
    const fns = scheduledFns.splice(0);
    for (const fn of fns) fn();
    await bridge.idle(UID);
  };
  return { db, mock, conversations, notifications, iLink, bridge, masterKey, fireAggregate };
}

const bindActive = async (fixture: ReturnType<typeof makeFixture>) => {
  await fixture.bridge.bind(UID, CREDS, { start: false });
};

// ── 装载脚手架：getupdates / CDN / sendmessage 常用响应 ────

const onUpdates = (fixture: ReturnType<typeof makeFixture>, msgs: unknown[]) => {
  fixture.iLink.on(
    (url) => url.endsWith("/ilink/bot/getupdates"),
    () => ({ ret: 0, errcode: 0, get_updates_buf: "cur-next", msgs }),
  );
};
const onCdn = (fixture: ReturnType<typeof makeFixture>, bytes: Uint8Array) => {
  fixture.iLink.on((url) => url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/download"), () => ({ __bytes: bytes }));
};
const onSendOk = (fixture: ReturnType<typeof makeFixture>) => {
  fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
};
const sentTexts = (fixture: ReturnType<typeof makeFixture>): string[] =>
  fixture.iLink.calls
    .filter((c) => c.url.endsWith("/ilink/bot/sendmessage") && (c.init?.body ?? "").includes("context_token"))
    .map((c) => JSON.parse(c.init?.body ?? "{}").msg.item_list[0].text_item.text as string);

const imageMsg = (id: number, eqp: string, aeskey: string, extraText = "") => ({
  message_id: id,
  from_user_id: "wxuser-1",
  message_type: 1,
  item_list: [
    ...(extraText !== "" ? [{ type: 1, text_item: { text: extraText } }] : []),
    { type: 2, image_item: { media: { encrypt_query_param: eqp, aes_key: "" }, aeskey } },
  ],
  context_token: `ctx-${id}`,
});

// ══════════════════════════════════════════════════════════
// wechat-media 纯函数
// ══════════════════════════════════════════════════════════

describe("wechat-media：parseAesKey（三格式探测）", () => {
  it("hex 32 字符 → 16 字节", () => {
    expect(parseAesKey(KEY.toString("hex"))).toEqual(KEY);
  });
  it("base64(16 裸字节) → 直接用", () => {
    expect(parseAesKey(KEY.toString("base64"))).toEqual(KEY);
  });
  it("base64(32 位 hex ASCII) → 二次 hex 解码", () => {
    expect(parseAesKey(Buffer.from(KEY.toString("hex"), "utf8").toString("base64"))).toEqual(KEY);
  });
  it("空串 / 无法解析 → 抛错", () => {
    expect(() => parseAesKey("")).toThrow();
    expect(() => parseAesKey("z!!!not-a-key!!!")).toThrow(/无法解析|长度/);
  });
});

describe("wechat-media：decryptAes128Ecb（容错 PKCS#7）", () => {
  it("带 padding（Node 默认加密）→ 剥离后还原", () => {
    const plain = Buffer.from("你好，媒体消息！", "utf8"); // 非 16 对齐 → padding 必然存在
    expect(decryptAes128Ecb(encryptEcb(plain), KEY)).toEqual(plain);
  });
  it("无 padding（明文恰为 16 倍数、setAutoPadding(false) 加密）→ 原样还原不误剥", () => {
    const plain = Buffer.from("0123456789abcdef0123456789abcdef", "utf8"); // 32 字节
    expect(decryptAes128Ecb(encryptEcb(plain, false), KEY)).toEqual(plain);
  });
  it("密文长度非 16 倍数 → 抛错", () => {
    expect(() => decryptAes128Ecb(new Uint8Array(3), KEY)).toThrow(/16 的倍数/);
    expect(() => decryptAes128Ecb(new Uint8Array(0), KEY)).toThrow();
  });
});

describe("wechat-media：sniffImageType（magic bytes）", () => {
  it("PNG / JPEG / GIF / WebP 四格式", () => {
    expect(sniffImageType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a\x01\x02\x03\x04", "latin1"))).toBe("image/gif");
    expect(sniffImageType(Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1"), Buffer.alloc(8)]))).toBe("image/webp");
  });
  it("未知格式（含错误 key 解出的乱码）→ null", () => {
    expect(sniffImageType(Buffer.alloc(64, 0xab))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe("wechat-media：decodeTextFile / mediaTypeForFileName", () => {
  it("UTF-8 文本（含中文）→ ok", () => {
    const text = "第一行：计划\nsecond line";
    expect(decodeTextFile(Buffer.from(text, "utf8"))).toEqual({ ok: true, text });
  });
  it("NUL 字节 / 非法 UTF-8 序列 → 判二进制", () => {
    expect(decodeTextFile(Buffer.concat([Buffer.from("abc"), Buffer.from([0]), Buffer.from("def")]))).toEqual({ ok: false });
    expect(decodeTextFile(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]))).toEqual({ ok: false });
  });
  it("扩展名 → MIME（未知一律 text/plain）", () => {
    expect(mediaTypeForFileName("笔记.md")).toBe("text/markdown");
    expect(mediaTypeForFileName("data.CSV")).toBe("text/csv");
    expect(mediaTypeForFileName("conf.json")).toBe("application/json");
    expect(mediaTypeForFileName("noext")).toBe("text/plain");
    expect(mediaTypeForFileName(undefined)).toBe("text/plain");
  });
});

// ══════════════════════════════════════════════════════════
// iLink 客户端：媒体解析面 + CDN 下载
// ══════════════════════════════════════════════════════════

describe("iLink 客户端（媒体面）", () => {
  it("getUpdates：图片（顶层 aeskey hex 优先）/ 文件（media.aes_key base64 + file_name + len）/ 语音转写 / 视频 / 混排 / 纯媒体不丢", async () => {
    const iLink = fakeILink();
    iLink.on(
      (url) => url.endsWith("/ilink/bot/getupdates"),
      () => ({
        ret: 0,
        errcode: 0,
        get_updates_buf: "c2",
        msgs: [
          { message_id: 1, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "eqp-img", aes_key: "SHOULD-NOT-WIN==" }, aeskey: KEY.toString("hex") } }], context_token: "ctx-1" },
          { message_id: 2, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 4, file_item: { media: { encrypt_query_param: "eqp-file", aes_key: KEY.toString("base64") }, file_name: "笔记.md", len: "128" } }], context_token: "ctx-2" },
          { message_id: 3, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: "eqp-voice" }, text: " 跑了五公里 " } }], context_token: "ctx-3" },
          { message_id: 4, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 3, voice_item: { media: {}, text: "" } }], context_token: "ctx-4" },
          { message_id: 5, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 5 }], context_token: "ctx-5" },
          { message_id: 6, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: "看这张图" } }, { type: 2, image_item: { media: { encrypt_query_param: "eqp-mix", aes_key: KEY.toString("base64") } } }], context_token: "ctx-6" },
          { message_id: 7, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: "" } }], context_token: "ctx-7" },
          { message_id: 8, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 2, image_item: { media: {} } }], context_token: "ctx-8" },
        ],
      }),
    );
    const { msgs } = await createILinkClient({ fetch: iLink.fetch }).getUpdates("t", "");
    expect(msgs).toEqual([
      { messageId: "1", fromUserId: "wxuser-1", messageType: 1, text: "", media: [{ kind: "image", encryptQueryParam: "eqp-img", aesKeyRaw: KEY.toString("hex") }], contextToken: "ctx-1" },
      { messageId: "2", fromUserId: "wxuser-1", messageType: 1, text: "", media: [{ kind: "file", encryptQueryParam: "eqp-file", aesKeyRaw: KEY.toString("base64"), fileName: "笔记.md", sizeBytes: 128 }], contextToken: "ctx-2" },
      { messageId: "3", fromUserId: "wxuser-1", messageType: 1, text: "", media: [{ kind: "voice", encryptQueryParam: "eqp-voice", aesKeyRaw: "", voiceText: "跑了五公里" }], contextToken: "ctx-3" },
      { messageId: "4", fromUserId: "wxuser-1", messageType: 1, text: "", media: [{ kind: "voice", encryptQueryParam: "", aesKeyRaw: "", voiceText: "" }], contextToken: "ctx-4" },
      { messageId: "6", fromUserId: "wxuser-1", messageType: 1, text: "看这张图", media: [{ kind: "image", encryptQueryParam: "eqp-mix", aesKeyRaw: KEY.toString("base64") }], contextToken: "ctx-6" },
    ]);
  });

  it("buildCdnDownloadUrl：encodeURIComponent 转义", () => {
    expect(buildCdnDownloadUrl("a b&c=d")).toBe("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=" + encodeURIComponent("a b&c=d"));
  });

  it("downloadMedia：二进制透传；非 200 抛错；响应缺 arrayBuffer 抛错", async () => {
    const ok = fakeILink();
    ok.on((url) => url.startsWith("https://novac2c"), () => ({ __bytes: PNG_BYTES }));
    const bytes = await createILinkClient({ fetch: ok.fetch }).downloadMedia("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x");
    expect(Buffer.from(bytes)).toEqual(PNG_BYTES);

    const fail = fakeILink();
    fail.on((url) => url.startsWith("https://novac2c"), () => ({ __status: 500 }));
    await expect(createILinkClient({ fetch: fail.fetch }).downloadMedia("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x")).rejects.toThrow("HTTP 500");

    const noBin = fakeILink();
    noBin.on((url) => url.startsWith("https://novac2c"), () => ({ ok: true }));
    await expect(createILinkClient({ fetch: noBin.fetch }).downloadMedia("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x")).rejects.toThrow(/arrayBuffer/);
  });
});

// ══════════════════════════════════════════════════════════
// 微信桥媒体闭环（AC1–AC5）
// ══════════════════════════════════════════════════════════

describe("微信桥媒体闭环", () => {
  it("AC1 图片：CDN 下载 → AES 解密 → ImageBlock 进回合（LLM 收到 image 块）→ 回复带本条 context_token；CDN URL 转义正确", async () => {
    const fixture = makeFixture([{ kind: "text", text: "看到图了。" }]);
    onSendOk(fixture);
    onUpdates(fixture, [imageMsg(31, "eqp img/1&x", KEY.toString("hex"))]);
    onCdn(fixture, encryptEcb(PNG_BYTES));
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);
    // 纯图片消息进聚合窗口（2026-10-17 多图识别）：手动放行窗口到期
    await fixture.fireAggregate();

    // CDN 请求 URL：encrypt_query_param 经 encodeURIComponent
    const cdnCall = fixture.iLink.calls.find((c) => c.url.startsWith("https://novac2c"))!;
    expect(cdnCall.url).toBe(buildCdnDownloadUrl("eqp img/1&x"));
    expect(cdnCall.init?.headers?.Authorization).toBeUndefined(); // CDN 裸 GET（WeKnora 同款）

    // LLM 收到 image 块（base64 = 解密后的 PNG）
    const lastRequest = fixture.mock.requests.at(-1)!;
    const userMessage = lastRequest.messages.filter((m) => m.role === "user").at(-1)!;
    expect(userMessage.content[0]!.type === "text" && userMessage.content[0]!.text.includes("〔系统上下文〕")).toBe(true); // 回合上下文注入块（2026-10-14）
    expect(userMessage.content.slice(1)).toEqual([{ type: "image", mediaType: "image/png", data: PNG_BYTES.toString("base64") }]);

    // 会话日志落 ImageBlock（model-visible 不变量：web 同会话可见）
    const events = fixture.db.prepare("SELECT event_json FROM conversation_events WHERE cid = ?").all(WECHAT_FEED_CID(UID)) as unknown as { event_json: string }[];
    expect(events.some((e) => e.event_json.includes('"type":"image"') && e.event_json.includes("image/png"))).toBe(true);

    // 回复推回微信，挂本条 context_token
    const reply = fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage")).at(-1)!;
    expect(JSON.parse(reply.init?.body ?? "{}").msg).toMatchObject({ to_user_id: "wxuser-1", context_token: "ctx-31" });
    expect(sentTexts(fixture).at(-1)).toBe("看到图了。");
  });

  it("AC1 混排：文本 + 图片 → 一次回合、text 块与 image 块并存", async () => {
    const fixture = makeFixture([{ kind: "text", text: "混排收到。" }]);
    onSendOk(fixture);
    onUpdates(fixture, [imageMsg(32, "eqp-mix", KEY.toString("hex"), "看这张图")]);
    onCdn(fixture, encryptEcb(JPEG_BYTES));
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.mock.requests.length).toBe(1);
    const userMessage = fixture.mock.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    expect(userMessage.content[0]!.type === "text" && userMessage.content[0]!.text.includes("〔系统上下文〕")).toBe(true);
    expect(userMessage.content.slice(1)).toEqual([
      { type: "text", text: "看这张图" },
      { type: "image", mediaType: "image/jpeg", data: JPEG_BYTES.toString("base64") },
    ]);
    expect(sentTexts(fixture).at(-1)).toBe("混排收到。");
  });

  it("AC2 文本文件：下载解密 → FileBlock 内联正文（文件名 + MIME）", async () => {
    const fixture = makeFixture([{ kind: "text", text: "文件读到了。" }]);
    onSendOk(fixture);
    onUpdates(fixture, [
      { message_id: 33, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 4, file_item: { media: { encrypt_query_param: "eqp-f", aes_key: KEY.toString("base64") }, file_name: "笔记.md", len: "64" } }], context_token: "ctx-33" },
    ]);
    onCdn(fixture, encryptEcb(Buffer.from("# 标题\n正文内容", "utf8")));
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);
    // 纯文件消息同样进聚合窗口：手动放行
    await fixture.fireAggregate();

    const userMessage = fixture.mock.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    expect(userMessage.content[0]!.type === "text" && userMessage.content[0]!.text.includes("〔系统上下文〕")).toBe(true);
    expect(userMessage.content.slice(1)).toEqual([{ type: "file", name: "笔记.md", mediaType: "text/markdown", text: "# 标题\n正文内容" }]);
  });

  it("AC2b 二进制文件：不跑回合，push「只支持文本类文件」说明（LLM 零调用）", async () => {
    const fixture = makeFixture([]);
    onSendOk(fixture);
    onUpdates(fixture, [
      { message_id: 34, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 4, file_item: { media: { encrypt_query_param: "eqp-bin", aes_key: KEY.toString("base64") }, file_name: "报表.xlsx", len: "8" } }], context_token: "ctx-34" },
    ]);
    onCdn(fixture, encryptEcb(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from([0, 1, 2, 3])]))); // zip 头 + NUL
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.mock.requests.length).toBe(0);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE cid = ?").get(WECHAT_FEED_CID(UID))).toMatchObject({ n: 0 });
    expect(sentTexts(fixture).at(-1)).toContain("二进制");
    expect(sentTexts(fixture).at(-1)).toContain("报表.xlsx");
  });

  it("AC3 语音带转写：按文本进回合（不下载音频——CDN 零调用）", async () => {
    const fixture = makeFixture([{ kind: "text", text: "语音收到。" }]);
    onSendOk(fixture);
    onUpdates(fixture, [
      { message_id: 35, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: "eqp-v", aes_key: KEY.toString("base64") }, text: " 今天跑步五公里 " } }], context_token: "ctx-35" },
    ]);
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.iLink.calls.some((c) => c.url.startsWith("https://novac2c"))).toBe(false);
    const userMessage = fixture.mock.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    expect(userMessage.content[0]!.type === "text" && userMessage.content[0]!.text.includes("〔系统上下文〕")).toBe(true);
    expect(userMessage.content.slice(1)).toEqual([{ type: "text", text: "今天跑步五公里" }]);
    expect(sentTexts(fixture).at(-1)).toBe("语音收到。");
  });

  it("AC3b 语音空转写：刷上下文锚 + push 转写失败说明，不跑回合", async () => {
    const fixture = makeFixture([]);
    onSendOk(fixture);
    onUpdates(fixture, [
      { message_id: 36, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 3, voice_item: { media: {}, text: "" } }], context_token: "ctx-36" },
    ]);
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.mock.requests.length).toBe(0);
    const bind = fixture.db.prepare("SELECT last_context_token, last_msg_ts FROM wechat_binds WHERE uid = ?").get(UID) as unknown as { last_context_token: string; last_msg_ts: number };
    expect(bind.last_context_token).toBe("ctx-36");
    expect(bind.last_msg_ts).toBe(NOW());
    expect(sentTexts(fixture).at(-1)).toContain("转写");
  });

  it("AC5 CDN 下载失败：说明性 push + 同批后续文本消息照常跑完（不毒丸）+ 锚照刷（AC4）", async () => {
    const fixture = makeFixture([{ kind: "text", text: "后续消息的回复。" }]);
    onSendOk(fixture);
    fixture.iLink.on((url) => url.startsWith("https://novac2c"), () => ({ __status: 500 }));
    onUpdates(fixture, [imageMsg(37, "eqp-x", KEY.toString("hex")), { message_id: 38, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: "第二条消息" } }], context_token: "ctx-38" }]);
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID); // 若媒体失败被上抛，这里会 reject 或第二条不被处理

    const bind = fixture.db.prepare("SELECT last_context_token FROM wechat_binds WHERE uid = ?").get(UID) as unknown as { last_context_token: string };
    expect(bind.last_context_token).toBe("ctx-38"); // 两条都刷过锚（后一条覆盖）
    const texts = sentTexts(fixture);
    expect(texts.some((t) => t.includes("下载失败"))).toBe(true);
    expect(texts.at(-1)).toBe("后续消息的回复。");
  });

  it("AC5 解密失败（密文长度非 16 倍数，如 CDN 返回错误页）：说明性 push，不跑回合", async () => {
    const fixture = makeFixture([]);
    onSendOk(fixture);
    onUpdates(fixture, [imageMsg(39, "eqp-bad", KEY.toString("hex"))]);
    onCdn(fixture, Buffer.from("not-encrypted", "utf8")); // 12 字节
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.mock.requests.length).toBe(0);
    expect(sentTexts(fixture).at(-1)).toContain("解密失败");
  });

  it("AC5 图片超过 6MB：说明性 push，不跑回合", async () => {
    const fixture = makeFixture([]);
    onSendOk(fixture);
    onUpdates(fixture, [imageMsg(40, "eqp-big", KEY.toString("hex"))]);
    onCdn(fixture, encryptEcb(Buffer.concat([PNG_BYTES, Buffer.alloc(IMAGE_MAX_BYTES - PNG_BYTES.length + 16, 1)]), false)); // 长度 16 对齐且 > 6MB
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.mock.requests.length).toBe(0);
    expect(sentTexts(fixture).at(-1)).toContain("6MB");
  });

  it("AC5 file_item.len 预检超限：不发起 CDN 下载即说明", async () => {
    const fixture = makeFixture([]);
    onSendOk(fixture);
    onUpdates(fixture, [
      { message_id: 41, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 4, file_item: { media: { encrypt_query_param: "eqp-huge", aes_key: KEY.toString("base64") }, file_name: "大文件.zip", len: String(WECHAT_DOWNLOAD_MAX_BYTES + 1) } }], context_token: "ctx-41" },
    ]);
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    expect(fixture.iLink.calls.some((c) => c.url.startsWith("https://novac2c"))).toBe(false);
    expect(fixture.mock.requests.length).toBe(0);
    expect(sentTexts(fixture).at(-1)).toContain("大文件.zip");
  });

  it("AC5 模型非多模态：不跑回合、push 换模型指引；pollOnce 正常返回（不进轮询退避）", async () => {
    const fixture = makeFixture([], { multimodal: false });
    onSendOk(fixture);
    onUpdates(fixture, [imageMsg(42, "eqp-nmm", KEY.toString("hex"))]);
    onCdn(fixture, encryptEcb(PNG_BYTES));
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);
    // 纯图片进聚合窗口：放行后 flush → 回合内多模态拦截 → push 指引（不进轮询退避）
    await fixture.fireAggregate();

    expect(fixture.mock.requests.length).toBe(0);
    expect(sentTexts(fixture).at(-1)).toContain("不支持看图");
    const bind = fixture.db.prepare("SELECT last_context_token FROM wechat_binds WHERE uid = ?").get(UID) as unknown as { last_context_token: string };
    expect(bind.last_context_token).toBe("ctx-42");
  });

  it("AC4 纯图片消息刷新上下文锚（保活）：下载失败也照刷", async () => {
    const fixture = makeFixture([]);
    onSendOk(fixture);
    fixture.iLink.on((url) => url.startsWith("https://novac2c"), () => ({ __status: 503 }));
    onUpdates(fixture, [imageMsg(43, "eqp-keep", KEY.toString("hex"))]);
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    const bind = fixture.db.prepare("SELECT last_context_token, last_msg_ts FROM wechat_binds WHERE uid = ?").get(UID) as unknown as { last_context_token: string; last_msg_ts: number };
    expect(bind.last_context_token).toBe("ctx-43");
    expect(bind.last_msg_ts).toBe(NOW());
  });

  it("AC6 聚合窗口：连发两张纯图（同批两条消息）→ 窗口到期合并为单回合（单条 user/message 携两图、单次回复、挂最后一条 token）", async () => {
    const fixture = makeFixture([{ kind: "text", text: "两张都看到了。" }]);
    onSendOk(fixture);
    // 两条独立图片消息（iLink 一图一消息）：不同 CDN 密文给不同图，避免内容寻址去重掩盖张数
    fixture.iLink.on((url) => url.endsWith("/c2c/download?encrypted_query_param=a"), () => ({ __bytes: encryptEcb(PNG_BYTES) }));
    fixture.iLink.on((url) => url.endsWith("/c2c/download?encrypted_query_param=b"), () => ({ __bytes: encryptEcb(JPEG_BYTES) }));
    onUpdates(fixture, [imageMsg(44, "a", KEY.toString("hex")), imageMsg(45, "b", KEY.toString("hex"))]);
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    // 窗口内：零 LLM 请求（攒批中，不逐张开回合）
    expect(fixture.mock.requests.length).toBe(0);
    await fixture.fireAggregate();

    // 单回合：一次 LLM 请求，user 消息带两图（回填后 wire 形态）
    expect(fixture.mock.requests.length).toBe(1);
    const userMessage = fixture.mock.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    const images = userMessage.content.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(images.map((b) => (b as { mediaType: string }).mediaType).sort()).toEqual(["image/jpeg", "image/png"]);

    // 会话日志单条 user/message（两张图在一条事件里）
    const rows = fixture.db.prepare("SELECT event_json FROM conversation_events WHERE cid = ? AND type = 'user/message'").all(WECHAT_FEED_CID(UID)) as unknown as { event_json: string }[];
    expect(rows).toHaveLength(1);
    const imageBlocks = (JSON.parse(rows[0]!.event_json) as { message: { content: Array<Record<string, unknown>> } }).message.content.filter((b) => b["type"] === "image");
    expect(imageBlocks).toHaveLength(2);
    // 引用形态落库（2026-10-17 媒体膨胀治理）：有 blobRef 无 data
    for (const block of imageBlocks) {
      expect(typeof block["blobRef"]).toBe("string");
      expect(block["data"]).toBeUndefined();
    }

    // 单次回复，挂最后一条消息的 context_token
    expect(sentTexts(fixture).at(-1)).toBe("两张都看到了。");
    const reply = fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage")).at(-1)!;
    expect(JSON.parse(reply.init?.body ?? "{}").msg).toMatchObject({ context_token: "ctx-45" });
  });

  it("AC6b 聚合窗口：图后补文本 → 文本触发立即合并同回合（不等窗口）", async () => {
    const fixture = makeFixture([{ kind: "text", text: "图文一起收到。" }]);
    onSendOk(fixture);
    onUpdates(fixture, [imageMsg(46, "c", KEY.toString("hex")), { message_id: 47, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: "这图什么意思" } }], context_token: "ctx-47" }]);
    fixture.iLink.on((url) => url.endsWith("/c2c/download?encrypted_query_param=c"), () => ({ __bytes: encryptEcb(PNG_BYTES) }));
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    // 文本消息到达即触发：pollOnce 返回时回合已跑完（未 fireAggregate）
    expect(fixture.mock.requests.length).toBe(1);
    const userMessage = fixture.mock.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    expect(userMessage.content.some((b) => b.type === "text" && b.text === "这图什么意思")).toBe(true);
    expect(userMessage.content.some((b) => b.type === "image")).toBe(true);
    expect(sentTexts(fixture).at(-1)).toBe("图文一起收到。");
    const reply = fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage")).at(-1)!;
    expect(JSON.parse(reply.init?.body ?? "{}").msg).toMatchObject({ context_token: "ctx-47" });
  });

  it("AC6c 聚合上限：攒满 9 项即发（不等窗口到期；评审 m6 补测）", async () => {
    const fixture = makeFixture([{ kind: "text", text: "收到九连发。" }]);
    onSendOk(fixture);
    fixture.iLink.on((url) => url.endsWith("/c2c/download?encrypted_query_param=cap"), () => ({ __bytes: encryptEcb(PNG_BYTES) }));
    onUpdates(fixture, Array.from({ length: 9 }, (_, i) => imageMsg(50 + i, "cap", KEY.toString("hex"))));
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    // 未放行窗口（fireAggregate 未调）：上限即发路径在 pollOnce 内完成——单回合单请求九图
    expect(fixture.mock.requests.length).toBe(1);
    const userMessage = fixture.mock.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    expect(userMessage.content.filter((b) => b.type === "image")).toHaveLength(9);
    expect(sentTexts(fixture).at(-1)).toBe("收到九连发。");
    const reply = fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage")).at(-1)!;
    expect(JSON.parse(reply.init?.body ?? "{}").msg).toMatchObject({ context_token: "ctx-58" });
  });
});
