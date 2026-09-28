// iLink Bot API 客户端（2026-09-27 微信桥）：WeKnora internal/im/wechat 的 TS 移植。
// 协议事实源 = WeKnora-feat_MCP internal/im/wechat/{adapter,longpoll,qrcode}.go（iLink 无公开文档）。
// 形态：无 WebSocket、无 Webhook——出站长轮询收消息 + REST 发消息 + 扫码登录换 token；
// fetch 一律经 PlatformEnv 注入（零网络测试铁律）。

import type { PlatformEnv } from "../harness/index";

const ILINK_BASE = "https://ilinkai.weixin.qq.com";
/** 每次请求随 base_info 上报的通道版本（WeKnora 用 weknora-1.0.0，我们亮明身份） */
const CHANNEL_VERSION = "openprism-1.0.0";
/** get_bot_qrcode 的 bot_type（WeKnora 固定传 3） */
const BOT_TYPE = "3";
/** 扫码状态长轮询的服务端保持 ~35s；客户端超时稍长，超时按"继续等"处理（WeKnora 同款） */
const QR_POLL_TIMEOUT_MS = 38_000;

/** errcode -14：bot_token 失效，需重新扫码绑定 */
export class ILinkTokenExpiredError extends Error {
  constructor() {
    super("wechat bot token expired（errcode -14）");
    this.name = "ILinkTokenExpiredError";
  }
}

export interface ILinkCredentials {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
}

/** 收窄后的入站消息（首版只取文本面；图片/语音/文件留后续） */
export interface ILinkInboundMessage {
  messageId: string;
  fromUserId: string;
  /** 1=用户消息 2=bot 消息（自己发的，跳过） */
  messageType: number;
  text: string;
  /** 回复时原样回传，iLink 靠它关联对话上下文 */
  contextToken: string;
}

export interface ILinkClient {
  /** 申请登录二维码：qrcode = 轮询凭据，imgUrl = 二维码图片 URL（前端 <img> 直展示） */
  getBotQRCode(): Promise<{ qrcode: string; imgUrl: string }>;
  /** 扫码状态长轮询（~35s 一轮）；confirmed 时带凭据 */
  pollQRCodeStatus(qrcode: string): Promise<{ status: "wait" | "scaned" | "confirmed" | "expired"; creds?: ILinkCredentials }>;
  /** 拉一轮消息（35s 长轮询由服务端保持；返回用户文本消息与下一轮游标） */
  getUpdates(botToken: string, cursor: string): Promise<{ msgs: ILinkInboundMessage[]; nextCursor: string }>;
  /** 发文本消息（contextToken 可空 = 主动推送，如欢迎语/定时通知——可用性以真机实测为准） */
  sendMessage(botToken: string, toUserId: string, contextToken: string, text: string): Promise<void>;
}

export function createILinkClient(deps: { fetch: PlatformEnv["fetch"] }): ILinkClient {
  /** 随机 X-WECHAT-UIN：uint32 → 十进制串 → base64（WeKnora 同款） */
  const randomUin = (): string => {
    const n = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
    return Buffer.from(String(n), "utf8").toString("base64");
  };

  const request = async (path: string, init: { method: "GET" | "POST"; body?: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<unknown> => {
    const res = await deps.fetch(ILINK_BASE + path, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ilink ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  /** 业务调用统一头（AuthorizationType 固定 ilink_bot_token；Bearer 为登录/轮询凭据） */
  const authHeaders = (botToken: string, body?: string): Record<string, string> => ({
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    ...(botToken !== "" ? { Authorization: `Bearer ${botToken}` } : {}),
    "X-WECHAT-UIN": randomUin(),
    ...(body !== undefined ? { "Content-Length": String(body.length) } : {}),
  });

  return {
    async getBotQRCode() {
      const raw = (await request(`/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { method: "GET", headers: {} })) as {
        qrcode?: string;
        qrcode_img_content?: string;
      };
      if (!raw.qrcode) throw new Error(`ilink get_bot_qrcode 返回空 qrcode：${JSON.stringify(raw).slice(0, 200)}`);
      return { qrcode: raw.qrcode, imgUrl: raw.qrcode_img_content ?? "" };
    },

    async pollQRCodeStatus(qrcode) {
      let raw: Record<string, unknown>;
      try {
        raw = (await request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
          method: "GET",
          headers: { "iLink-App-ClientVersion": "1" },
          signal: AbortSignal.timeout(QR_POLL_TIMEOUT_MS),
        })) as Record<string, unknown>;
      } catch (error) {
        // 客户端超时对长轮询是常态：按「继续等」处理（WeKnora 同款）
        if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") return { status: "wait" as const };
        throw error;
      }
      const status = String(raw.status ?? "wait");
      if (status === "confirmed") {
        const creds: ILinkCredentials = {
          botToken: String(raw.bot_token ?? ""),
          ilinkBotId: String(raw.ilink_bot_id ?? ""),
          ilinkUserId: String(raw.ilink_user_id ?? ""),
        };
        if (creds.botToken === "" || creds.ilinkBotId === "" || creds.ilinkUserId === "") {
          throw new Error(`ilink get_qrcode_status confirmed 但凭据不全：${JSON.stringify(raw).slice(0, 200)}`);
        }
        return { status, creds };
      }
      if (status === "scaned" || status === "expired") return { status };
      return { status: "wait" as const };
    },

    async getUpdates(botToken, cursor) {
      const body = JSON.stringify({ get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } });
      const raw = (await request("/ilink/bot/getupdates", { method: "POST", body, headers: authHeaders(botToken, body) })) as {
        ret?: number;
        errcode?: number;
        errmsg?: string;
        msgs?: unknown[];
        get_updates_buf?: string;
      };
      if (raw.errcode === -14) throw new ILinkTokenExpiredError();
      if ((raw.ret ?? 0) !== 0 && (raw.errcode ?? 0) !== 0) {
        throw new Error(`ilink getupdates ret=${raw.ret} errcode=${raw.errcode}: ${String(raw.errmsg ?? "").slice(0, 200)}`);
      }
      const msgs: ILinkInboundMessage[] = [];
      for (const item of raw.msgs ?? []) {
        const msg = item as {
          message_id?: number | string;
          from_user_id?: string;
          message_type?: number;
          item_list?: { type?: number; text_item?: { text?: string } }[];
          context_token?: string;
        };
        if (msg.message_type === 2) continue; // bot 自己发的
        const textItem = msg.item_list?.find((i) => i.type === 1)?.text_item; // 首版只取文本
        const text = (textItem?.text ?? "").trim();
        if (text === "") continue;
        msgs.push({
          messageId: String(msg.message_id ?? ""),
          fromUserId: msg.from_user_id ?? "",
          messageType: msg.message_type ?? 1,
          text,
          contextToken: msg.context_token ?? "",
        });
      }
      return { msgs, nextCursor: raw.get_updates_buf ?? cursor };
    },

    async sendMessage(botToken, toUserId, contextToken, text) {
      const body = JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: `openprism_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          message_type: 2, // BOT
          message_state: 2, // FINISH
          item_list: [{ type: 1, text_item: { text } }], // TEXT
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      });
      await request("/ilink/bot/sendmessage", { method: "POST", body, headers: authHeaders(botToken, body) });
    },
  };
}
