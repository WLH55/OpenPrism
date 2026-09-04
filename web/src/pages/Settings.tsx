import { useEffect, useState } from "react";
import { api } from "../api";
import { InfoIcon } from "../icons";

const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-[15px] text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent3";

/** 模型接入页：BYOK 横幅 + 表单 + 测试连接，结构照 prototype 页 11 */
export function Settings() {
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
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
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">BYOK · 平台永不提供 Key</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">模型接入</h1>
      </header>

      {/* BYOK 说明横幅 */}
      <div className="mb-5 flex gap-2.5 rounded-xl border border-accent3 bg-accent3/50 px-4 py-3">
        <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p className="text-sm leading-relaxed text-ink2">
          Key 由你自己提供，只发往你配置的 baseURL，永不进日志、永不上传。数据存在你自己的设备上。
        </p>
      </div>

      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="base-url">baseURL</label>
          <input
            id="base-url"
            className={inputCls}
            placeholder="https://api.deepseek.com"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="api-key">
            API Key {hasKey && <span className="font-normal text-ink3">（已配置，留空 = 不变）</span>}
          </label>
          <div className="flex gap-2">
            <input
              id="api-key"
              type={showKey ? "text" : "password"}
              className={`min-w-0 flex-1 ${inputCls}`}
              placeholder={hasKey ? "sk-••••••••••••••••" : "sk-…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink2 transition hover:text-ink"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink3">加密存储在你自己设备上，不上传任何地方。</p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="model-name">模型</label>
          <input
            id="model-name"
            className={inputCls}
            placeholder="deepseek-chat"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent2 px-4 py-2.5 text-[15px] font-semibold text-white transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
          >
            保存
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[15px] font-medium text-ink transition hover:bg-surface2 disabled:opacity-60"
            onClick={() => void test()}
          >
            测试连接
          </button>
        </div>
        {message && <p className={`text-sm ${message.ok ? "text-accent" : "text-warm"}`}>{message.text}</p>}
      </form>

      <p className="mt-6 text-xs leading-relaxed text-ink3">
        OpenAI 兼容协议（DeepSeek / GLM / Qwen / Moonshot / OpenRouter…）。保存后下一回合即生效，无需重启。
      </p>
    </div>
  );
}
