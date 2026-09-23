import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// 图片查看层（2026-09-19）：对话气泡、待发附件、回复里的 markdown 图片都可以点开看大图。
// 用法：App 顶层包一层 LightboxHost；任意子组件用 useLightbox() 拿到打开函数。
// 交互：点背景 / 按 Esc / 点关闭都能收起；点图本身在「适应窗口」与「原尺寸」之间切换；可下载。

export interface LightboxImage {
  src: string;
  name?: string;
}

const LightboxContext = createContext<(image: LightboxImage) => void>(() => undefined);

/** 打开图片查看层（没有 LightboxHost 时不做事，组件可独立渲染） */
export function useLightbox(): (image: LightboxImage) => void {
  return useContext(LightboxContext);
}

export function LightboxHost({ children }: { children: ReactNode }) {
  const [image, setImage] = useState<LightboxImage | null>(null);
  const [actualSize, setActualSize] = useState(false);

  const open = useCallback((next: LightboxImage) => {
    setActualSize(false);
    setImage(next);
  }, []);
  const close = useCallback(() => setImage(null), []);

  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [image, close]);

  return (
    <LightboxContext.Provider value={open}>
      {children}
      {image && (
        <div
          data-lightbox=""
          className="fixed inset-0 z-50 flex flex-col bg-black/75 backdrop-blur-sm"
          onClick={close}
        >
          <div
            className="flex items-center gap-2 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-white/80">{image.name ?? ""}</span>
            <button
              type="button"
              className="rounded-lg border border-white/30 px-3 py-1.5 text-xs text-white transition hover:bg-white/10"
              onClick={() => setActualSize((value) => !value)}
            >
              {actualSize ? "适应窗口" : "原尺寸"}
            </button>
            <a
              className="rounded-lg border border-white/30 px-3 py-1.5 text-xs text-white transition hover:bg-white/10"
              href={image.src}
              download={image.name ?? "image"}
            >
              下载
            </a>
            <button
              type="button"
              className="rounded-lg border border-white/30 px-3 py-1.5 text-xs text-white transition hover:bg-white/10"
              onClick={close}
            >
              关闭
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="flex min-h-full items-center justify-center">
              <img
                src={image.src}
                alt={image.name ?? "图片"}
                className={
                  actualSize
                    ? "max-w-none cursor-zoom-out rounded-lg"
                    : "max-h-[calc(100dvh-8rem)] max-w-full cursor-zoom-in rounded-lg object-contain"
                }
                onClick={(event) => {
                  event.stopPropagation();
                  setActualSize((value) => !value);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </LightboxContext.Provider>
  );
}
