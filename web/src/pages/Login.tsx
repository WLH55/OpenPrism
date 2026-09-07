import { useState } from "react";
import { api } from "../api";
import { Prism } from "../icons";

/** 登录/注册：居中品牌区 + 分段切换，结构照 prototype 页 1 */
export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const me =
        mode === "login"
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password);
      onLoggedIn(me.username);
    } catch (e) {
      setError((e as Error).message === "username already taken" ? "用户名已被注册" : String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      {/* 品牌区 */}
      <div className="mb-8 text-center">
        <div className="mb-4 flex items-center justify-center gap-2">
          <Prism className="h-7 w-7" />
          <span className="text-2xl font-semibold tracking-tight text-ink">OpenPrism</span>
        </div>
        <p className="text-sm text-ink2">一个你，折射出生活的每一个维度</p>
      </div>

      {/* 分段切换 */}
      <div className="mb-6 grid grid-cols-2 rounded-lg bg-surface2 p-1 text-sm">
        <button
          onClick={() => setMode("login")}
          className={`rounded-md py-2 transition ${mode === "login" ? "bg-surface font-medium text-ink shadow-sm" : "text-ink3 hover:text-ink"}`}
        >
          登录
        </button>
        <button
          onClick={() => setMode("register")}
          className={`rounded-md py-2 transition ${mode === "register" ? "bg-surface font-medium text-ink shadow-sm" : "text-ink3 hover:text-ink"}`}
        >
          注册
        </button>
      </div>

      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="user">用户名</label>
          <input
            id="user"
            type="text"
            autoComplete="username"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
            placeholder="你的名字"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="pass">密码</label>
          <input
            id="pass"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {mode === "register" && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="confirm">确认密码</label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              placeholder="再输一遍"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}
        {error && <p className="text-sm text-warm">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-accent2 px-4 py-2.5 text-[15px] font-semibold text-white transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
        >
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-ink3">数据只存在你自己的设备上 · 模型 Key 由你自己配置</p>
    </div>
  );
}
