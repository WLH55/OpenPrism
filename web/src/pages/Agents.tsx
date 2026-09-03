import { useCallback, useEffect, useState } from "react";
import { api2, api, type AgentBindingLoose, type AgentLoose, type McpLoose, type SkillLoose } from "../api";

const BUILTIN_TOOLS = ["record_flow", "create_plan", "checkin_plan", "query_ledger"];

export function Agents() {
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [mcps, setMcps] = useState<McpLoose[]>([]);
  const [selected, setSelected] = useState<AgentLoose | null>(null);
  const [persona, setPersona] = useState("");
  const [binding, setBinding] = useState<AgentBindingLoose>({ skills: [], mcps: [] });
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState(""); // 新建人设草稿

  const reload = useCallback(async () => {
    setAgents(await api2.listAgents());
    setSkills(await api2.listSkills());
    setMcps(await api2.listMcps());
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const pick = async (agent: AgentLoose) => {
    setSelected(agent);
    const detail = await api2.getAgent(agent.id);
    setPersona(detail.persona);
    setBinding(detail.binding ?? { skills: [], mcps: [] });
    setMessage(null);
  };

  const create = async () => {
    if (draft.trim() === "") {
      setMessage("先写一段人设（markdown 自由书写，首行 # 名字）");
      return;
    }
    try {
      const created = await api2.createAgent(draft);
      setDraft("");
      await reload();
      await pick(created);
    } catch (e) {
      setMessage(`创建失败：${(e as Error).message}`);
    }
  };

  const savePersona = async () => {
    if (!selected) return;
    try {
      const result = await api2.updatePersona(selected.id, persona);
      setMessage(`已保存（名字：${result.name}），改动下一步即生效`);
      await reload();
    } catch (e) {
      setMessage(`保存失败：${(e as Error).message}`);
    }
  };

  const saveBinding = async () => {
    if (!selected) return;
    try {
      await api2.updateBinding(selected.id, binding);
      setMessage("能力绑定已保存（新对话/重启后装配生效）");
      await reload();
    } catch (e) {
      setMessage(`保存失败：${(e as Error).message}`);
    }
  };

  const remove = async () => {
    if (!selected) return;
    await api2.deleteAgent(selected.id);
    setSelected(null);
    setPersona("");
    await reload();
  };

  const toolEnabled = (name: string): boolean =>
    !binding.tools || binding.tools.length === 0 || binding.tools.includes(name);
  const toggleTool = (name: string) => {
    const current = binding.tools && binding.tools.length > 0 ? [...binding.tools] : [...BUILTIN_TOOLS];
    const next = current.includes(name) ? current.filter((t) => t !== name) : [...current, name];
    setBinding({ ...binding, tools: next });
  };

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <h1 style={{ margin: "0 0 4px" }}>伙伴</h1>
      <p className="muted">三段配置：人设卡（自由 markdown）· 能力绑定 · 记忆全局注入</p>

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, marginTop: 16 }}>
        <div>
          <div className="card" style={{ padding: 10 }}>
            <textarea
              className="input"
              rows={3}
              placeholder={"# 新伙伴名字\n人设随便写…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn small" style={{ width: "100%", marginTop: 8 }} onClick={create}>
              ＋ 新建伙伴
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            {agents.map((agent) => (
              <div key={agent.id} className={`conv-item${selected?.id === agent.id ? " active" : ""}`} onClick={() => void pick(agent)}>
                <div className="t">{agent.name}</div>
              </div>
            ))}
            {agents.length === 0 && <p className="muted">还没有自定义伙伴</p>}
          </div>
        </div>

        <div className="card">
          {selected ? (
            <>
              <div style={{ display: "flex", alignItems: "center" }}>
                <b style={{ fontSize: 16 }}>{selected.name}</b>
                <span style={{ flex: 1 }} />
                <button className="btn ghost small" onClick={remove}>
                  删除
                </button>
              </div>
              <label className="label">人设卡（首行 # 名字；随时可改，下一步生效）</label>
              <textarea className="input" rows={10} value={persona} onChange={(e) => setPersona(e.target.value)} />
              <button className="btn small" style={{ marginTop: 8 }} onClick={savePersona}>
                保存人设
              </button>

              <label className="label">能力绑定 · 内置工具（全不勾 = 全部开放）</label>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {BUILTIN_TOOLS.map((tool) => (
                  <label key={tool} style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                    <input type="checkbox" checked={toolEnabled(tool)} onChange={() => toggleTool(tool)} /> {tool}
                  </label>
                ))}
              </div>

              <label className="label">绑定技能</label>
              {skills.length === 0 && <p className="muted" style={{ margin: 0 }}>还没装技能（技能页安装）</p>}
              {skills.map((skill) => (
                <label key={skill.id} style={{ fontSize: 13.5, color: "var(--ink-2)", marginRight: 14 }}>
                  <input
                    type="checkbox"
                    checked={binding.skills.includes(skill.id)}
                    onChange={() =>
                      setBinding({
                        ...binding,
                        skills: binding.skills.includes(skill.id)
                          ? binding.skills.filter((s) => s !== skill.id)
                          : [...binding.skills, skill.id],
                      })
                    }
                  />{" "}
                  {skill.name}
                </label>
              ))}

              <label className="label">绑定 MCP（外呼工具服务器）</label>
              {mcps.length === 0 && <p className="muted" style={{ margin: 0 }}>还没接 MCP（设置区添加）</p>}
              {mcps.map((mcp) => (
                <label key={mcp.id} style={{ fontSize: 13.5, color: "var(--ink-2)", marginRight: 14 }}>
                  <input
                    type="checkbox"
                    checked={binding.mcps.includes(mcp.id)}
                    onChange={() =>
                      setBinding({
                        ...binding,
                        mcps: binding.mcps.includes(mcp.id) ? binding.mcps.filter((m) => m !== mcp.id) : [...binding.mcps, mcp.id],
                      })
                    }
                  />{" "}
                  {mcp.name}
                </label>
              ))}
              <div>
                <button className="btn small" style={{ marginTop: 10 }} onClick={saveBinding}>
                  保存能力绑定
                </button>
              </div>
            </>
          ) : (
            <p className="muted">左边选一个伙伴，或新建一个</p>
          )}
          {message && <p className="muted" style={{ marginTop: 10 }}>{message}</p>}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        会话里可随时切换伙伴（聊天页顶部下拉）；每条消息归属它当时的伙伴。记忆对所有伙伴共享。
      </p>
      <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => void api.me().catch(() => undefined)}>
        刷新
      </button>
    </div>
  );
}
