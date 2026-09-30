import { useEffect, useState } from "react";
import { api, api2, type ModelProvider } from "../api";
import { InfoIcon } from "../icons";

const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-[15px] text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent3";

/** baseURL → 平台显示名（与服务端 platformFromBaseURL 同表的本地预览；落库以服务端推导为准） */
const PLATFORM_PATTERNS: [RegExp, string][] = [
  [/deepseek/i, "DeepSeek"],
  [/bigmodel\.cn|zhipu/i, "智谱 GLM"],
  [/dashscope|aliyuncs/i, "通义千问 Qwen"],
  [/moonshot/i, "Moonshot Kimi"],
  [/openrouter/i, "OpenRouter"],
  [/openai\.com/i, "OpenAI"],
  [/siliconflow/i, "硅基流动"],
  [/volces\.com/i, "火山方舟"],
  [/minimax/i, "MiniMax"],
  [/baidu|qianfan/i, "百度千帆"],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0/i, "本地服务"],
];

function derivePlatform(baseURL: string): string {
  for (const [pattern, name] of PLATFORM_PATTERNS) {
    if (pattern.test(baseURL)) return name;
  }
  try {
    return new URL(baseURL).hostname;
  } catch {
    return "";
  }
}

function formatWindow(n: number | null): string {
  if (n === null) return "默认 64K";
  return n % 1000 === 0 ? `${Math.round(n / 1000)}K` : `${n}`;
}

/** 对话用途的窗口档位（embedding 用途直接填数字，不走档位） */
const CHAT_WINDOW_CHOICES = ["32768", "65536", "131072", "200000"];

/** 平台预置（数据移植自 Tencent WeKnora 的厂商清单，按聊天场景补上下文窗口；baseURL/模型名为公开事实信息） */
interface ModelPreset {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  contextWindow: number | null; // null = 各模型不同，用默认 64K 手动调
  desc: string;
}

