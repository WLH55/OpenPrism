// 微信桥（2026-09-27）：iLink Bot 的绑定管理与消息路由。
// 职责：扫码凭据落库（主密钥加密）/ 长轮询收消息 / 消息进固定「微信对话」会话跑回合 /
// 回复推回微信 / token 过期（-14）停轮询并站内提醒 / 任务通知推送（pushToWechat）。
// 会话模型：cid = wechat:<uid>（置顶固定会话，web 端同步可见同一份日志）；非绑定微信用户的消息忽略。

import type { DatabaseSync } from "node:sqlite";
import type { PlatformEnv } from "../harness/index";
import type { ConversationStore } from "./conversations";
import type { NotificationStore } from "./notify";
import { open, seal } from "./secretbox";
import { createILinkClient, ILinkTokenExpiredError, type ILinkClient, type ILinkCredentials, type ILinkInboundMessage } from "./ilink";

export const WECHAT_FEED_CID = (uid: string): string => `wechat:${uid}`;
const WECHAT_FEED_TITLE = "微信对话";
/** 回复单条上限（防御性；iLink 无公开文档，WeKnora 通知侧截 500） */
const REPLY_MAX_CHARS = 4000;

interface WechatBindRow {
  uid: string;
  bot_token_enc: string;
  ilink_bot_id: string;
  ilink_user_id: string;
  state: "active" | "expired";
  bound_ts: number;
}

interface RuntimeState {
  stopped: boolean;
  cursor: string;
}

export interface WechatBridgeDeps {
  env: PlatformEnv;
  db: DatabaseSync;
  masterKey: Buffer;
  conversations: ConversationStore;
  notifications: NotificationStore;
  /** 退避等待（注入固定值保测试确定性；缺省真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  now?(): number;
}

export class WechatBridge {
  private client;
  private runners = new Map<string, RuntimeState>();
  private feedEnsured = new Set<string>();
  /** 申请中的登录二维码 → 归属用户（防他账号持码劫绑；confirmed/expired 即除名，弃扫残留一条可忽略） */
  private pendingQRCodes = new Map<string, string>();

  constructor(private deps: WechatBridgeDeps) {
    this.client = createILinkClient({ fetch: deps.env.fetch });
  }

  private now(): number {
    return this.deps.now?.() ?? this.deps.env.now();
  }

  // ── 绑定管理 ────────────────────────────────────────────

  private readBind(uid: string): (WechatBindRow & { botToken: string }) | null {
    const row = this.deps.db.prepare("SELECT * FROM wechat_binds WHERE uid = ?").get(uid) as unknown as WechatBindRow | undefined;
    if (!row) return null;
    return { ...row, botToken: open(this.deps.masterKey, row.bot_token_enc) };
  }

  /**
   * 落库绑定并启动轮询；随即发一条欢迎语（顺带验证「无 context_token 主动推送」是否被 iLink 接受——
   * 失败不影响绑定，主动推送可用性以真机为准）。opts.start = false 供测试手动驱动 pollOnce。
   */
  async bind(uid: string, creds: ILinkCredentials, opts?: { start?: boolean }): Promise<void> {
    this.deps.db
      .prepare(
        "INSERT INTO wechat_binds (uid, bot_token_enc, ilink_bot_id, ilink_user_id, state, bound_ts) VALUES (?, ?, ?, ?, 'active', ?) ON CONFLICT(uid) DO UPDATE SET bot_token_enc = excluded.bot_token_enc, ilink_bot_id = excluded.ilink_bot_id, ilink_user_id = excluded.ilink_user_id, state = 'active', bound_ts = excluded.bound_ts",
      )
      .run(uid, seal(this.deps.masterKey, creds.botToken), creds.ilinkBotId, creds.ilinkUserId, this.now());
    this.runners.set(uid, { stopped: false, cursor: "" });
    if (opts?.start !== false) this.startLoop(uid);
    // 欢迎语后台推：不 await（iLink 慢/挂不拖绑定闭环的路由响应，轮询也已先启）；
    // 无 context_token 的主动推送是否被接受属 Q5 实测项，失败不拦绑定
    void this.client
      .sendMessage(creds.botToken, creds.ilinkUserId, "", "绑定成功！以后直接在这里跟我说话就行；定时任务也可以选「微信机器人」通知到这里。")
      .catch(() => undefined);
  }

  async unbind(uid: string): Promise<void> {
    const runner = this.runners.get(uid);
    if (runner) runner.stopped = true;
    this.runners.delete(uid);
    this.feedEnsured.delete(uid);
    this.deps.db.prepare("DELETE FROM wechat_binds WHERE uid = ?").run(uid);
  }

  status(uid: string): { bound: boolean; state: "active" | "expired"; ilinkBotId?: string } {
    const bind = this.readBind(uid);
    if (!bind) return { bound: false, state: "active" };
    return { bound: true, state: bind.state, ilinkBotId: bind.ilink_bot_id };
  }

  /** 启动时装载全部 active 绑定（重启恢复轮询） */
  startAll(): void {
    const rows = this.deps.db.prepare("SELECT uid FROM wechat_binds WHERE state = 'active'").all() as unknown as { uid: string }[];
    for (const row of rows) {
      this.runners.set(row.uid, { stopped: false, cursor: "" });
      this.startLoop(row.uid);
    }
  }

  // ── 扫码登录（服务端路由代理用；申请与轮询绑定归属） ────

  /** 申请登录二维码并记录归属（status 轮询时校验，防他账号持 qrcode 劫绑） */
  async newQRCode(uid: string): Promise<{ qrcode: string; imgUrl: string }> {
    const qr = await this.client.getBotQRCode();
    this.pendingQRCodes.set(qr.qrcode, uid);
    return qr;
  }

