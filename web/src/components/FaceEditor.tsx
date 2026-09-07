import { useRef } from "react";

// 伙伴形象编辑器（对齐 DeepTutor FaceEditor 的 iOS-通讯录式交互）：
// 24 预置 emoji 网格 + 8 色圆盘 + 上传图片（SVG≤100KB 直读；位图 canvas 居中裁方缩 128px WebP data URL）。
// 数据 FaceValue = { emoji, color, avatar }，avatar 为 data URL（服务端 ≤200KB 校验）。

export interface FaceValue {
  emoji: string;
  color: string;
  avatar: string; // "" = 无上传图
}

export const FACE_EMOJIS = ["🦊", "🐳", "🦉", "🐱", "🐶", "🐼", "🐨", "🦁", "🐯", "🐸", "🐙", "🦄", "🤖", "👾", "🌱", "🌸", "🍀", "🌙", "✨", "🔥", "📚", "🎨", "🎧", "🧭"];
export const PARTNER_COLORS = ["#b0501e", "#8c6a2f", "#4f7a5b", "#3d6b8a", "#6d5a8c", "#8a4f5f", "#a8763e", "#5b8a8a"];

/** 头像渲染（列表/聊天头共用）：上传图 > emoji+色盘 > 首字母 */
export function FaceAvatar({ name, face, size = 40 }: { name: string; face?: { emoji?: string; color?: string; avatar?: string }; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.55) };
  if (face?.avatar) {
    return <img src={face.avatar} alt={name} className="shrink-0 rounded-full object-cover" style={style} />;
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ ...style, background: face?.color || (face?.emoji ? "var(--muted, #eee)" : undefined) }}
    >
      {face?.emoji || name.slice(0, 1)}
    </span>
  );
}

async function fileToFace(f: File): Promise<string> {
  if (f.type === "image/svg+xml") {
    if (f.size > 100 * 1024) throw new Error("SVG 不能超过 100KB");
    const text = await f.text();
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  }
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type)) throw new Error("用 PNG、JPG、WebP、GIF 或 SVG 图片");
  if (f.size > 10 * 1024 * 1024) throw new Error("图片太大了（>10MB）");
  const bitmap = await createImageBitmap(f);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
  return canvas.toDataURL("image/webp", 0.9);
}

export function FaceEditor({ value, onChange }: { value: FaceValue; onChange: (next: FaceValue) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-3">
      {/* 预览 */}
      <div className="flex justify-center">
        <FaceAvatar name="?" face={value} size={72} />
      </div>
      {/* emoji 网格 */}
      <div className="grid grid-cols-8 justify-items-center gap-1.5">
        {FACE_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={`flex h-9 w-9 items-center justify-center rounded-full text-xl transition ${
              value.emoji === emoji && !value.avatar ? "ring-2 ring-accent" : "hover:bg-surface2"
            }`}
            onClick={() => onChange({ ...value, emoji: value.emoji === emoji && !value.avatar ? "" : emoji, avatar: "" })}
          >
            {emoji}
          </button>
        ))}
      </div>
      {/* 色盘 */}
      <div className="flex justify-center gap-2">
        {PARTNER_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            disabled={!!value.avatar}
            className={`h-6 w-6 rounded-full transition disabled:opacity-30 ${value.color === color ? "ring-2 ring-offset-2 ring-accent" : ""}`}
            style={{ background: color }}
            onClick={() => onChange({ ...value, color: value.color === color ? "" : color })}
          />
        ))}
      </div>
      {/* 上传 */}
      <div className="flex justify-center">
        <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink2 transition hover:border-accent hover:text-ink" onClick={() => fileRef.current?.click()}>
          ⬆ 上传图片 / SVG
        </button>
        {value.avatar && (
          <button type="button" className="ml-2 text-xs text-warm hover:underline" onClick={() => onChange({ ...value, avatar: "" })}>
            移除图片
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              onChange({ ...value, avatar: await fileToFace(f) });
            } catch (err) {
              window.alert((err as Error).message);
            }
          }}
        />
      </div>
    </div>
  );
}
