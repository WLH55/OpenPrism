import { useState } from "react";
import { api, type MeLoose } from "../api";
import { FaceAvatar, FaceEditor, type FaceValue } from "../components/FaceEditor";

/** 时区下拉档位：UTC-12 ~ +14 整点（偏移分钟 = -档位×60） */
const TZ_OPTIONS: number[] = Array.from({ length: 27 }, (_, i) => i - 12); // -12..+14
const tzLabel = (offsetHours: number): string =>
  offsetHours === 0 ? "UTC±0" : offsetHours > 0 ? `UTC+${offsetHours}` : `UTC${offsetHours}`;

/** 个人资料页：用户名只读 + 形象（上传头像 / emoji / 色盘）+ 档案时区；保存后全站即时更新 */
export function Profile({ me, onSaved }: { me: MeLoose; onSaved: (next: MeLoose) => void }) {
  const [face, setFace] = useState<FaceValue>({ emoji: me.face.emoji, color: me.face.color, avatar: me.face.avatar });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 档案时区（2026-09-29）：agent 工具层/微信对话/定时任务统一按它算「今天」；缺省跟浏览器
  const browserTz = -new Date().getTimezoneOffset();
  const [tz, setTz] = useState<number>(me.tzOffsetMinutes ?? browserTz);
  const [tzMessage, setTzMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.updateProfile({ emoji: face.emoji, color: face.color, avatar: face.avatar });
      onSaved(updated);
      setMessage({ ok: true, text: "头像已保存（对话里的头像同步更新）" });
    } catch (e) {
      setMessage({ ok: false, text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const saveTz = async () => {
    setBusy(true);
    setTzMessage(null);
    try {
      const updated = await api.updateProfile({ tzOffsetMinutes: tz });
      onSaved(updated);
      setTzMessage("时区已保存——助手算「今天/本周」都按这个钟面来");
    } catch (e) {
      setTzMessage(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">本地账户 · 数据存在你自己的设备上</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">个人资料</h1>
      </header>

      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <FaceAvatar name={me.username} face={{ ...face }} size={56} />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink">{me.username}</div>
            <div className="text-xs text-ink3">用户名与口令在注册时确定，这里只改形象</div>
          </div>
        </div>
        <div className="mt-4">
          <FaceEditor value={face} onChange={setFace} />
        </div>
        <button
          className="mt-4 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
          disabled={busy}
          onClick={() => void save()}
        >
          保存头像
        </button>
        {message && <p className={`mt-3 text-sm ${message.ok ? "text-accent" : "text-warm"}`}>{message.text}</p>}
      </section>

      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="text-[15px] font-semibold text-ink">时区</div>
        <p className="mt-1 text-xs leading-relaxed text-ink3">
          助手算「今天 / 本周 / 流水日期」都按这个钟面——网页端会自动同步浏览器时区，微信对话、定时提醒也用它；
          出差换时区了就在这里手动改。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            value={tz}
            onChange={(e) => setTz(Number(e.target.value))}
          >
            {TZ_OPTIONS.map((h) => (
              <option key={h} value={h * 60}>
                {tzLabel(h)}
              </option>
            ))}
          </select>
          <button
            className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
            disabled={busy || tz === (me.tzOffsetMinutes ?? browserTz)}
            onClick={() => void saveTz()}
          >
            保存时区
          </button>
        </div>
        {tzMessage && <p className="mt-3 text-sm text-ink2">{tzMessage}</p>}
      </section>

      <p className="text-xs leading-relaxed text-ink3">
        上传的图片会居中裁成方形、缩到 128 像素存进本地数据库，不经过任何外部服务；也可以直接用 emoji 和色盘当头像。
      </p>
    </div>
  );
}
