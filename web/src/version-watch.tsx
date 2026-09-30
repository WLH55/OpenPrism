import { useEffect, useState } from "react";

/** 新版本提示条（2026-09-30）：SPA 一旦加载就常驻内存，服务器部署新版后老标签不会自更新——
 *  用户"看不到新功能"的反复根源。窗口重新可见/获得焦点时 + 每 10 分钟拉一次 index.html（服务端 no-cache），
 *  对比当前 script 标签里的 bundle 文件名，变了就顶部浮条提示一键刷新。
 *  刻意不自动 reload：防打断正在输入的消息；用户点「立即刷新」才动。 */
const BUNDLE_RE = /assets\/(index-[A-Za-z0-9_-]+\.js)/;

function currentBundle(): string {
  const script = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  return BUNDLE_RE.exec(script?.src ?? "")?.[1] ?? "";
}

export function VersionWatch() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const html = await fetch("/", { cache: "no-store" }).then((r) => r.text());
        const latest = BUNDLE_RE.exec(html)?.[1] ?? "";
        const mine = currentBundle();
        if (!stopped && latest !== "" && mine !== "" && latest !== mine) setStale(true);
      } catch {
        /* 网络失败静默——下次再试 */
      }
    };
    const onWake = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    const timer = window.setInterval(() => void check(), 10 * 60_000);
    void check();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.clearInterval(timer);
    };
  }, []);
  if (!stale) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 bg-accent2/95 px-4 py-2 text-sm font-medium text-white shadow-lg">
      <span>🚀 新版本已发布</span>
      <button
        className="rounded bg-white/20 px-2.5 py-1 text-xs font-semibold transition hover:bg-white/30"
        onClick={() => window.location.reload()}
      >
        立即刷新
      </button>
    </div>
  );
}
