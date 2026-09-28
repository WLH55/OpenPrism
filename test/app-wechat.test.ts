// 微信桥（2026-09-27）：iLink 客户端协议 + WechatBridge 绑定/对话闭环/越权/过期/推送/重启装载。
// 零网络铁律：iLink 端点全部由 fake fetch 按 URL 分发脚本响应；LLM 走 mock adapter。

import { describe, expect, it } from "vitest";
import type { EnvFetchRequest, EnvFetchResponse, PlatformEnv } from "../src/harness/env";
import { createILinkClient, ILinkTokenExpiredError, type ILinkCredentials } from "../src/app/ilink";
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
import { createMockLlmAdapter, type LlmAdapter, type MockScriptStep } from "../src/harness/index";
import { testDb } from "./helpers-db";
import { deferred } from "./helpers";

const UID = "u-wx";
const NOW = () => 12345;
const CREDS: ILinkCredentials = { botToken: "bot-token-1", ilinkBotId: "ib-1", ilinkUserId: "wxuser-1" };

// ── fake iLink：按 URL 前缀分发脚本响应 ──────────────────

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
    // 后注册优先（测试里"覆盖"语义：先铺默认响应，再按需改写个别端点）
    for (let i = handlers.length - 1; i >= 0; i--) {
      const handler = handlers[i]!;
      if (!handler.match(url)) continue;
      const result = await handler.respond(call);
      if (result instanceof Error) throw result;
      const status = (result as { __status?: number }).__status ?? 200;
      const body = typeof result === "string" ? result : JSON.stringify(result);
      return {
        ok: status < 300,
        status,
        headers: { get: () => null },
        json: async () => JSON.parse(body),
        text: async () => body,
      };
    }
    throw new Error(`fake iLink: no handler for ${url}`);
  };
  return {
    calls,
    fetch,
    on: (match: (url: string) => boolean, respond: (call: RecordedCall) => Promise<unknown> | unknown) => handlers.push({ match, respond }),
  };
}

const envOf = (fetch: PlatformEnv["fetch"]): PlatformEnv => ({ fetch, now: NOW, randomUUID: () => "uuid-wx" });

// ── 桥级装配：真实 ConversationStore/NotificationStore + mock LLM + fake iLink ──

function makeFixture(script: MockScriptStep[]) {
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
  const agents = new AgentStore({ db, now: NOW, randomUUID: () => "aid-wx" });
  const skills = new SkillStore({ db, now: NOW, randomUUID: () => "skid-wx" });
  const mcps = new McpRegistry({ env: envOf(async () => { throw new Error("no network"); }), db, now: NOW, randomUUID: () => "mc-wx" });
  const memory = new MemoryStore({ db, now: NOW, randomUUID: () => "mid-wx" });
  const tasks = new TaskStore({ db, now: NOW, randomUUID: () => "tid-wx" });
  const conversations = new ConversationStore(
    {
      env: envOf(async () => { throw new Error("no network"); }),
      sessionLog: (key: string) => Promise.resolve(SqliteSessionLog.open(db, key, NOW)),
      ledgerFor,
      modelConfigFor: async () => ({ baseURL: "https://mock.local", model: "mock-1" }),
      adapterFactory: () => mock.adapter as LlmAdapter,
      now: NOW,
      agents,
      skills,
      mcps,
      memory,
      tasks,
    },
    db,
  );
  const notifications = new NotificationStore({ db, now: NOW });
  const iLink = fakeILink();
  const masterKey = Buffer.alloc(32, 7);
  const bridge = new WechatBridge({ env: envOf(iLink.fetch), db, masterKey, conversations, notifications, now: NOW });
  return { db, mock, conversations, notifications, iLink, bridge, masterKey };
}

const bindActive = async (fixture: ReturnType<typeof makeFixture>) => {
  await fixture.bridge.bind(UID, CREDS, { start: false });
};

const iLinkOk = { ret: 0, errcode: 0 };