  /** 轮询扫码状态；归属不符返回 null（路由 403）。confirmed/expired 用毕除名，防止已消费的码再被轮询。 */
  async pollQRStatus(uid: string, qrcode: string): Promise<Awaited<ReturnType<ILinkClient["pollQRCodeStatus"]>> | null> {
    if (this.pendingQRCodes.get(qrcode) !== uid) return null;
    const result = await this.client.pollQRCodeStatus(qrcode);
    if (result.status === "confirmed" || result.status === "expired") this.pendingQRCodes.delete(qrcode);
    return result;
  }

  // ── 消息轮询与处理 ──────────────────────────────────────

  /** 单轮拉取+处理（循环体；测试直接调用以确定性驱动）。-14 在此内部消化为过期落库。 */
  async pollOnce(uid: string): Promise<void> {
    const bind = this.readBind(uid);
    if (!bind || bind.state !== "active") return;
    const runner = this.runners.get(uid) ?? { stopped: false, cursor: "" };
    let batch: { msgs: ILinkInboundMessage[]; nextCursor: string };
    try {
      batch = await this.client.getUpdates(bind.botToken, runner.cursor);
    } catch (error) {
      if (error instanceof ILinkTokenExpiredError) {
        await this.expire(uid);
        return;
      }
      throw error;
    }
    runner.cursor = batch.nextCursor;
    for (const msg of batch.msgs) {
      await this.handle(uid, bind, msg);
    }
  }

  private startLoop(uid: string): void {
    const runner = this.runners.get(uid);
    if (runner) void this.loopInternal(uid, runner);
  }

  // 代数防护：循环持有启动时的 runner 对象引用，发现 map 里换成新对象（解绑/过期后重绑）或被标记停止即退场——
  // 否则「解绑 → 立即重绑」会留下两个并发循环（重复拉取、游标互踩）。在飞的那一轮 pollOnce 会自然跑完，下一轮检查即收口。
  private async loopInternal(uid: string, mine: RuntimeState): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let attempts = 0;
    for (;;) {
      if (this.runners.get(uid) !== mine || mine.stopped) return;
      try {
        await this.pollOnce(uid);
        attempts = 0;
      } catch (error) {
        if (this.runners.get(uid) !== mine || mine.stopped) return; // 解绑/过期/被取代收口
        attempts += 1;
        await sleep(Math.min(1000 * 2 ** (attempts - 1), 30_000));
      }
    }
  }

  /** 一条入站消息 → 会话回合 → 回复推回（串行：回合跑完才处理下一条/下一轮拉取，天然保序） */
  private async handle(uid: string, bind: WechatBindRow & { botToken: string }, msg: ILinkInboundMessage): Promise<void> {
    if (msg.fromUserId !== bind.ilink_user_id) return; // 非绑定微信用户：忽略（AC5）
    await this.ensureFeed(uid);
    const cid = WECHAT_FEED_CID(uid);
    const agent = await this.deps.conversations.agent(uid, cid);
    const before = agent.sessionLog.readAll().length;
    await this.deps.conversations.send(uid, cid, msg.text);
    await agent.whenIdle();
    const events = agent.sessionLog.readAll().slice(before);
    const reply = events
      .filter((event) => event.type === "assistant/message")
      .map((event) =>
        event.type === "assistant/message"
          ? event.message.content.filter((b) => b.type === "text").map((b) => (b as { text?: string }).text ?? "").join("")
          : "",
      )
      .filter((text) => text !== "")
      .join("\n\n");
    if (reply === "") return;
    try {
      await this.client.sendMessage(bind.botToken, msg.fromUserId, msg.contextToken, reply.slice(0, REPLY_MAX_CHARS));
    } catch {
      // 回复推送失败：回合已落日志，web 端可见；下一轮轮询照常（不因单条推送失败停摆）
    }
  }

  private async ensureFeed(uid: string): Promise<void> {
    if (this.feedEnsured.has(uid)) return;
    this.deps.db
      .prepare("INSERT OR IGNORE INTO conversations (cid, uid, title, pinned, created_ts) VALUES (?, ?, ?, 1, ?)")
      .run(WECHAT_FEED_CID(uid), uid, WECHAT_FEED_TITLE, this.now());
    this.feedEnsured.add(uid);
  }

  /** token 过期：落库 expired、停轮询、站内提醒重新扫码 */
  private async expire(uid: string): Promise<void> {
    const runner = this.runners.get(uid);
    if (runner) runner.stopped = true;
    this.runners.delete(uid);
    const result = this.deps.db.prepare("UPDATE wechat_binds SET state = 'expired' WHERE uid = ? AND state = 'active'").run(uid);
    if (result.changes === 0) return; // 已解绑/已标记：不重复提醒
    try {
      await this.deps.notifications.push(uid, {
        kind: "wechat_bind_expired",
        text: "微信机器人绑定已过期——到「IM 通道」页重新扫码即可恢复",
      });
    } catch {
      // 站内提醒尽力而为
    }
  }

  // ── 主动推送（任务通知） ────────────────────────────────

  /** 推文本到绑定微信；未绑定/过期/失败 → false（调用方静默退站内） */
  async pushToWechat(uid: string, text: string): Promise<boolean> {
    const bind = this.readBind(uid);
    if (!bind || bind.state !== "active") return false;
    try {
      await this.client.sendMessage(bind.botToken, bind.ilink_user_id, "", text.slice(0, 500));
      return true;
    } catch {
      return false;
    }
  }
}
