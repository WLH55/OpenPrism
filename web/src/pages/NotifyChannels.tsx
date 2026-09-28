/** 通知通道页：站内（已启用）。微信机器人绑定入口在「IM 通道」页（2026-09-27 iLink 桥）。 */
export function NotifyChannels() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">通道可插拔 · 收发对称</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">通知通道</h1>
      </header>

      <div className="space-y-3">
        {/* 站内通知 */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent3 text-accent">站</div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">站内通知</div>
              <div className="text-xs text-ink3">永远在线的兜底通道 · 「提醒」页查看</div>
            </div>
            <span className="rounded-full bg-accent3 px-2.5 py-1 text-xs text-accent">已启用</span>
          </div>
        </div>

        {/* 微信机器人：占位指引（绑定操作在「IM 通道」页） */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warm2 text-warm">微</div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">微信机器人</div>
              <div className="text-xs text-ink3">对话与任务通知推送到微信 · 绑定入口在菜单「IM 通道」</div>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        微信桥已选型腾讯 iLink Bot 官方接口（WeKnora 同款，扫码授权、纯出站连接）——到「IM 通道」页扫码绑定；
        绑定后建定时任务时通知渠道可选「微信机器人」。
      </p>
    </div>
  );
}