describe("iLink 客户端（协议面）", () => {
  it("getUpdates：头协议（AuthorizationType/Bearer）+ 游标推进 + 用户文本提取（bot 消息与空文本跳过）", async () => {
    const iLink = fakeILink();
    iLink.on(
      (url) => url.endsWith("/ilink/bot/getupdates"),
      () => ({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          { message_id: 11, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: " 记一下跑步 30 分钟 " } }], context_token: "ctx-1" },
          { message_id: 12, from_user_id: "wxuser-1", message_type: 2, item_list: [{ type: 1, text_item: { text: "bot 自己的" } }], context_token: "" },
          { message_id: 13, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "x" } } }], context_token: "" },
        ],
      }),
    );
    const client = createILinkClient({ fetch: iLink.fetch });
    const { msgs, nextCursor } = await client.getUpdates("tok-1", "cursor-1");
    expect(msgs).toEqual([{ messageId: "11", fromUserId: "wxuser-1", messageType: 1, text: "记一下跑步 30 分钟", contextToken: "ctx-1" }]);
    expect(nextCursor).toBe("cursor-2");
    const call = iLink.calls.find((c) => c.url.endsWith("/ilink/bot/getupdates"))!;
    expect(call.init?.headers?.AuthorizationType).toBe("ilink_bot_token");
    expect(call.init?.headers?.Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(call.init?.body ?? "{}")).toMatchObject({ get_updates_buf: "cursor-1" });
  });

  it("errcode -14 → ILinkTokenExpiredError；业务错误与 HTTP 非 200 → 普通错误", async () => {
    const expired = fakeILink();
    expired.on((url) => url.endsWith("/ilink/bot/getupdates"), () => ({ ret: -1, errcode: -14 }));
    await expect(createILinkClient({ fetch: expired.fetch }).getUpdates("t", "")).rejects.toBeInstanceOf(ILinkTokenExpiredError);

    const http500 = fakeILink();
    http500.on((url) => url.endsWith("/ilink/bot/getupdates"), () => ({ __status: 500 }));
    await expect(createILinkClient({ fetch: http500.fetch }).getUpdates("t", "")).rejects.toThrow("HTTP 500");

    const bizFail = fakeILink();
    bizFail.on((url) => url.endsWith("/ilink/bot/getupdates"), () => ({ ret: 1, errcode: 7, errmsg: "boom" }));
    await expect(createILinkClient({ fetch: bizFail.fetch }).getUpdates("t", "")).rejects.toThrow("errcode=7");
  });

  it("pollQRCodeStatus：confirmed 带凭据；凭据不全报错；其余归一 wait/scaned/expired", async () => {
    const iLink = fakeILink();
    iLink.on((url) => url.includes("qrcode=ok"), () => ({ status: "confirmed", bot_token: "bt", ilink_bot_id: "ib", ilink_user_id: "iu" }));
    iLink.on((url) => url.includes("qrcode=bad"), () => ({ status: "confirmed", bot_token: "bt" }));
    iLink.on((url) => url.includes("qrcode=sc"), () => ({ status: "scaned" }));
    iLink.on((url) => url.includes("qrcode=xx"), () => ({ status: "whatever" }));
    const client = createILinkClient({ fetch: iLink.fetch });
    expect(await client.pollQRCodeStatus("ok")).toEqual({ status: "confirmed", creds: { botToken: "bt", ilinkBotId: "ib", ilinkUserId: "iu" } });
    await expect(client.pollQRCodeStatus("bad")).rejects.toThrow("凭据不全");
    expect((await client.pollQRCodeStatus("sc")).status).toBe("scaned");
    expect((await client.pollQRCodeStatus("xx")).status).toBe("wait");
  });

  it("sendMessage：载荷形态（to_user_id / context_token / 文本 item / BOT+FINISH）", async () => {
    const iLink = fakeILink();
    iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    await createILinkClient({ fetch: iLink.fetch }).sendMessage("tok", "wxuser-1", "ctx-9", "回复内容");
    const call = iLink.calls.find((c) => c.url.endsWith("/ilink/bot/sendmessage"))!;
    expect(JSON.parse(call.init?.body ?? "{}")).toMatchObject({
      msg: {
        to_user_id: "wxuser-1",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-9",
        item_list: [{ type: 1, text_item: { text: "回复内容" } }],
      },
    });
  });

  it("sendMessage：HTTP 200 但业务码非 0 → 抛错带详情（假成功防线）；-14 → TokenExpired", async () => {
    const biz = fakeILink();
    biz.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => ({ ret: 0, errcode: 5, errmsg: "rejected by ilink" }));
    await expect(createILinkClient({ fetch: biz.fetch }).sendMessage("t", "u", "ctx", "hi")).rejects.toThrow("errcode=5");

    const exp = fakeILink();
    exp.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => ({ errcode: -14 }));
    await expect(createILinkClient({ fetch: exp.fetch }).sendMessage("t", "u", "", "hi")).rejects.toBeInstanceOf(ILinkTokenExpiredError);
  });
});

