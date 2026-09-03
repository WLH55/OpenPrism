import { useCallback, useEffect, useRef, useState } from "react";
import { api3, type NotificationLoose } from "../api";

/** 顶栏通知铃：未读数徽标 + 下拉列表 + 全部已读（站内 = 永远在线的兜底通道） */
export function Bell() {
  const [unread, setUnread] = useState<NotificationLoose[]>([]);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<NotificationLoose[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setUnread(await api3.listNotifications(true).catch(() => []));
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 15000);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) setAll(await api3.listNotifications().catch(() => []));
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button className="btn ghost small" onClick={toggle} title="通知">
        铃
        {unread.length > 0 && (
          <span
            style={{
              marginLeft: 6,
              background: "var(--warm)",
              color: "#fff",
              borderRadius: 99,
              fontSize: 11,
              padding: "1px 7px",
            }}
          >
            {unread.length}
          </span>
        )}
      </button>
      {open && (
        <div
          className="card"
          style={{ position: "absolute", right: 0, top: "120%", width: 320, maxHeight: 380, overflow: "auto", zIndex: 30, padding: 10 }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>通知</b>
            <span style={{ flex: 1 }} />
            <button
              className="btn ghost small"
              onClick={async () => {
                await api3.markAllRead().catch(() => undefined);
                setUnread([]);
                setAll(await api3.listNotifications().catch(() => []));
              }}
            >
              全部已读
            </button>
          </div>
          {all.length === 0 && <p className="muted" style={{ margin: 0 }}>暂无通知</p>}
          {all
            .slice()
            .reverse()
            .slice(0, 30)
            .map((n) => (
              <div key={n.seq} style={{ padding: "8px 6px", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
                <div style={{ opacity: n.readTs ? 0.55 : 1 }}>
                  {n.text}
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {new Date(n.ts).toLocaleString()}
                    {n.readTs ? "" : " · 未读"}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
