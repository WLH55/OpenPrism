import { useEffect, useState } from "react";
import { api, api2, type AgentBindingLoose, type McpLoose, type ModelProvider, type SkillLoose } from "../api";
import { SOUL_TEMPLATES } from "../soulTemplates";
import { ArrowLeftIcon } from "../icons";
import { FaceEditor, FaceAvatar, type FaceValue } from "./FaceEditor";

// 伙伴创建五步向导（对齐 DeepTutor）：①身份 ②灵魂 ③心智 ④资料库 ⑤审阅。
// 心智 = 默认模型（会话绑定 > 伙伴默认 > 全局激活）+ MCP 工具面；资料库 = 技能挂载（bindings_json）。

const STEPS = ["身份", "灵魂", "心智", "资料库", "审阅"];

const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3";

export function AgentWizard({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ① 身份
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [face, setFace] = useState<FaceValue>({ emoji: "🦊", color: "#b0501e", avatar: "" });
  const [language, setLanguage] = useState("");

  // ② 灵魂
  const [persona, setPersona] = useState("");
  const [soulSource, setSoulSource] = useState<string>("");

  // ③ 心智 / ④ 资料库
  const [modelProviderId, setModelProviderId] = useState<string>(""); // "" = 跟随会话/全局
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [mcps, setMcps] = useState<McpLoose[]>([]);
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);

  useEffect(() => {
    void api.getModels().then((r) => setProviders(r.providers)).catch(() => undefined);
    void api2.listMcps().then(setMcps).catch(() => undefined);
    void api2.listSkills().then((list) => {
      setSkills(list);
      setSkillIds(list.map((s) => s.id)); // 向导默认全选技能（DeepTutor preselect 同款）
    }).catch(() => undefined);
  }, []);

  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const canContinue = step !== 0 || name.trim() !== "";

  const submit = async () => {
    setBusy(true);
    setError(null);
    const binding: AgentBindingLoose = { skills: skillIds, mcps: mcpIds };
    try {
      const created = await api2.createAgent({
        name: name.trim(),
        persona: persona.trim() || "（向导创建，灵魂待补充）",
        description: description.trim(),
        emoji: face.emoji,
        color: face.color,
        ...(face.avatar ? { avatar: face.avatar } : {}),
        language,
        modelProviderId: modelProviderId === "" ? null : modelProviderId,
        binding,
      });
      onDone(created.id);
    } catch (e) {
      setError(`创建失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-accent bg-accent3 font-medium text-accent" : "border-line text-ink2 hover:border-accent hover:text-ink"}`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <button className="mb-2 flex items-center gap-1 text-sm text-ink2 transition hover:text-ink" onClick={onCancel}>
          <ArrowLeftIcon className="h-4 w-4" />
          返回伙伴
        </button>
        {/* 步骤条 */}
        <div className="flex items-center gap-1.5">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  i === step ? "bg-accent2 text-white" : i < step ? "bg-accent3 text-accent" : "bg-surface2 text-ink3"
                }`}
              >
                {i + 1}
              </span>
              <span className={`text-sm ${i === step ? "font-medium text-ink" : "text-ink3"}`}>{label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 text-ink3">—</span>}
            </div>
          ))}
        </div>
      </header>

      {/* ① 身份 */}
      {step === 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-ink">这个伙伴是谁？</h2>
            <p className="mt-1 text-sm text-ink3">先取个名字、选个形象——其余以后都能改。</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">名称</label>
            <input className={inputCls} placeholder="例如 小伴" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">描述</label>
            <input className={inputCls} placeholder="这个伙伴是做什么的？" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">形象</label>
            <FaceEditor value={face} onChange={setFace} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">回复语言</label>
            <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">自动（跟随你的语言）</option>
              <option value="zh">始终中文</option>
              <option value="en">始终英文</option>
            </select>
          </div>
        </div>
      )}

      {/* ② 灵魂 */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-ink">赋予它灵魂</h2>
            <p className="mt-1 text-sm text-ink3">从模板起步，或直接自己写——这段文字就是它的灵魂（只写性格与做事方式，名字等固定信息在第①步，之后可随时改）。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={chip(soulSource === "")} onClick={() => { setSoulSource(""); setPersona(""); }}>
              空白自写
            </button>
            {SOUL_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={chip(soulSource === t.id)}
                onClick={() => {
                  setSoulSource(t.id);
                  setPersona(t.content);
                }}
              >
                {t.name}
              </button>
            ))}
          </div>
          <textarea
            rows={14}
            className={`${inputCls} resize-y font-mono text-sm leading-relaxed`}
            placeholder={"## 语气\n…\n\n## 我怎么帮你\n…\n\n## 边界\n…"}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
        </div>
      )}

      {/* ③ 心智 */}
      {step === 2 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-ink">塑造它的心智</h2>
            <p className="mt-1 text-sm text-ink3">默认模型（会话里临时选择优先于这里）+ 可用的 MCP 工具面。</p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-sm text-ink transition hover:border-accent">
              <input type="radio" checked={modelProviderId === ""} onChange={() => setModelProviderId("")} />
              <span>
                跟随会话 / 全局
                <span className="ml-2 text-xs text-ink3">未指定时用左下角「模型接入」里的当前启用模型</span>
              </span>
            </label>
            {providers.map((p) => (
              <label key={p.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-sm text-ink transition hover:border-accent">
                <input type="radio" checked={modelProviderId === p.id} onChange={() => setModelProviderId(p.id)} />
                <span className="min-w-0">
                  {p.platform || "自定义"} · {p.model}
                  <span className="ml-2 text-xs text-ink3">{p.hasKey ? "Key 已配置" : "未配 Key"}</span>
                </span>
              </label>
            ))}
            {providers.length === 0 && <p className="text-xs text-warm">还没有配置任何模型——可先跳过，稍后去「模型接入」添加。</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">MCP 工具（可多选）</label>
            {mcps.length === 0 ? (
              <p className="text-xs text-ink3">未配置 MCP 服务——可在「技能 / MCP」页添加。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {mcps.map((m) => (
                  <button key={m.id} type="button" className={chip(mcpIds.includes(m.id))} onClick={() => setMcpIds(toggle(mcpIds, m.id))}>
                    {m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ④ 资料库 */}
      {step === 3 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-ink">交给它一些知识</h2>
            <p className="mt-1 text-sm text-ink3">选中的技能会挂载给这个伙伴（技能目录进 system prompt，按需 load_skill 取全文）。</p>
          </div>
          {skills.length === 0 ? (
            <p className="text-xs text-ink3">还没有技能——可先跳过，稍后在「技能 / MCP」页安装。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {skills.map((s) => (
                <button key={s.id} type="button" className={chip(skillIds.includes(s.id))} onClick={() => setSkillIds(toggle(skillIds, s.id))} title={s.description}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ⑤ 审阅 */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <FaceAvatar name={name || "?"} face={face} size={56} />
            <div>
              <h2 className="text-xl font-semibold text-ink">准备好认识 {name || "它"} 了吗？</h2>
              <p className="mt-0.5 text-sm text-ink3">以下配置创建后都能改。</p>
            </div>
          </div>
          <dl className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
            {[
              ["名称", name || "—"],
              ["描述", description || "—"],
              ["语言", language === "zh" ? "始终中文" : language === "en" ? "始终英文" : "自动跟随"],
              ["灵魂", persona.trim() === "" ? "（待补充）" : `${persona.trim().split("\n")[0]!.slice(0, 24)}…（${persona.length} 字）`],
              ["默认模型", modelProviderId === "" ? "跟随会话 / 全局" : (providers.find((p) => p.id === modelProviderId)?.model ?? modelProviderId)],
              ["MCP 工具", mcpIds.length === 0 ? "无" : `${mcpIds.length} 个`],
              ["技能", skillIds.length === 0 ? "无" : `${skillIds.length} 个`],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <dt className="w-20 shrink-0 text-ink3">{k}</dt>
                <dd className="min-w-0 flex-1 truncate text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          {error && <p className="text-sm text-warm">{error}</p>}
        </div>
      )}

      {/* 底部导航 */}
      <div className="mt-6 flex items-center justify-between">
        <button className="text-sm text-ink3 transition hover:text-ink disabled:opacity-40" disabled={step === 0} onClick={() => setStep(step - 1)}>
          上一步
        </button>
        {step < STEPS.length - 1 ? (
          <button
            className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            disabled={!canContinue}
            onClick={() => setStep(step + 1)}
          >
            继续 →
          </button>
        ) : (
          <button
            className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            disabled={busy || name.trim() === ""}
            onClick={() => void submit()}
          >
            {busy ? "创建中…" : "创建伙伴"}
          </button>
        )}
      </div>
    </div>
  );
}
