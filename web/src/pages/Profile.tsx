import { useState } from "react";
import { api, type MeLoose } from "../api";
import { FaceAvatar, FaceEditor, type FaceValue } from "../components/FaceEditor";

/** 个人资料页：用户名只读 + 形象（上传头像 / emoji / 色盘）；保存后全站头像即时更新 */
export function Profile({ me, onSaved }: { me: MeLoose; onSaved: (next: MeLoose) => void }) {
  const [face, setFace] = useState<FaceValue>({ emoji: me.face.emoji, color: me.face.color, avatar: me.face.avatar });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

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

      <p className="text-xs leading-relaxed text-ink3">
        上传的图片会居中裁成方形、缩到 128 像素存进本地数据库，不经过任何外部服务；也可以直接用 emoji 和色盘当头像。
      </p>
    </div>
  );
}