const MODEL_PRESETS: ModelPreset[] = [
  { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com", model: "deepseek-chat", contextWindow: 128000, desc: "deepseek-chat / deepseek-reasoner" },
  { id: "zhipu", label: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7", contextWindow: 200000, desc: "glm-4.7 / glm-4.6 / glm-4.5-air" },
  { id: "aliyun", label: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", contextWindow: 131072, desc: "qwen-plus / qwen-max / qwen3 系列" },
  { id: "moonshot", label: "Moonshot Kimi", baseURL: "https://api.moonshot.cn/v1", model: "kimi-k2.5", contextWindow: 256000, desc: "kimi-k2.5 / kimi-k2 系列" },
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-5.2", contextWindow: 400000, desc: "gpt-5.2 / gpt-5-mini（按具体型号核对窗口）" },
  { id: "gemini", label: "Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3-flash-preview", contextWindow: 1000000, desc: "gemini-3-flash-preview / gemini-3-pro（1M 窗口）" },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", model: "openai/gpt-5.2-chat", contextWindow: null, desc: "聚合 100+ 厂商；窗口因模型而异，按模型页核对" },
  { id: "siliconflow", label: "硅基流动", baseURL: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3.2", contextWindow: null, desc: "DeepSeek / Qwen / GLM 开源模型托管；窗口因模型而异" },
  { id: "nvidia", label: "NVIDIA NIM", baseURL: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct", contextWindow: null, desc: "NIM 托管的开源模型" },
  { id: "novita", label: "Novita AI", baseURL: "https://api.novita.ai/openai/v1", model: "moonshotai/kimi-k2.5", contextWindow: null, desc: "kimi-k2.5 / glm-5 / minimax-m2.7 等" },
  { id: "litellm", label: "LiteLLM 代理", baseURL: "http://localhost:4000/v1", model: "", contextWindow: null, desc: "自托管统一网关（请把占位 URL 换成你的代理地址）" },
  { id: "ollama", label: "本地 Ollama", baseURL: "http://localhost:11434/v1", model: "", contextWindow: null, desc: "本机 Ollama 的 OpenAI 兼容端点；窗口按拉取的模型填" },
];

interface FormState {
  open: boolean;
  editingId: string | null;
  presetId: string | null;
  baseURL: string;
  model: string;
  apiKey: string;
  windowChoice: string; // "default" | "32768" | "65536" | "131072" | "200000" | "custom"
  customWindow: string;
  kind: string; // "chat" | "embedding"（提供方用途，2026-09-18）
  multimodal: boolean; // 该模型是否支持图片识别（对话里发图的前提）
}

const EMPTY_FORM: FormState = { open: false, editingId: null, presetId: null, baseURL: "", model: "", apiKey: "", windowChoice: "default", customWindow: "", kind: "chat", multimodal: false };

/** 模型接入页：BYOK 横幅 + 多供应商平级列表（测试/编辑/删除）+ 预置新增表单；用哪个模型在会话里选 */
export function Settings() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [memoryConfig, setMemoryConfig] = useState<{ interestThreshold: number; embeddingProviderId: string | null }>({ interestThreshold: 3, embeddingProviderId: null });

  const reload = () => {
    api
      .getModels()
      .then((result) => setProviders(result.providers))
      .catch(() => undefined);
    api2
      .getMemory()
      .then((overview) => {
        if (overview.config) setMemoryConfig(overview.config);
      })
      .catch(() => undefined);
  };

  useEffect(reload, []);

  const editing = form.editingId !== null ? providers.find((p) => p.id === form.editingId) : undefined;

  const openCreate = () => setForm({ ...EMPTY_FORM, open: true });
  const openEdit = (provider: ModelProvider) => {
    const kind = provider.kind === "embedding" ? "embedding" : "chat";
    const window = provider.contextWindow === null ? "" : String(provider.contextWindow);
    const fromChoice = kind === "chat" && CHAT_WINDOW_CHOICES.includes(window);
    setForm({
      open: true,
      editingId: provider.id,
      presetId: null,
      baseURL: provider.baseURL,
      model: provider.model,
      apiKey: "",
      kind,
      multimodal: provider.multimodal,
      windowChoice: window === "" ? "default" : fromChoice ? window : "custom",
      customWindow: window === "" || fromChoice ? "" : window,
    });
  };
  const closeForm = () => setForm(EMPTY_FORM);

  const applyPreset = (preset: ModelPreset) =>
    setForm({
      ...form,
      open: true,
      presetId: preset.id,
      baseURL: preset.baseURL,
      model: preset.model,
      ...(form.kind === "chat"
        ? { windowChoice: preset.contextWindow === null ? "default" : String(preset.contextWindow), customWindow: "" }
        : {}),
    });

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const contextWindow =
      form.kind === "embedding"
        ? form.customWindow.trim() === ""
          ? null
          : Number(form.customWindow)
        : form.windowChoice === "default"
          ? null
          : form.windowChoice === "custom"
            ? Number(form.customWindow)
            : Number(form.windowChoice);
    const multimodal = form.kind === "chat" ? form.multimodal : false;
    try {
      if (form.editingId !== null) {
        await api.updateModel(form.editingId, {
          baseURL: form.baseURL.trim(),
          model: form.model.trim(),
          contextWindow,
          kind: form.kind,
          multimodal,
          ...(form.apiKey.trim() !== "" ? { apiKey: form.apiKey.trim() } : {}),
        });
        setMessage({ ok: true, text: "已更新（Key 加密存储在你自己的设备上）" });
      } else {
        await api.addModel({
          baseURL: form.baseURL.trim(),
          model: form.model.trim(),
          contextWindow,
          kind: form.kind,
          multimodal,
          ...(form.apiKey.trim() !== "" ? { apiKey: form.apiKey.trim() } : {}),
        });
        setMessage({ ok: true, text: "已新增（首个供应商自动启用；Key 加密存储在你自己的设备上）" });
      }
      closeForm();
      reload();
    } catch (e) {
      setMessage({ ok: false, text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const saveMemoryConfig = async (patch: { interestThreshold?: number | null; embeddingProviderId?: string | null }) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api2.patchMemoryConfig(patch);
      setMemoryConfig(result.config);
      setMessage({ ok: true, text: "记忆设置已保存" });
    } catch (e) {
      setMessage({ ok: false, text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: ModelProvider) => {
    if (!window.confirm(`删除 ${provider.platform || provider.baseURL} · ${provider.model}？`)) return;
    setBusy(true);
    try {
      await api.deleteModel(provider.id);
      reload();
    } catch (e) {
      setMessage({ ok: false, text: `删除失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.testModel(id);
      setMessage(result.ok ? { ok: true, text: "连接成功" } : { ok: false, text: `连接失败：${result.error ?? "未知错误"}` });
    } catch (e) {
      setMessage({ ok: false, text: `连接失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const platformPreview = derivePlatform(form.baseURL.trim());
  const selectedPreset = MODEL_PRESETS.find((p) => p.id === form.presetId);

  const providerLine = (p: ModelProvider): string => `${p.platform || derivePlatform(p.baseURL) || "自定义"} · ${p.model}`;

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

      {/* 已接入模型（平级列表；用哪个在会话右上角选） */}
      <div className="mb-4 space-y-2">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">
                {providerLine(p)}
                {p.kind === "embedding" && <span className="ml-2 rounded-full bg-accent3 px-1.5 py-0.5 text-[11px] font-normal text-accent">向量</span>}
                {p.kind === "chat" && p.multimodal && <span className="ml-2 rounded-full bg-accent3 px-1.5 py-0.5 text-[11px] font-normal text-accent">图片</span>}
              </div>
              <div className="mt-0.5 truncate font-mono text-xs text-ink3">
                {p.baseURL} ·{" "}
                {p.kind === "embedding"
                  ? p.contextWindow === null
                    ? "输入上限未填"
                    : `输入上限 ${p.contextWindow}`
                  : `窗口 ${formatWindow(p.contextWindow)}`}
                {p.hasKey ? " · Key 已配置" : " · 未配 Key"}
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-accent px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent3 disabled:opacity-60"
                onClick={() => void test(p.id)}
              >
                测试连接
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink2 transition hover:text-ink disabled:opacity-60"
                onClick={() => openEdit(p)}
              >
                编辑
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-warm transition hover:bg-warm/10 disabled:opacity-60"
                onClick={() => void remove(p)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-4 py-4 text-center text-sm text-ink2">
            还没有配置模型。点击下方新增一个平台接入，然后在对话页右上角选用。
          </div>
        )}
      </div>

      {/* 新增入口 */}
      {!form.open && (
        <button
          type="button"
          disabled={busy}
          className="w-full rounded-xl border border-dashed border-line px-4 py-3 text-sm font-medium text-ink2 transition hover:border-accent hover:text-ink disabled:opacity-60"
          onClick={openCreate}
        >
          ＋ 新增平台接入
        </button>
      )}

      {/* 新增/编辑表单 */}
      {form.open && (
        <form
          className="space-y-4 rounded-xl border border-line bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="text-sm font-semibold text-ink">{form.editingId !== null ? "编辑模型接入" : "新增平台接入"}</div>
          <div>
            <div className="mb-1.5 text-sm font-medium text-ink">从预置快速填入</div>
            <div className="flex flex-wrap gap-1.5">
              {MODEL_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    form.presetId === preset.id
                      ? "border-accent bg-accent3 font-medium text-accent"
                      : "border-line text-ink2 hover:border-accent hover:text-ink"
                  }`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {selectedPreset && <p className="mt-1.5 text-xs text-ink3">推荐模型：{selectedPreset.desc}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="base-url">baseURL</label>
            <input
              id="base-url"
              className={inputCls}
              placeholder="https://api.deepseek.com"
              value={form.baseURL}
              onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
            />
            {platformPreview !== "" && <p className="mt-1.5 text-xs text-accent">识别平台：{platformPreview}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="api-key">
              API Key {form.editingId !== null && <span className="font-normal text-ink3">（留空 = 不变）</span>}
            </label>
            <input
              id="api-key"
              type="password"
              className={inputCls}
              placeholder={editing?.hasKey ? "sk-••••••••••••••••" : "sk-…"}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              autoComplete="off"
            />
            <p className="mt-1.5 text-xs text-ink3">加密存储在你自己设备上，不上传任何地方。</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="model-name">模型</label>
            <input
              id="model-name"
              className={inputCls}
              placeholder="deepseek-chat"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="provider-kind">用途</label>
            <select
              id="provider-kind"
              className={`${inputCls} font-sans`}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value, windowChoice: "default", customWindow: "" })}
            >
              <option value="chat">对话与提取（chat）</option>
              <option value="embedding">记忆向量（embedding）</option>
            </select>
            <p className="mt-1.5 text-xs text-ink3">embedding 用途用于记忆的语义召回，不参与对话上下文压缩。</p>
          </div>
          {form.kind === "chat" && (
            <div className="rounded-xl border border-line bg-surface2 px-3.5 py-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent2)]"
                  checked={form.multimodal}
                  onChange={(e) => setForm({ ...form, multimodal: e.target.checked })}
                />
                <span>
                  <span className="block text-sm font-medium text-ink">支持图片识别（多模态）</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink3">
                    勾选后可以在对话里发图片。按这个模型的真实能力填：模型说明里写了支持视觉输入才勾。
                  </span>
                </span>
              </label>
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink" htmlFor="context-window">
              {form.kind === "embedding" ? "单次输入上限（tokens）" : "上下文窗口（tokens）"}
            </label>
            {form.kind === "embedding" ? (
              <>
                <input
                  id="context-window"
                  aria-label="embedding 单次输入上限"
                  className={inputCls}
                  type="number"
                  min={1}
                  step={1}
                  placeholder="如 1024"
                  value={form.customWindow}
                  onChange={(e) => setForm({ ...form, customWindow: e.target.value })}
                />
                <p className="mt-1.5 text-xs text-ink3">embedding 模型的输入长度上限，按模型规格填；只作记录，记忆召回不做上下文压缩。</p>
              </>
            ) : (
              <>
                <select
                  id="context-window"
                  className={`${inputCls} font-sans`}
                  value={form.windowChoice}
                  onChange={(e) => setForm({ ...form, windowChoice: e.target.value })}
                >
                  <option value="default">默认（64K）</option>
                  <option value="32768">32K</option>
                  <option value="65536">64K</option>
                  <option value="131072">128K</option>
                  <option value="200000">200K</option>
                  <option value="custom">自定义…</option>
                </select>
                {form.windowChoice === "custom" && (
                  <input
                    aria-label="自定义上下文窗口"
                    className={`${inputCls} mt-2`}
                    type="number"
                    min={1000}
                    step={1}
                    placeholder="如 16384"
                    value={form.customWindow}
                    onChange={(e) => setForm({ ...form, customWindow: e.target.value })}
                  />
                )}
                <p className="mt-1.5 text-xs text-ink3">对话接近该窗口的 80% 时自动压缩历史；按你模型的真实窗口填。</p>
              </>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent2 px-4 py-2.5 text-[15px] font-semibold text-white transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
            >
              {form.editingId !== null ? "保存修改" : "保存"}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[15px] font-medium text-ink transition hover:bg-surface2 disabled:opacity-60"
              onClick={closeForm}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {message && <p className={`text-sm ${message.ok ? "text-accent" : "text-warm"}`}>{message.text}</p>}

      {/* 记忆增强（可选）：语义召回绑定 + 兴趣晋升阈值 */}
      <div className="mt-6 rounded-xl border border-line bg-surface p-4">
        <div className="text-sm font-semibold text-ink">记忆增强（可选）</div>
        <p className="mt-1 text-xs leading-relaxed text-ink3">
          选一个 embedding 提供方后，记忆按语义而不只是字面召回（问「怎么控制体重」也能想起「在减脂」）；
          不选则只用字面匹配。旧记忆的向量每晚自动补算，每轮最多 200 条。
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">语义召回提供方</span>
            <select
              aria-label="记忆语义召回提供方"
              className={`${inputCls} font-sans`}
              value={memoryConfig.embeddingProviderId ?? ""}
              disabled={busy}
              onChange={(e) => void saveMemoryConfig({ embeddingProviderId: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">不开启（只用字面匹配）</option>
              {providers
                .filter((p) => p.kind === "embedding")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {providerLine(p)}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">主题晋升兴趣的次数门槛</span>
            <input
              aria-label="主题晋升次数门槛"
              className={inputCls}
              type="number"
              min={1}
              max={20}
              value={memoryConfig.interestThreshold}
              disabled={busy}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 20) void saveMemoryConfig({ interestThreshold: n });
              }}
            />
            <span className="mt-1.5 block text-xs text-ink3">同一主题被谈起这么多次后，自动记为长期兴趣。</span>
          </label>
        </div>
      </div>

      {/* 数据导出（2026-09-30 SDD 数据导出）：透明，而且带得走 */}
      <div className="mt-6 rounded-xl border border-line bg-surface p-4">
        <div className="text-sm font-semibold text-ink">数据导出</div>
        <p className="mt-1 text-xs leading-relaxed text-ink3">
          你的流水、计划（含打卡）与全部对话随时可以导出带走：JSON 是全量备份（含历史与作废记录，机器可读），
          Markdown 是按日期整理的时间线（可直接当日记翻，对话含你与助手的往来发言）。不绑架、不锁定。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
            href={api2.exportDataUrl("json")}
            download
          >
            导出 JSON 全量备份
          </a>
          <a
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink2 transition hover:border-accent hover:text-ink"
            href={api2.exportDataUrl("md")}
            download
          >
            导出 Markdown 时间线
          </a>
          <a
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink2 transition hover:border-accent hover:text-ink"
            href={api2.exportMemoryUrl()}
            download
          >
            导出长期记忆
          </a>
        </div>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-ink3">
        OpenAI 兼容协议（DeepSeek / GLM / Qwen / Moonshot / OpenRouter…）。可接入多个平台；每个会话用哪个模型，在对话页右上角的模型选择器里选。保存后下一回合即生效，无需重启。
      </p>
    </div>
  );
}
