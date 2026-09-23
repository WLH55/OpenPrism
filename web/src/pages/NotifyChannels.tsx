/** 通知通道页：站内（已启用）/ 微信（待接入），结构照 prototype 页 12 */
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

        {/* 微信 */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warm2 text-warm">微</div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">微信</div>
              <div className="text-xs text-ink3">双向消息网关 · 回复直接进对应会话</div>
            </div>
            <span className="rounded-full bg-surface2 px-2.5 py-1 text-xs text-ink3">待接入</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
            <span className="text-sm text-ink2">绑定微信身份</span>
            <button
              className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white opacity-50"
              disabled
              title="微信桥未接入"
            >
              去绑定
            </button>
          </div>
        </div>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        微信桥选型待接入时专项调研（个人号直连无官方 API、有封号风险；公众号/企业微信/插件路都留待评估）。
      </p>
    </div>
  );
}
