import { useCallback, useEffect, useState } from "react";
import { api2, type AgentLoose, type McpLoose, type SkillLoose } from "../api";

const SAMPLE = `---
name: 技能名
description: 一句话说清何时用（进模型常驻目录，≤1024 字符）
when_to_use: 触发场景
---

# 技能正文（模型点名 load_skill 时载入）`;

/** 技能 / MCP 页：分段双栏 + 安装区 + 已装列表，结构照 prototype 页 9 */
export function Skills() {
  const [tab, setTab] = useState<"skill" | "mcp">("skill");
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [mcps, setMcps] = useState<McpLoose[]>([]);
  const [content, setContent] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [openBody, setOpenBody] = useState<{ id: string; body: string } | null>(null);
  const [mcpTools, setMcpTools] = useState<{ id: string; tools: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [s, a, m] = await Promise.all([api2.listSkills(), api2.listAgents(), api2.listMcps()]);
    setSkills(s);
    setAgents(a);
    setMcps(m);
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const boundCount = (id: string): number =>
    agents.filter((a) => a.binding.skills.includes(id)).length;
  const boundMcpCount = (id: string): number =>
    agents.filter((a) => a.binding.mcps.includes(id)).length;

  const installSkill = async () => {
    try {
      const meta = await api2.installSkill(content);
      setMessage(`已安装「${meta.name}」`);
      setContent("");
      await reload();
    } catch (e) {
      setMessage(`安装失败：${(e as Error).message}`);
    }
  };

  const addMcp = async () => {
    try {
      await api2.addMcp(mcpName.trim() || "MCP", mcpUrl.trim());
      setMessage("MCP 已添加");
      setMcpName("");
      setMcpUrl("");
      await reload();
    } catch (e) {
      setMessage(`添加失败：${(e as Error).message}`);
    }
  };

  const inputCls =
    "rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="text-xs text-ink3">标准格式 · 自带自装 · 无商店</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">技能 / MCP</h1>
      </header>

      {/* 分段：技能 / MCP */}
      <div className="mb-5 grid grid-cols-2 rounded-lg bg-surface2 p-1 text-sm">
        <button
          onClick={() => setTab("skill")}
          className={`rounded-md py-1.5 transition ${tab === "skill" ? "bg-surface font-medium text-ink shadow-sm" : "text-ink3 hover:text-ink"}`}
        >
          技能 Skill
        </button>
        <button
          onClick={() => setTab("mcp")}
          className={`rounded-md py-1.5 transition ${tab === "mcp" ? "bg-surface font-medium text-ink shadow-sm" : "text-ink3 hover:text-ink"}`}
        >
          MCP 工具
        </button>
      </div>

      {/* 安装区 */}
      <section className="mb-5 rounded-xl border border-line bg-surface p-4">
        {tab === "skill" ? (
          <>
            <label className="mb-1.5 block text-sm font-medium text-ink">安装技能</label>
            <textarea
              rows={8}
              placeholder={SAMPLE}
              className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-sm leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                className="rounded-lg bg-accent2 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
                onClick={() => void installSkill()}
              >
                安装
              </button>
              {message && <span className="text-sm text-ink3">{message}</span>}
            </div>
            <p className="mt-2 text-xs text-ink3">
              粘贴 SKILL.md 全文安装。风险须知：技能改提示词（低危）；MCP 外呼数据给第三方（中危）。
            </p>
          </>
        ) : (
          <>
            <label className="mb-1.5 block text-sm font-medium text-ink">添加 MCP</label>
            <div className="flex gap-2">
              <input className={`min-w-0 flex-1 ${inputCls}`} placeholder="名称（如：tavily-search）" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
              <input className={`min-w-0 flex-1 ${inputCls}`} placeholder="https://server.example/mcp" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} />
              <button
                className="shrink-0 rounded-lg bg-accent2 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
                onClick={() => void addMcp()}
              >
                添加
              </button>
            </div>
            <p className="mt-2 text-xs text-ink3">MCP = 外呼工具服务器，数据会发给该第三方（中危），按需接入。</p>
          </>
        )}
      </section>

      {/* 已装列表 */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">已安装</h2>
        <div className="space-y-1.5">
          {tab === "skill" && skills.length === 0 && <p className="text-sm text-ink3">还没有技能</p>}
          {tab === "skill" &&
            skills.map((skill) => (
              <div key={skill.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent3 text-accent">S</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] text-ink">{skill.name}</div>
                    <div className="truncate text-xs text-ink3">
                      {skill.description}
                      {skill.whenToUse ? ` · 何时用：${skill.whenToUse}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-ink3">绑定 {boundCount(skill.id)} 个伙伴</span>
                  <button
                    className="shrink-0 text-xs text-ink3 transition hover:text-ink"
                    onClick={async () => {
                      setOpenBody(openBody?.id === skill.id ? null : { id: skill.id, body: (await api2.skillBody(skill.id)).body });
                    }}
                  >
                    {openBody?.id === skill.id ? "收起" : "正文"}
                  </button>
                  <button
                    className="shrink-0 text-xs text-ink3 transition hover:text-warm"
                    onClick={async () => {
                      await api2.deleteSkill(skill.id);
                      await reload();
                    }}
                  >
                    删除
                  </button>
                </div>
                {openBody?.id === skill.id && (
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface2 px-3 py-2 text-xs leading-relaxed text-ink2">
                    {openBody.body}
                  </pre>
                )}
              </div>
            ))}

          {tab === "mcp" && mcps.length === 0 && <p className="text-sm text-ink3">还没有 MCP</p>}
          {tab === "mcp" &&
            mcps.map((mcp) => (
              <div key={mcp.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warm2 text-warm">M</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] text-ink">{mcp.name}</div>
                    <div className="truncate text-xs text-ink3">{mcp.url}</div>
                  </div>
                  <span className="shrink-0 text-xs text-ink3">绑定 {boundMcpCount(mcp.id)} 个伙伴</span>
                  <button
                    className="shrink-0 text-xs text-ink3 transition hover:text-ink"
                    onClick={async () => {
                      setMcpTools(mcpTools?.id === mcp.id ? null : { id: mcp.id, tools: (await api2.mcpTools(mcp.id)).tools });
                    }}
                  >
                    {mcpTools?.id === mcp.id ? "收起" : "工具"}
                  </button>
                  <button
                    className="shrink-0 text-xs text-ink3 transition hover:text-warm"
                    onClick={async () => {
                      await api2.deleteMcp(mcp.id);
                      await reload();
                    }}
                  >
                    删除
                  </button>
                </div>
                {mcpTools?.id === mcp.id && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink2">
                    {mcpTools.tools.length === 0 && <span className="text-ink3">未发现工具</span>}
                    {mcpTools.tools.map((t) => (
                      <span key={t} className="rounded-md bg-surface2 px-2 py-1">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>
      </section>

      <p className="mt-5 text-xs leading-relaxed text-ink3">在「伙伴」页编辑的「能力绑定」里把技能/MCP 绑给伙伴，对话中即可被点名载入。</p>
    </div>
  );
}
