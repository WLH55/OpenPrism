// GitHub 仓库入口（2026-10-01 开源宣传）：全站引导看源码 + 点 Star。
// 两处共用：侧栏/抽屉底部横条（SidebarContent）与登录页卡片下方内联。

const REPO_URL = "https://github.com/WLH55/OpenPrism";

/** GitHub 官方 mark 图标（单路径，跟随 currentColor） */
export function GithubIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** 五角星图标（Star 引导用） */
export function StarIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.58l-5.9 3.1 1.13-6.58L2.45 9.44l6.6-.96L12 2.5Z" />
    </svg>
  );
}

/** 侧栏/抽屉底部横条：GitHub 看源码 · 引导点 Star */
export function RepoLinkBar() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="mx-3 mb-2 flex items-center gap-2.5 rounded-lg border border-line bg-surface2 px-3 py-2.5 text-[13px] text-ink2 transition hover:border-accent hover:text-ink"
      title="本应用完全开源，欢迎到 GitHub 查看源码，觉得不错点个 Star 支持一下"
    >
      <GithubIcon className="h-4 w-4 shrink-0" />
      <span className="flex-1">GitHub 开源仓库</span>
      <StarIcon className="h-3.5 w-3.5 shrink-0 text-warm" />
      <span className="shrink-0 text-warm">点 Star</span>
    </a>
  );
}

/** 登录页内联：卡片下方居中一行 */
export function RepoLinkInline() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-6 flex items-center justify-center gap-1.5 text-xs text-ink3 transition hover:text-accent"
      title="本应用完全开源，欢迎到 GitHub 查看源码，觉得不错点个 Star 支持一下"
    >
      <GithubIcon className="h-3.5 w-3.5" />
      完全开源 · GitHub 看源码
      <StarIcon className="h-3 w-3 text-warm" />
      <span className="text-warm">点个 Star 支持一下</span>
    </a>
  );
}
