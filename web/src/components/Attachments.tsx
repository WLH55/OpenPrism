import { useEffect, useRef, useState } from "react";
import type { AttachmentInput } from "../api";
import { useLightbox } from "../lightbox";
import { CameraIcon } from "../icons";

// 对话附件（2026-09-19）：图片在浏览器里居中缩放并转成 WebP 再上传（原图直传对识别无益，只增加体积与 token）；
// 文本文件读成 UTF-8 正文内联发送；PDF/Office/压缩包等二进制格式不做自行解析，显式拒绝并提示可用格式。

const IMAGE_MAX_SIDE = 1280;
const IMAGE_QUALITY = 0.85;
const IMAGE_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_MAX_CHARS = 400_000;
const MAX_COUNT = 6;
const MAX_IMAGES = 4;

export interface PendingAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  mediaType: string;
  bytes: number;
  preview?: string;
  dataBase64?: string;
  text?: string;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function base64Of(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** 图片：等比缩到长边 1280 以内，转 WebP */
async function imageAttachment(file: File): Promise<PendingAttachment> {
  if (file.size > IMAGE_SOURCE_MAX_BYTES) throw new Error(`图片「${file.name}」超过 10MB`);
  const bitmap = await createImageBitmap(file);
  const side = Math.max(bitmap.width, bitmap.height);
  const scale = side > IMAGE_MAX_SIDE ? IMAGE_MAX_SIDE / side : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/webp", IMAGE_QUALITY);
  const dataBase64 = base64Of(dataUrl);
  // 编码结果的实际类型要读回来：浏览器不支持 WebP 编码时会落回 PNG，声明的类型必须与字节一致，
  // 否则服务端的签名校验会拒收
  const mediaType = /^data:([^;]+);/.exec(dataUrl)?.[1] ?? "image/webp";
  return {
    id: newId(),
    kind: "image",
    name: file.name.slice(0, 200),
    mediaType,
    bytes: Math.floor((dataBase64.length * 3) / 4),
    preview: dataUrl,
    dataBase64,
  };
}

/** 文本文件：UTF-8 解码后内联；二进制格式与非法编码就地拒绝 */
async function fileAttachment(file: File): Promise<PendingAttachment> {
  if (file.size > TEXT_MAX_BYTES) throw new Error(`文件「${file.name}」超过 2MB——请截取需要的部分再上传`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.subarray(0, 8000).includes(0)) {
    throw new Error(`文件「${file.name}」是二进制格式（PDF / Office / 压缩包等），暂不解析——请上传文本（.md/.txt/.csv/.json/代码）或直接截图`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`文件「${file.name}」不是 UTF-8 文本（其它编码请先转成 UTF-8）`);
  }
  if (text.trim() === "") throw new Error(`文件「${file.name}」内容为空`);
  if (text.length > TEXT_MAX_CHARS) throw new Error(`文件「${file.name}」超过 ${TEXT_MAX_CHARS} 字上限`);
  return {
    id: newId(),
    kind: "file",
    name: file.name.slice(0, 200),
    mediaType: file.type || "text/plain",
    bytes: file.size,
    text,
  };
}

export async function fileToAttachment(file: File): Promise<PendingAttachment> {
  if (file.type === "image/svg+xml") throw new Error("SVG 是矢量图，模型看不了——请导出 PNG 或直接截图");
  if (file.type.startsWith("image/")) {
    if (!IMAGE_TYPES.includes(file.type)) throw new Error(`图片类型 ${file.type} 不支持，请用 PNG / JPEG / WebP / GIF`);
    return imageAttachment(file);
  }
  return fileAttachment(file);
}

export function toAttachmentInputs(items: PendingAttachment[]): AttachmentInput[] {
  return items.map((item) =>
    item.kind === "image"
      ? { kind: "image" as const, name: item.name, mediaType: item.mediaType, dataBase64: item.dataBase64 ?? "" }
      : { kind: "file" as const, name: item.name, mediaType: item.mediaType, text: item.text ?? "" },
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * 附件托盘：选择按钮 + 待发列表（图片缩略图 / 文件名）。
 * allowImages=false 时图片被拦下，但仍以「不会发送」的形态留在托盘里（用户看得见自己选了什么、为什么没发出去）。
 */
export function AttachmentTray({
  items,
  onChange,
  allowImages,
  imageHint,
  disabled,
  onError,
}: {
  items: PendingAttachment[];
  onChange: (next: PendingAttachment[]) => void;
  allowImages: boolean;
  imageHint: string;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const openImage = useLightbox();
  const [blocked, setBlocked] = useState<PendingAttachment[]>([]);

  // 换成支持图片的模型后，之前的拦截记录自动清掉（用户可以直接重选）
  useEffect(() => {
    if (allowImages) setBlocked([]);
  }, [allowImages]);

  const add = async (files: File[]) => {
    const next = [...items];
    const rejected: PendingAttachment[] = [];
    for (const file of files) {
      if (next.length >= MAX_COUNT) {
        onError(`一条消息最多 ${MAX_COUNT} 个附件`);
        break;
      }
      let attachment: PendingAttachment;
      try {
        attachment = await fileToAttachment(file);
      } catch (error) {
        onError((error as Error).message);
        continue;
      }
      if (attachment.kind === "image" && !allowImages) {
        rejected.push(attachment);
        continue;
      }
      if (attachment.kind === "image" && next.filter((item) => item.kind === "image").length >= MAX_IMAGES) {
        onError(`一条消息最多 ${MAX_IMAGES} 张图片`);
        continue;
      }
      next.push(attachment);
    }
    onChange(next);
    if (rejected.length > 0) {
      setBlocked(rejected);
      const names = rejected.map((item) => item.name).join("、");
      onError(
        `「${names}」没有上传：${imageHint}。去「模型接入」勾选该模型的「支持图片识别（多模态）」，或换一个支持图片的模型；文字文件仍然可以上传。`,
      );
    }
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink2 transition hover:border-accent hover:text-ink disabled:opacity-60"
        onClick={() => fileRef.current?.click()}
        title="上传图片或文本文件"
      >
        📎 图片 / 文件
      </button>
      {/* 窄屏第二个入口（2026-09-23）：capture 直入后置相机，免去系统选择器里翻菜单；桌面不渲染 */}
      <button
        type="button"
        disabled={disabled}
        className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink2 transition hover:border-accent hover:text-ink disabled:opacity-60 md:hidden"
        onClick={() => cameraRef.current?.click()}
        title="拍照上传"
      >
        <CameraIcon className="h-3.5 w-3.5" />
        拍照
      </button>
      {!allowImages && <span className="text-xs text-ink3">{imageHint}</span>}
      {blocked.map((item) => (
        <span key={item.id} className="flex items-center gap-1.5 rounded-lg border border-dashed border-warm bg-warm2/40 px-1.5 py-1">
          {item.preview && (
            <button type="button" title="点击看大图" className="cursor-zoom-in" onClick={() => openImage({ src: item.preview!, name: item.name })}>
              <img src={item.preview} alt={item.name} className="h-10 w-10 rounded object-cover opacity-70" />
            </button>
          )}
          <span className="max-w-28 truncate text-[11px] text-warm" title={item.name}>
            {item.name}
          </span>
          <span className="text-[11px] text-warm">不会发送</span>
          <button
            type="button"
            title="移除"
            className="text-[11px] font-bold text-warm"
            onClick={() => setBlocked(blocked.filter((each) => each.id !== item.id))}
          >
            ×
          </button>
        </span>
      ))}
      {items.map((item) =>
        item.kind === "image" ? (
          <span key={item.id} className="group relative">
            <button
              type="button"
              title="点击看大图"
              className="block cursor-zoom-in transition hover:opacity-90"
              onClick={() => item.preview && openImage({ src: item.preview, name: item.name })}
            >
              <img src={item.preview} alt={item.name} className="h-14 w-14 rounded-lg border border-line object-cover" />
            </button>
            <button
              type="button"
              title="移除"
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-warm text-[11px] font-bold text-white"
              onClick={() => onChange(items.filter((each) => each.id !== item.id))}
            >
              ×
            </button>
          </span>
        ) : (
          <span key={item.id} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-xs text-ink2">
            <span className="max-w-40 truncate" title={item.name}>
              {item.name}
            </span>
            <span className="text-ink3">{formatBytes(item.bytes)}</span>
            <button type="button" title="移除" className="font-bold text-warm" onClick={() => onChange(items.filter((each) => each.id !== item.id))}>
              ×
            </button>
          </span>
        ),
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.log,.yml,.yaml,.toml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.h,.cpp,.sh,.sql"
        className="hidden"
        onChange={(e) => {
          // 先把选中的文件快照成数组，再清空 input：清空 value 会同时清掉它的选中列表，
          // 先清后读拿到的是空列表（选图后毫无反应就是这么来的）
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void add(files);
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          // 同款快照再清空：camera input 单选，同样要先取再清
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void add(files);
        }}
      />
    </div>
  );
}
