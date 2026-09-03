import { useEffect, useState } from "react";
import { api } from "../api";

export function Settings() {
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getModel()
      .then((config) => {
        setBaseURL(config.baseURL);
        setModel(config.model);
        setHasKey(config.hasKey);
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.putModel({
        baseURL: baseURL.trim(),
        model: model.trim(),
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      setHasKey(true);
      setMessage({ ok: true, text: "已保存（Key 加密存储在你自己的设备上）" });
    } catch (e) {
      setMessage({ ok: false, text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.testModel();
      setMessage(
        result.ok
          ? { ok: true, text: "连接成功" }
          : { ok: false, text: `连接失败：${result.error ?? "未知错误"}` },
      );
    } catch (e) {
      setMessage({ ok: false, text: `连接失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <h1 style={{ margin: "0 0 4px" }}>模型接入</h1>
      <p className="muted">BYOK · Key 只发往你配置的 baseURL，加密存储、永不上传</p>

      <div className="card" style={{ marginTop: 16 }}>
        <label className="label">baseURL</label>
        <input
          className="input"
          placeholder="https://api.deepseek.com"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
        />
        <label className="label">
          API Key {hasKey && <span className="muted">（已配置，留空 = 不变）</span>}
        </label>
        <input
          className="input"
          type="password"
          placeholder={hasKey ? "••••••••••••" : "sk-…"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
        />
        <label className="label">模型</label>
        <input
          className="input"
          placeholder="deepseek-chat"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button className="btn" disabled={busy} onClick={save}>
            保存
          </button>
          <button className="btn ghost" disabled={busy} onClick={test}>
            测试连接
          </button>
        </div>

        {message && (
          <p className={message.ok ? "hint-ok" : "hint-err"} style={{ fontSize: 13.5 }}>
            {message.text}
          </p>
        )}
      </div>

      <p className="muted" style={{ marginTop: 14, lineHeight: 1.7 }}>
        OpenAI 兼容协议（DeepSeek / GLM / Qwen / Moonshot / OpenRouter…）。
        保存后下一回合即生效，无需重启。改了配置，正在进行的对话不受影响。
      </p>
    </div>
  );
}
