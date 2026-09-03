import { useEffect, useState } from "react";
import { api } from "./api";
import { Login } from "./pages/Login";
import { Chat } from "./pages/Chat";
import { Today } from "./pages/Today";
import { Settings } from "./pages/Settings";

type View = "chat" | "today" | "settings";

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");

  useEffect(() => {
    api
      .me()
      .then((me) => setUsername(me.username))
      .catch(() => setUsername(null));
  }, []);

  if (username === null) {
    return (
      <div className="login-wrap">
        <Login onLoggedIn={setUsername} />
      </div>
    );
  }

  const tabs: { key: View; label: string }[] = [
    { key: "chat", label: "对话" },
    { key: "today", label: "今天" },
    { key: "settings", label: "设置" },
  ];

  return (
    <>
      <header className="topbar">
        <span className="brand">OpenPrism</span>
        <nav className="tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab${view === tab.key ? " active" : ""}`}
              onClick={() => setView(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="muted">{username}</span>
        <button
          className="btn ghost small"
          onClick={() => {
            const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = next;
            try {
              localStorage.setItem("op-theme", next);
            } catch {
              /* 无 localStorage 也无妨 */
            }
          }}
        >
          明暗
        </button>
        <button
          className="btn ghost small"
          onClick={async () => {
            await api.logout().catch(() => undefined);
            setUsername(null);
          }}
        >
          退出
        </button>
      </header>
      {view === "chat" && <Chat key="chat" />}
      {view === "today" && <Today key="today" />}
      {view === "settings" && <Settings key="settings" />}
    </>
  );
}
