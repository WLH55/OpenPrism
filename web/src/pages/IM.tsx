// IM 通道页（2026-09-27 微信桥）：微信机器人（iLink）扫码绑定。
// 绑定后：微信里直接对话（进「微信对话」会话，web 同步可见）；定时任务通知渠道可选「微信机器人」。

import { useCallback, useEffect, useRef, useState } from "react";
import { apiIm, type WechatBindState } from "../api";
import { CloseIcon } from "../icons";

type ScanPhase = "idle" | "waiting" | "scaned" | "expired";

export function IM() {
  const [state, setState] = useState<WechatBindState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ qrcode: string; imgUrl: string } | null>(null);
  const [phase, setPhase] = useState<ScanPhase>("idle");
  // 扫码状态轮询代数：关闭弹层/过期后旧循环自动退场
  const pollGenRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setState(await apiIm.bindState());
      setError(null);
    } catch (e) {
      setError(`读取绑定状态失败：${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 扫码状态长轮询循环（每轮 ~35s 由服务端保持；confirmed 即绑定完成） */
  const pollStatus = useCallback(
    async (qrcode: string, gen: number) => {
      for (;;) {
        if (pollGenRef.current !== gen) return;
        let round: { status: "wait" | "scaned" | "confirmed" | "expired" };
        try {
          round = await apiIm.bindStatus(qrcode);
        } catch (e) {
          setError(`查询扫码状态失败：${(e as Error).message}`);
          return;
        }
        if (pollGenRef.current !== gen) return;
        if (round.status === "confirmed") {
          pollGenRef.current += 1; // 停轮询
          setQr(null);
          setPhase("idle");
          await refresh();
          return;
        }
        if (round.status === "expired") {
          setPhase("expired");
          return;
        }
        if (round.status === "scaned") setPhase("scaned");
      }
    },
    [refresh],
  );

  const startBind = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiIm.bindQRCode();
      pollGenRef.current += 1;
      const gen = pollGenRef.current;
      setQr(next);
      setPhase("waiting");
      void pollStatus(next.qrcode, gen);
    } catch (e) {
      setError(`获取登录二维码失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [pollStatus]);

  const closeQr = () => {
    pollGenRef.current += 1; // 旧轮询退场
    setQr(null);
    setPhase("idle");
  };

  const unbind = useCallback(async () => {
    setBusy(true);
    try {
      await apiIm.unbind();
      await refresh();
    } catch (e) {
      setError(`解绑失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const bound = state?.bound === true && state.state === "active";
  const expired = state?.bound === true && state.state === "expired";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">通道可插拔 · 收发对称</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">IM 通道</h1>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-warm/40 bg-warm2/50 px-3 py-2 text-xs leading-relaxed text-warm">{error}</p>
      )}

      {/* 微信机器人（iLink）：扫码绑定 */}
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent3 text-accent">微</div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">微信机器人</div>
            <div className="text-xs text-ink3">微信里直接对话 · 定时任务通知可选推送到微信</div>
          </div>
          {state === null ? (
            <span className="text-xs text-ink3">读取中…</span>
          ) : bound ? (
            <span className="rounded-full bg-accent3 px-2.5 py-1 text-xs text-accent">已绑定</span>
          ) : expired ? (
            <span className="rounded-full bg-warm2 px-2.5 py-1 text-xs text-warm">已过期</span>
          ) : (
            <span className="rounded-full bg-surface2 px-2.5 py-1 text-xs text-ink3">未绑定</span>
          )}
        </div>

        {state !== null && (
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            {bound && (
              <>
                <div className="text-sm text-ink2">
                  机器人 ID：<span className="font-mono text-xs text-ink3">{state.ilinkBotId}</span>
                </div>
                <div className="text-xs leading-relaxed text-ink3">
                  在微信里给这个机器人发消息即可对话——内容进「微信对话」会话（web 端同步可见）；只有你本人的微信消息会被响应。
                  建定时任务时把「通知渠道」选成「微信机器人」，到点提醒就会推到这里。
                </div>
                <div className="flex justify-end">
                  <button
                    className="rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink2 transition hover:bg-surface2 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void unbind()}
                  >
                    解绑
                  </button>
                </div>
              </>
            )}
            {expired && (
              <>
                <div className="text-sm text-warm">绑定已过期（登录凭证失效）——重新扫码即可恢复，历史对话不受影响。</div>
                <div className="flex justify-end">
                  <button
                    className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void startBind()}
                  >
                    重新扫码绑定
                  </button>
                </div>
              </>
            )}
            {!state.bound && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink2">用微信扫码，把你的微信连到 OpenPrism</span>
                <button
                  className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void startBind()}
                >
                  扫码绑定
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        通道走腾讯 iLink Bot 官方接口（WeKnora 同款）：扫码授权、纯出站连接（无需公网回调）。
        登录凭证失效时轮询自动停下，站内会收到重新绑定的提醒。
      </p>

      {/* 扫码弹层：二维码 + 实时状态 */}
      {qr && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeQr}>
          <div className="w-full max-w-xs rounded-2xl border border-line bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[15px] font-semibold text-ink">微信扫码绑定</span>
              <button className="rounded-lg p-1.5 text-ink3 transition hover:bg-surface2" onClick={closeQr} aria-label="关闭">
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            {qr.imgUrl !== "" ? (
              <img src={qr.imgUrl} alt="微信登录二维码" className="mx-auto h-56 w-56 rounded-lg border border-line object-contain" />
            ) : (
              <div className="mx-auto flex h-56 w-56 items-center justify-center rounded-lg border border-line text-xs text-ink3">
                二维码图片地址为空
              </div>
            )}
            <p className="mt-3 text-center text-xs text-ink3">
              {phase === "waiting" && "打开微信扫一扫，扫码后在微信里确认"}
              {phase === "scaned" && "已扫码——请在微信里点确认"}
              {phase === "expired" && "二维码已过期，关闭后重新获取"}
            </p>
            {phase === "expired" && (
              <button
                className="mt-3 w-full rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                onClick={() => void startBind()}
              >
                重新获取二维码
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
