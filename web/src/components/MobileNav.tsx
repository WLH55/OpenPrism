import type { ReactNode } from "react";
import type { View } from "../App";
import { ChatIcon, CloseIcon, MenuIcon, ProgressIcon, TodayIcon } from "../icons";

// 窄屏导航（2026-09-23 手机浏览器适配；2026-09-28 B3 重排）：底部五项标签栏（对话 / 今天 / 计划 / 成长 / 更多）
// + 左滑抽屉容器。「更多」打开抽屉（最近对话、盘面、伙伴、提醒与设置都在里面）；桌面端（md+）整块不渲染。

type IconType = (p: { className?: string }) => JSX.Element;

/** 底部标签栏（md 以下渲染；底部安全区内边距避开安卓手势条） */
export function BottomTabs({
  view,
  moreActive,
  unread,
  onPick,
  onMore,
}: {
  view: View;
  moreActive: boolean;
  unread: number;
  onPick: (view: View) => void;
  onMore: () => void;
}) {
  const item = (key: string, label: string, Icon: IconType, active: boolean, onClick: () => void, badge?: number) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`relative flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[11px] transition ${active ? "font-medium text-accent" : "text-ink3"}`}
    >
      <span className="relative">
        <Icon className="h-5 w-5" />
        {badge !== undefined && badge > 0 && (
          <span className="num absolute -right-2.5 -top-1.5 rounded-full bg-warm px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{badge}</span>
        )}
      </span>
      {label}
    </button>
  );
  return (
    <nav className="flex border-t border-line bg-surface2 pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="主导航">
      {item("chat", "对话", ChatIcon, view === "chat", () => onPick("chat"))}
      {item("today", "今天", TodayIcon, view === "today", () => onPick("today"))}
      {item("progress", "成长", ProgressIcon, view === "progress", () => onPick("progress"))}
      {item("more", "更多", MenuIcon, moreActive, onMore, unread)}
    </nav>
  );
}

/** 左滑抽屉容器：遮罩点击关闭；内容（侧栏本体）由调用方装进来 */
export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 md:hidden" data-drawer="">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface2 shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <MenuIcon className="h-4 w-4 text-ink3" />
            菜单
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭菜单"
            className="rounded-lg p-1.5 text-ink2 transition hover:bg-surface"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
