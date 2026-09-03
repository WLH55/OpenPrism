import { useState } from "react";
import { api } from "../api";

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
    <div className="card login-card">
      <h2 style={{ margin: "4px 0 2px" }}>OpenPrism</h2>
      <p className="muted" style={{ margin: 0 }}>记录生活 · 监督进步 · 陪伴聊天</p>

      <div className="tabs" style={{ margin: "18px 0 4px", display: "flex", gap: 4 }}>
        <button className={`tab${mode === "login" ? " active" : ""}`} onClick={() => setMode("login")}>
          登录
        </button>
        <button className={`tab${mode === "register" ? " active" : ""}`} onClick={() => setMode("register")}>
          注册
        </button>
      </div>

      <label className="label">用户名</label>
      <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <label className="label">密码</label>
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {mode === "register" && (
        <>
          <label className="label">确认密码</label>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </>
      )}

      {error && <p className="hint-err" style={{ fontSize: 13.5 }}>{error}</p>}
      <button className="btn" style={{ width: "100%", marginTop: 16 }} disabled={busy} onClick={submit}>
        {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
      </button>
      <p className="muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
        自部署 · 数据在你自己的设备上 · 模型 Key 由你提供（BYOK）
      </p>
    </div>
  );
}
