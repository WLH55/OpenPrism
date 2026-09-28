import { useCallback, useEffect, useState } from "react";
import { api, api2, type AgentBindingLoose, type AgentLoose, type McpLoose, type ModelProvider, type SkillLoose } from "../api";
import { ArrowLeftIcon } from "../icons";
import { Toggle } from "../ui";
import { AgentWizard } from "../components/AgentWizard";
import { FaceAvatar, FaceEditor } from "../components/FaceEditor";
import { SOUL_TEMPLATES } from "../soulTemplates";

const BUILTIN_TOOLS: { name: string; label: string; hint?: string }[] = [
  { name: "record_flow", label: "记账" },
  { name: "create_plan", label: "建计划" },
  { name: "checkin_plan", label: "打卡" },
  { name: "query_ledger", label: "查询统计", hint: "读账本，只读" },
];

/** 伙伴列表页：FaceAvatar 卡片 + 五步向导新建（身份→灵魂→心智→资料库→审阅） */
export function Agents({ onEdit, onCreated }: { onEdit: (id: string) => void; onCreated: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [wizard, setWizard] = useState(false);

  const reload = useCallback(async () => setAgents(await api2.listAgents()), []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  if (wizard) {
    return (
      <AgentWizard
        onCancel={() => setWizard(false)}
        onDone={(id) => {
          setWizard(false);
          onCreated(id);
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">自定义伙伴 · 共享同一份对你的记忆</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">伙伴</h1>
        </div>
        <button
          className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
          onClick={() => setWizard(true)}
        >
          ＋ 新建伙伴
        </button>
      </header>

      {/* 伙伴卡片列表 */}
      <div className="space-y-3">
        {agents.length === 0 && <p className="text-sm text-ink3">还没有自定义伙伴——点右上「新建伙伴」，五步配出一个。</p>}
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="w-full rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent3"
            onClick={() => onEdit(agent.id)}
          >
            <div className="flex items-center gap-3">
              <FaceAvatar name={agent.name} face={agent.identity} size={44} />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-ink">{agent.name}</div>
                <div className="truncate text-xs text-ink3">{agent.identity.description || `创建于 ${new Date(agent.createdTs).toLocaleDateString()}`}</div>
              </div>
              <span className="rounded-full bg-surface2 px-2.5 py-1 text-xs text-ink3">点击编辑</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink3">
              <span className="rounded-md bg-surface2 px-2 py-1">{agent.binding.tools?.length ?? 4} 个工具</span>
              <span className="rounded-md bg-surface2 px-2 py-1">{agent.binding.skills.length} 个技能</span>
              <span className="rounded-md bg-surface2 px-2 py-1">{agent.binding.mcps.length} 个 MCP</span>
              {agent.identity.language === "zh" && <span className="rounded-md bg-surface2 px-2 py-1">中文</span>}
              {agent.identity.language === "en" && <span className="rounded-md bg-surface2 px-2 py-1">English</span>}
            </div>
          </button>
        ))}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-ink3">
        会话里可随时切换伙伴（聊天页右上「切换伙伴」）；每条消息归属它当时的伙伴，历史不丢。记忆对所有伙伴共享。
      </p>
    </div>
  );
}

/** 伙伴编辑页（单页配置，与向导同字段）：身份 / 灵魂 / 心智 / 资料库 */
export function AgentEdit({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const [agent, setAgent] = useState<AgentLoose | null>(null);
  const [persona, setPersona] = useState("");
  const [binding, setBinding] = useState<AgentBindingLoose>({ skills: [], mcps: [] });
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [mcps, setMcps] = useState<McpLoose[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [identityDraft, setIdentityDraft] = useState<{ name: string; description: string; language: string; modelProviderId: string } | null>(null);
  const [face, setFace] = useState<{ emoji: string; color: string; avatar: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const detail = await api2.getAgent(agentId);
    setAgent(detail);
    setPersona(detail.persona);
    setBinding(detail.binding ?? { skills: [], mcps: [] });
    setIdentityDraft({
      name: detail.name,
      description: detail.identity.description,
      language: detail.identity.language,
      modelProviderId: detail.identity.modelProviderId ?? "",
    });
    setFace({ emoji: detail.identity.emoji, color: detail.identity.color, avatar: detail.identity.avatar ?? "" });
    setSkills(await api2.listSkills());
    setMcps(await api2.listMcps());
    void api.getModels().then((r) => setProviders(r.providers)).catch(() => undefined);
  }, [agentId]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  if (!agent || !identityDraft || !face) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <p className="text-sm text-ink3">加载中…</p>
      </div>
    );
  }

  const saveIdentity = async () => {
    try {
      await api2.updateAgentIdentity(agent.id, {
        name: identityDraft.name,
        description: identityDraft.description,
        language: identityDraft.language,
        modelProviderId: identityDraft.modelProviderId,
        emoji: face.emoji,
        color: face.color,
        avatar: face.avatar,
      });
      setMessage("身份已保存（名字/描述/形象/语言下一步生效；默认模型对本伙伴的既有会话即时生效）");
      await reload();
    } catch (e) {
      setMessage(`保存失败：${(e as Error).message}`);
    }
  };

  const saveSoul = async () => {
    try {
      await api2.updatePersona(agent.id, persona);
      setMessage("灵魂已保存（下一步生效）");
      await reload();
    } catch (e) {
      setMessage(`保存失败：${(e as Error).message}`);
    }
  };

  const saveBinding = async () => {
    try {
      await api2.updateBinding(agent.id, binding);
      setMessage("能力绑定已保存（新对话/重启后装配生效）");
      await reload();
    } catch (e) {
      setMessage(`保存失败：${(e as Error).message}`);
    }
  };

  const toolEnabled = (name: string): boolean =>
    !binding.tools || binding.tools.length === 0 || binding.tools.includes(name);
  const toggleTool = (name: string) => {
    const current = binding.tools && binding.tools.length > 0 ? [...binding.tools] : BUILTIN_TOOLS.map((t) => t.name);
    const next = current.includes(name) ? current.filter((t) => t !== name) : [...current, name];
    setBinding({ ...binding, tools: next });
  };
  const toggleId = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const remove = async () => {
    if (!window.confirm(`删除伙伴「${agent.name}」？它的会话仍在，只是切回默认助手。`)) return;
    await api2.deleteAgent(agent.id);
    onBack();
  };

  const inputCls =
    "w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3";
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-accent bg-accent3 font-medium text-accent" : "border-line text-ink2 hover:border-accent hover:text-ink"}`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <button className="mb-2 flex items-center gap-1 text-sm text-ink2 transition hover:text-ink" onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4" />
          返回伙伴
        </button>
        <div className="flex items-center gap-3">
          <FaceAvatar name={agent.name} face={agent.identity} size={44} />
          <h1 className="text-2xl font-semibold tracking-tight text-ink">编辑伙伴 · {agent.name}</h1>
        </div>
        <p className="mt-1 text-xs text-ink3">身份 / 灵魂 / 心智 / 资料库——与创建向导同字段，改完下一步生效</p>
      </header>
      {message && <p className="mb-4 text-sm text-ink3">{message}</p>}

      {/* ① 身份 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink">① 身份</h2>
        <div className="grid grid-cols-2 gap-2">
          <input className={inputCls} placeholder="名称" value={identityDraft.name} onChange={(e) => setIdentityDraft({ ...identityDraft, name: e.target.value })} />
          <select className={inputCls} value={identityDraft.language} onChange={(e) => setIdentityDraft({ ...identityDraft, language: e.target.value })}>
            <option value="">自动（跟随你的语言）</option>
            <option value="zh">始终中文</option>
            <option value="en">始终英文</option>
          </select>
        </div>
        <input
          className={`${inputCls} mt-2`}
          placeholder="描述（这个伙伴是做什么的）"
          value={identityDraft.description}
          onChange={(e) => setIdentityDraft({ ...identityDraft, description: e.target.value })}
        />
        <div className="mt-3">
          <FaceEditor value={face} onChange={setFace} />
        </div>
        <div className="mt-3">
          <label className="mb-1.5 block text-sm font-medium text-ink">默认模型</label>
          <select
            className={inputCls}
            value={identityDraft.modelProviderId}
            onChange={(e) => setIdentityDraft({ ...identityDraft, modelProviderId: e.target.value })}
          >
            <option value="">跟随会话 / 全局</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.platform || "自定义"} · {p.model}
              </option>
            ))}
          </select>
        </div>
        <button className="mt-3 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90" onClick={() => void saveIdentity()}>
          保存身份
        </button>
      </section>

      {/* ② 灵魂 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">② 灵魂 · 自由 markdown</h2>
          <div className="flex gap-1.5">
            {SOUL_TEMPLATES.map((t) => (
              <button key={t.id} type="button" className="text-xs text-accent hover:underline" onClick={() => setPersona(t.content)}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
        <textarea
          rows={9}
          placeholder={"## 语气\n…"}
          className={`${inputCls} resize-y font-mono text-sm leading-relaxed`}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
        />
        <button className="mt-2 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90" onClick={() => void saveSoul()}>
          保存灵魂
        </button>
      </section>

      {/* ③ 心智 + ④ 资料库 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">③ 工具面（内置）</h2>
        <div className="flex flex-wrap gap-2">
          {BUILTIN_TOOLS.map((t) => (
            <button key={t.name} type="button" className={chip(toolEnabled(t.name))} onClick={() => toggleTool(t.name)} title={t.hint}>
              {t.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-ink3">全不选 = 不限制（四个都可用）。</p>

        <h2 className="mb-2 mt-4 text-sm font-semibold text-ink">MCP 工具</h2>
        {mcps.length === 0 ? (
          <p className="text-xs text-ink3">未配置 MCP。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {mcps.map((m) => (
              <button key={m.id} type="button" className={chip(binding.mcps.includes(m.id))} onClick={() => setBinding({ ...binding, mcps: toggleId(binding.mcps, m.id) })}>
                {m.name}
              </button>
            ))}
          </div>
        )}

        <h2 className="mb-2 mt-4 text-sm font-semibold text-ink">④ 资料库 · 技能</h2>
        {skills.length === 0 ? (
          <p className="text-xs text-ink3">未安装技能。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {skills.map((s) => (
              <button key={s.id} type="button" className={chip(binding.skills.includes(s.id))} title={s.description} onClick={() => setBinding({ ...binding, skills: toggleId(binding.skills, s.id) })}>
                {s.name}
              </button>
            ))}
          </div>
        )}
        <button className="mt-3 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90" onClick={() => void saveBinding()}>
          保存能力
        </button>
      </section>

      <button className="text-sm text-warm transition hover:opacity-80" onClick={() => void remove()}>
        删除这个伙伴
      </button>
    </div>
  );
}