describe("WechatBridge（绑定 / 对话闭环 / 越权 / 过期 / 推送）", () => {
  it("bind：凭据加密落库（密文非明文）+ 欢迎语主动推送；status/unbind 往返", async () => {
    const fixture = makeFixture([{ kind: "text", text: "用不到模型" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    await bindActive(fixture);
    const row = fixture.db.prepare("SELECT bot_token_enc, ilink_bot_id, state FROM wechat_binds WHERE uid = ?").get(UID) as unknown as {
      bot_token_enc: string;
      ilink_bot_id: string;
      state: string;
    };
    expect(row.ilink_bot_id).toBe("ib-1");
    expect(row.state).toBe("active");
    expect(row.bot_token_enc).not.toContain("bot-token-1"); // 密文不含明文
    expect(fixture.bridge.status(UID)).toEqual({ bound: true, state: "active", ilinkBotId: "ib-1" });
    // 欢迎语：无 context_token 主动推给绑定用户本人
    const welcome = fixture.iLink.calls.find((c) => c.url.endsWith("/ilink/bot/sendmessage"))!;
    expect(JSON.parse(welcome.init?.body ?? "{}").msg).toMatchObject({ to_user_id: "wxuser-1", context_token: "" });
    await fixture.bridge.unbind(UID);
    expect(fixture.bridge.status(UID)).toEqual({ bound: false, state: "active" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM wechat_binds WHERE uid = ?").get(UID)).toMatchObject({ n: 0 });
  });

  it("对话闭环：微信文本 → 固定「微信对话」会话跑回合 → 回复带 context_token 推回", async () => {
    const fixture = makeFixture([{ kind: "text", text: "好的，记下了。" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    fixture.iLink.on(
      (url) => url.endsWith("/ilink/bot/getupdates"),
      () => ({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cur-next",
        msgs: [
          { message_id: 21, from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: "记一下今天跑步 30 分钟" } }], context_token: "ctx-21" },
        ],
      }),
    );
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);

    const conv = fixture.db.prepare("SELECT title, pinned, uid FROM conversations WHERE cid = ?").get(WECHAT_FEED_CID(UID)) as unknown as {
      title: string;
      pinned: number;
      uid: string;
    };
    expect(conv).toMatchObject({ title: "微信对话", pinned: 1, uid: UID });
    const events = fixture.db
      .prepare("SELECT event_json FROM conversation_events WHERE cid = ? ORDER BY seq")
      .all(WECHAT_FEED_CID(UID)) as unknown as { event_json: string }[];
    const types = events.map((r) => (JSON.parse(r.event_json) as { type: string }).type);
    expect(types).toContain("user/message");
    expect(types).toContain("assistant/message");
    expect(types.at(-1)).toBe("turn/end");
    const sends = fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage"));
    const reply = JSON.parse(sends.at(-1)!.init?.body ?? "{}").msg;
    expect(reply.item_list[0].text_item.text).toContain("好的，记下了。");
    expect(reply.context_token).toBe("ctx-21");
    expect(reply.to_user_id).toBe("wxuser-1");
  });

  it("越权忽略：非绑定微信用户的消息不建会话、不回复", async () => {
    const fixture = makeFixture([{ kind: "text", text: "不该跑" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    fixture.iLink.on(
      (url) => url.endsWith("/ilink/bot/getupdates"),
      () => ({
        ret: 0,
        errcode: 0,
        msgs: [{ message_id: 31, from_user_id: "别人", message_type: 1, item_list: [{ type: 1, text_item: { text: "偷聊" } }], context_token: "ctx" }],
      }),
    );
    await bindActive(fixture);
    await fixture.bridge.pollOnce(UID);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE cid = ?").get(WECHAT_FEED_CID(UID))).toMatchObject({ n: 0 });
    expect(fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage"))).toHaveLength(1); // 仅欢迎语
    expect(fixture.mock.requests).toHaveLength(0); // 模型一次都没被调
  });

  it("过期：-14 → 绑定置 expired、轮询停、站内提醒；后续 pollOnce 空转不外呼", async () => {
    const fixture = makeFixture([{ kind: "text", text: "用不到" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    await bindActive(fixture);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/getupdates"), () => ({ ret: -1, errcode: -14 }));
    await fixture.bridge.pollOnce(UID);
    expect(fixture.bridge.status(UID)).toMatchObject({ bound: true, state: "expired" });
    const notes = await fixture.notifications.list(UID);
    expect(notes.some((n) => n.kind === "wechat_bind_expired")).toBe(true);
    const callsBefore = fixture.iLink.calls.length;
    await fixture.bridge.pollOnce(UID); // expired：直接返回，不再外呼
    expect(fixture.iLink.calls.length).toBe(callsBefore);
    expect(await fixture.bridge.pushToWechat(UID, "推不动")).toBe(false); // 过期后主动推送也退站内
  });

  it("pushToWechat：active 推送成功；未绑定/接口失败 → false", async () => {
    const fixture = makeFixture([{ kind: "text", text: "用不到" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    expect(await fixture.bridge.pushToWechat(UID, "先没绑定")).toBe(false);
    await bindActive(fixture);
    expect(await fixture.bridge.pushToWechat(UID, "【喝水】该喝水了")).toBe(true);
    const last = fixture.iLink.calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage")).at(-1)!;
    expect(JSON.parse(last.init?.body ?? "{}").msg).toMatchObject({ to_user_id: "wxuser-1", context_token: "" });
    // 接口报错 → 静默 false（任务不失败）
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => ({ __status: 500 }));
    expect(await fixture.bridge.pushToWechat(UID, "再推")).toBe(false);
  });

  it("startAll：重启后恢复 active 绑定轮询；expired 不启；解绑即停", async () => {
    const fixture = makeFixture([{ kind: "text", text: "用不到" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    await bindActive(fixture);
    // 第二轮 getupdates 永不返回：轮询挂起等消息，解绑后自然退场（无计时器，不阻塞测试退出）
    const first = deferred<void>();
    let polls = 0;
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/getupdates"), () => {
      polls += 1;
      if (polls === 1) {
        first.resolve();
        return { ret: 0, errcode: 0, msgs: [] };
      }
      return new Promise(() => undefined);
    });
    const revived = new WechatBridge({
      env: envOf(fixture.iLink.fetch),
      db: fixture.db,
      masterKey: fixture.masterKey,
      conversations: fixture.conversations,
      notifications: fixture.notifications,
      now: NOW,
    });
    revived.startAll();
    await first.promise; // 第一轮拉取确实发生了（确定性：deferred 而非轮询等待）
    expect(polls).toBeGreaterThanOrEqual(1);
    await revived.unbind(UID);
    expect(fixture.bridge.status(UID).bound).toBe(false);
  });

  it("重绑竞态：在飞的旧轮询循环被取代后自然退场，不产生第二个循环", async () => {
    const fixture = makeFixture([{ kind: "text", text: "用不到" }]);
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/sendmessage"), () => iLinkOk);
    const firstArrived = deferred<void>();
    let releaseFirst: () => void = () => undefined;
    let polls = 0;
    fixture.iLink.on((url) => url.endsWith("/ilink/bot/getupdates"), () => {
      polls += 1;
      if (polls === 1) {
        firstArrived.resolve();
        return new Promise<void>((resolve) => { releaseFirst = resolve; }).then(() => ({ ret: 0, errcode: 0, msgs: [] }));
      }
      return new Promise(() => undefined); // 新循环的拉取挂起（真实长轮询等消息形态）
    });
    await fixture.bridge.bind(UID, CREDS); // 旧循环：挂在第 1 次拉取（35s 长轮询中）
    await firstArrived.promise;
    await fixture.bridge.unbind(UID); // 解绑时旧循环仍在飞
    await fixture.bridge.bind(UID, CREDS); // 立即重绑 → 新循环（第 2 次拉取，挂起）
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // 小真实延迟：让新循环的拉取出手、旧循环有机会推进
    expect(polls).toBe(2); // 1 旧 + 1 新
    releaseFirst(); // 旧循环的拉取此刻才返回空批
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // 旧循环跑到下一轮循环顶检查
    expect(polls).toBe(2); // 被取代即退场；无代数防护时这里会出现第 3 次拉取（双循环重复拉取）
    await fixture.bridge.unbind(UID); // 收口（挂起的 promise 无 timer，不阻测试退出）
  });

  it("qrcode 归属：newQRCode 记归属；他人/未知码轮询 → null；confirmed 用毕除名", async () => {
    const fixture = makeFixture([{ kind: "text", text: "用不到" }]);
    fixture.iLink.on((url) => url.includes("get_bot_qrcode"), () => ({ qrcode: "qr-x", qrcode_img_content: "https://img.local/x.png" }));
    fixture.iLink.on((url) => url.includes("qrcode=qr-x"), () => ({ status: "confirmed", bot_token: "bt2", ilink_bot_id: "ib2", ilink_user_id: "iu2" }));
    const qr = await fixture.bridge.newQRCode(UID);
    expect(qr).toEqual({ qrcode: "qr-x", content: "https://img.local/x.png" });
    expect(await fixture.bridge.pollQRStatus("别人", "qr-x")).toBeNull(); // 归属不符：劫绑拦截
    expect(await fixture.bridge.pollQRStatus(UID, "qr-nope")).toBeNull(); // 未知码
    const ok = await fixture.bridge.pollQRStatus(UID, "qr-x");
    expect(ok?.status).toBe("confirmed");
    expect(ok?.creds).toEqual({ botToken: "bt2", ilinkBotId: "ib2", ilinkUserId: "iu2" });
    expect(await fixture.bridge.pollQRStatus(UID, "qr-x")).toBeNull(); // 已消费的码不能再轮询（重放拦截）
  });
});
