import { useCallback, useEffect, useState } from "react";
import { api2, type AgentBindingLoose, type AgentLoose, type McpLoose, type SkillLoose } from "../api";
import { ArrowLeftIcon } from "../icons";
import { Toggle } from "../ui";

const BUILTIN_TOOLS: { name: string; label: string; hint?: string }[] = [
  { name: "record_flow", label: "记账" },
  { name: "create_plan", label: "建计划" },
  { name: "checkin_plan", label: "打卡" },
  { name: "query_ledger", label: "查询统计", hint: "读账本，只读" },
];

/** 伙伴列表页：卡片（头像/徽章）+ 新建，结构照 prototype 页 7 */
export function Agents({ onEdit, onCreated }: { onEdit: (id: string) => void; onCreated: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => setAgents(await api2.listAgents()), []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const create = async () => {
    if (draft.trim() === "") {
      setMessage("先写一段人设（markdown 自由书写，首行 # 名字）");
      return;
    }
    try {
      const created = await api2.createAgent(draft);
      setDraft("");
      setCreating(false);
      onCreated(created.id);
    } catch (e) {
      setMessage(`创建失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-ink3">自定义人设 · 共享同一份对你的记忆</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">伙伴</h1>
        </div>
        <button
          className="rounded-lg bg-accent2 px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
          onClick={() => setCreating(!creating)}
        >
          ＋ 新建伙伴
        </button>
      </header>

      {/* 新建：人设草稿 */}
      {creating && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4">
          <label className="mb-1.5 block text-sm font-medium text-ink">人设卡 · 自由 markdown（名称从一级标题推导）</label>
          <textarea
            rows={6}
            placeholder={"# 教练\n\n身份：私人教练\n设定：话糙理不糙，盯训练也盯作息…"}
            className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-sm leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              className="rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              onClick={() => void create()}
            >
              创建
            </button>
            <button className="text-sm text-ink3 transition hover:text-ink" onClick={() => setCreating(false)}>
              取消
            </button>
            {message && <span className="text-sm text-warm">{message}</span>}
          </div>
        </div>
      )}

      {/* 伙伴卡片列表 */}
      <div className="space-y-3">
        {agents.length === 0 && !creating && <p className="text-sm text-ink3">还没有自定义伙伴——点右上「新建伙伴」开一个</p>}
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="w-full rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent3"
            onClick={() => onEdit(agent.id)}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent3 text-lg font-semibold text-accent">
                {agent.name.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-ink">{agent.name}</div>
                <div className="truncate text-xs text-ink3">
                  创建于 {new Date(agent.createdTs).toLocaleDateString()}
                </div>
              </div>
              <span className="rounded-full bg-surface2 px-2.5 py-1 text-xs text-ink3">点击编辑</span>
            </div>
            <div className="mt-3 flex gap-2 text-xs text-ink3">
              <span className="rounded-md bg-surface2 px-2 py-1">{agent.binding.tools?.length ?? 4} 个工具</span>
              <span className="rounded-md bg-surface2 px-2 py-1">{agent.binding.skills.length} 个技能</span>
              <span className="rounded-md bg-surface2 px-2 py-1">{agent.binding.mcps.length} 个 MCP</span>
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

/** 伙伴编辑页：① 人设卡 ② 能力绑定 ③ 记忆注入，结构照 prototype 页 8 */
export function AgentEdit({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const [agent, setAgent] = useState<AgentLoose | null>(null);
  const [persona, setPersona] = useState("");
  const [binding, setBinding] = useState<AgentBindingLoose>({ skills: [], mcps: [] });
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [mcps, setMcps] = useState<McpLoose[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pickSkills, setPickSkills] = useState(false);
  const [pickMcps, setPickMcps] = useState(false);

  const reload = useCallback(async () => {
    const detail = await api2.getAgent(agentId);
    setAgent(detail);
    setPersona(detail.persona);
    setBinding(detail.binding ?? { skills: [], mcps: [] });
    setSkills(await api2.listSkills());
    setMcps(await api2.listMcps());
  }, [agentId]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  if (!agent) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <p className="text-sm text-ink3">加载中…</p>
      </div>
    );
  }

  const savePersona = async () => {
    try {
      const result = await api2.updatePersona(agent.id, persona);
      setMessage(`人设已保存（名字：${result.name}），下一步生效`);
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

  const remove = async () => {
    await api2.deleteAgent(agent.id);
    onBack();
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <button className="mb-2 flex items-center gap-1 text-sm text-ink2 transition hover:text-ink" onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4" />
          返回伙伴
        </button>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">编辑伙伴 · {agent.name}</h1>
        <p className="mt-1 text-xs text-ink3">一个伙伴 = 人设卡 + 能力绑定 + 记忆注入，三段合成 system prompt</p>
      </header>

      {/* ① 人设卡 */}
      <section className="mb-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">
            ① 人设卡 <span className="text-ink3">· 自由 markdown</span>
          </h2>
          <span className="text-xs text-ink3">名称从一级标题推导</span>
        </div>
        <textarea
          rows={9}
          placeholder={"# 庄丽洪\n\n身份：学姐 / 红颜知己\n设定：硅谷 AI 架构师，平时感性温暖，聊技术切换严谨模式…"}
          className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-sm leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
        />
        <button
          className="mt-2 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          onClick={() => void savePersona()}
        >
          保存人设
        </button>
      </section>

      {/* ② 能力绑定 */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-ink">② 能力绑定</h2>
        <div className="rounded-xl border border-line bg-surface px-4 py-1">
          {BUILTIN_TOOLS.map((tool, i) => (
            <div
              key={tool.name}
              className={`flex items-center justify-between py-3 ${i < BUILTIN_TOOLS.length - 1 ? "border-b border-line" : ""}`}
            >
              <div>
                <span className="text-[15px] text-ink">{tool.label}</span>
                {tool.hint && <span className="ml-2 text-xs text-ink3">{tool.hint}</span>}
              </div>
              <Toggle checked={toolEnabled(tool.name)} onChange={() => toggleTool(tool.name)} title={tool.name} />
            </div>
          ))}
          <div className="border-t border-line py-2 text-[11px] text-ink3">全不勾 = 全部开放；勾选列表精确生效</div>
        </div>

        {/* 技能/MCP 绑定 */}
        <div className="mt-2 space-y-2">
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <button className="flex w-full items-center justify-between text-sm text-ink2 transition hover:text-ink" onClick={() => setPickSkills(!pickSkills)}>
              <span>＋ 绑定技能{binding.skills.length > 0 ? `（已绑 ${binding.skills.length} 个）` : ""}</span>
              <span className="text-xs text-ink3">{pickSkills ? "收起" : "展开"}</span>
            </button>
            {pickSkills && (
              <div className="mt-2 space-y-2">
                {skills.length === 0 && <p className="text-xs text-ink3">还没装技能（左下菜单「技能 / MCP」页安装）</p>}
                {skills.map((skill) => (
                  <label key={skill.id} className="flex items-center justify-between text-sm text-ink">
                    <span className="min-w-0 truncate">
                      {skill.name}
                      <span className="ml-2 text-xs text-ink3">{skill.description}</span>
                    </span>
                    <Toggle
                      checked={binding.skills.includes(skill.id)}
                      onChange={() =>
                        setBinding({
                          ...binding,
                          skills: binding.skills.includes(skill.id)
                            ? binding.skills.filter((s) => s !== skill.id)
                            : [...binding.skills, skill.id],
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <button className="flex w-full items-center justify-between text-sm text-ink2 transition hover:text-ink" onClick={() => setPickMcps(!pickMcps)}>
              <span>＋ 连接 MCP{binding.mcps.length > 0 ? `（已连 ${binding.mcps.length} 个）` : ""}</span>
              <span className="text-xs text-ink3">{pickMcps ? "收起" : "展开"}</span>
            </button>
            {pickMcps && (
              <div className="mt-2 space-y-2">
                {mcps.length === 0 && <p className="text-xs text-ink3">还没接 MCP（「技能 / MCP」页添加）</p>}
                {mcps.map((mcp) => (
                  <label key={mcp.id} className="flex items-center justify-between text-sm text-ink">
                    <span className="min-w-0 truncate">
                      {mcp.name}
                      <span className="ml-2 truncate text-xs text-ink3">{mcp.url}</span>
                    </span>
                    <Toggle
                      checked={binding.mcps.includes(mcp.id)}
                      onChange={() =>
                        setBinding({
                          ...binding,
                          mcps: binding.mcps.includes(mcp.id) ? binding.mcps.filter((m) => m !== mcp.id) : [...binding.mcps, mcp.id],
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          className="mt-2 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          onClick={() => void saveBinding()}
        >
          保存能力绑定
        </button>
      </section>

      {/* ③ 记忆注入 */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-ink">③ 记忆注入</h2>
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
          <div className="pr-4">
            <div className="text-[15px] text-ink">共享长期记忆</div>
            <div className="text-xs text-ink3">全局一份，所有伙伴读到同一个你（不可按伙伴关闭）</div>
          </div>
          <Toggle checked onChange={() => undefined} title="全局记忆，设计上不可关闭" />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          className="rounded-lg bg-accent2 px-4 py-2.5 text-[15px] font-semibold text-white transition hover:opacity-90 active:scale-[0.99]"
          onClick={() => void savePersona()}
        >
          保存
        </button>
        <button className="rounded-lg px-4 py-2.5 text-sm text-warm transition hover:bg-warm2" onClick={() => void remove()}>
          删除伙伴
        </button>
        {message && <span className="text-sm text-ink3">{message}</span>}
      </div>
    </div>
  );
}
