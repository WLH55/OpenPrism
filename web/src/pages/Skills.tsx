import { useCallback, useEffect, useRef, useState } from "react";
import { api2, type AgentLoose, type InstallProgressLoose, type McpLoose, type SkillLoose } from "../api";
import { setChatPrefill } from "../prefill";

const SAMPLE = `---
name: 技能名
description: 一句话说清何时用（进模型常驻目录，≤1024 字符）
when_to_use: 触发场景
---

# 技能正文（模型点名 load_skill 时载入）`;

const PHASE_LABEL: Record<string, string> = {
  container: "启动安装容器",
  copyin: "注入技能包文件",
  agent: "安装智能体装依赖",
  verify: "验证门检查",
  repair: "修复缺失依赖",
  commit: "固化技能镜像",
  done: "安装完成",
  failed: "安装失败",
};

interface InstallPanel {
  id: string;
  events: InstallProgressLoose[];
}

/** 技能 / MCP 页：分段双栏 + 安装区 + 已装列表，结构照 prototype 页 9；
 *  技能安装 2026-10-21 Docker 沙箱化：来源 URL / ZIP / 粘贴三入口 + SSE 进度面板 */
export function Skills() {
  const [tab, setTab] = useState<"skill" | "mcp">("skill");
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [agents, setAgents] = useState<AgentLoose[]>([]);
  const [mcps, setMcps] = useState<McpLoose[]>([]);
  const [source, setSource] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [content, setContent] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [installing, setInstalling] = useState<InstallPanel | null>(null);
  const [openBody, setOpenBody] = useState<{ id: string; body: string } | null>(null);
  const [openFiles, setOpenFiles] = useState<{ id: string; files: string[]; reading?: { path: string; content: string } } | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpTools, setMcpTools] = useState<{ id: string; tools: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const closeEventsRef = useRef<(() => void) | null>(null);

  const reload = useCallback(async () => {
    const [s, a, m] = await Promise.all([api2.listSkills(), api2.listAgents(), api2.listMcps()]);
    setSkills(s);
    setAgents(a);
    setMcps(m);
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
  useEffect(() => () => closeEventsRef.current?.(), []);

  const boundCount = (id: string): number => agents.filter((a) => a.binding.skills.includes(id)).length;
  const boundMcpCount = (id: string): number => agents.filter((a) => a.binding.mcps.includes(id)).length;

  /** 订阅安装进度：面板实时追加事件；终态后刷新列表 */
  const watchInstall = (id: string): void => {
    closeEventsRef.current?.();
    setInstalling({ id, events: [] });
    closeEventsRef.current = api2.openSkillInstallEvents(id, (event) => {
      setInstalling((panel) => (panel === null || panel.id !== id ? panel : { id, events: [...panel.events, event] }));
      if (event.phase === "done" || event.phase === "failed") {
        closeEventsRef.current?.();
        closeEventsRef.current = null;
        void reload().catch(() => undefined);
      }
    });
  };

  const installFromSource = async () => {
    try {
      if (zipFile !== null) {
        const { id } = await api2.installSkillZip(zipFile);
        setZipFile(null);
        watchInstall(id);
        setMessage(null);
      } else {
        const { id } = await api2.installSkillFromUrl(source.trim());
        setSource("");
        watchInstall(id);
        setMessage(null);
      }
    } catch (e) {
      setMessage(`安装发起失败：${(e as Error).message}`);
    }
  };

  const installPasted = async () => {
    try {
      const meta = await api2.installSkill(content);
      setMessage(`已安装「${meta.name}」（纯提示词技能，无脚本环境）`);
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

  const toggleSkillFiles = async (skill: SkillLoose) => {
    if (openFiles?.id === skill.id) {
      setOpenFiles(null);
      return;
    }
    const { files } = await api2.skillFiles(skill.id);
    setOpenFiles({ id: skill.id, files });
  };

  const readSkillFile = async (sid: string, path: string) => {
    const { content: text } = await api2.skillFile(sid, path);
    setOpenFiles((panel) => (panel === null || panel.id !== sid ? panel : { ...panel, reading: { path, content: text } }));
  };

  const statusBadge = (skill: SkillLoose): { text: string; cls: string } => {
    if (skill.status === "installing") return { text: "安装中", cls: "bg-accent3 text-accent" };
    if (skill.status === "failed") return { text: "安装失败", cls: "bg-warm2 text-warm" };
    if (skill.enabled === false) return { text: "已停用", cls: "bg-surface2 text-ink3" };
    if (skill.imageTag) return { text: "就绪 · 带沙箱", cls: "bg-accent3 text-accent" };
    return { text: "就绪", cls: "bg-surface2 text-ink3" };
  };

  const inputCls =
    "rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3";

  const lastProgress = installing?.events[installing.events.length - 1];

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
            <div className="flex gap-2">
              <input
                className={`min-w-0 flex-1 ${inputCls}`}
                placeholder="来源链接（GitHub 仓库/tree 子目录、skills.sh、zip 直链）"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <label className="shrink-0 cursor-pointer rounded-lg border border-line px-3 py-2.5 text-sm text-ink3 transition hover:bg-surface2 hover:text-ink">
                {zipFile ? zipFile.name : "选 ZIP…"}
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    setZipFile(e.target.files?.[0] ?? null);
                    setSource("");
                  }}
                />
              </label>
              <button
                className="shrink-0 rounded-lg bg-accent2 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
                disabled={source.trim() === "" && zipFile === null}
                onClick={() => void installFromSource()}
              >
                安装
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink3">
              安装在 Docker 沙箱里跑（装依赖过验证门后固化镜像，分钟级）；进度见下方面板。
              <button className="ml-1 underline underline-offset-2 hover:text-ink" onClick={() => setPasteOpen((v) => !v)}>
                {pasteOpen ? "收起粘贴安装" : "没有链接？粘贴 SKILL.md 全文装纯提示词技能"}
              </button>
            </p>
            {pasteOpen && (
              <div className="mt-3">
                <textarea
                  rows={8}
                  placeholder={SAMPLE}
                  className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-sm leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-accent focus:ring-2 focus:ring-accent3"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
                <button
                  className="mt-2 rounded-lg bg-accent2 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
                  onClick={() => void installPasted()}
                >
                  粘贴安装
                </button>
              </div>
            )}
            {message && <p className="mt-2 text-sm text-ink3">{message}</p>}
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

      {/* 安装进度面板 */}
      {tab === "skill" && installing !== null && (
        <section className="mb-5 rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink">
              {lastProgress ? `${PHASE_LABEL[lastProgress.phase] ?? lastProgress.phase} · ${lastProgress.percent}%` : "连接进度流…"}
            </span>
            <button
              className="text-xs text-ink3 transition hover:text-ink"
              onClick={() => {
                closeEventsRef.current?.();
                closeEventsRef.current = null;
                setInstalling(null);
              }}
            >
              关闭
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
            <div
              className={`h-full rounded-full transition-all ${lastProgress?.phase === "failed" ? "bg-warm" : "bg-accent"}`}
              style={{ width: `${lastProgress?.percent ?? 0}%` }}
            />
          </div>
          <div className="mt-2 max-h-40 space-y-0.5 overflow-auto text-xs leading-relaxed text-ink3">
            {installing.events.map((event, index) => (
              <div key={index} className={event.phase === "failed" ? "text-warm" : undefined}>
                {event.phase === "failed" ? `失败：${event.error ?? ""}` : `${PHASE_LABEL[event.phase] ?? event.phase}${event.message ? ` — ${event.message}` : ""}`}
              </div>
            ))}
          </div>
          {lastProgress?.phase === "failed" && (
            <button
              className="mt-2 rounded-lg bg-accent2 px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
              onClick={async () => {
                await api2.retrySkillInstall(installing.id);
                watchInstall(installing.id);
              }}
            >
              重试安装
            </button>
          )}
        </section>
      )}

      {/* 已装列表 */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">已安装</h2>
        <div className="space-y-1.5">
          {tab === "skill" && skills.length === 0 && <p className="text-sm text-ink3">还没有技能</p>}
          {tab === "skill" &&
            skills.map((skill) => {
              const badge = statusBadge(skill);
              return (
                <div key={skill.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent3 text-accent">S</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] text-ink">{skill.name}</span>
                        <span className={`rounded-md px-1.5 py-0.5 text-[11px] ${badge.cls}`}>{badge.text}</span>
                        {skill.version && <span className="text-[11px] text-ink3">v{skill.version}</span>}
                      </div>
                      <div className="truncate text-xs text-ink3">
                        {skill.description}
                        {skill.whenToUse ? ` · 何时用：${skill.whenToUse}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-ink3">绑定 {boundCount(skill.id)} 个伙伴</span>
                  </div>
                  {(skill.status === "failed" || skill.installError) && (
                    <p className="mt-1 text-xs text-warm">失败原因：{skill.installError ?? "未知"}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-ink3">
                    <label className="flex cursor-pointer items-center gap-1 transition hover:text-ink">
                      <input
                        type="checkbox"
                        checked={skill.enabled !== false}
                        onChange={async (e) => {
                          await api2.setSkillEnabled(skill.id, e.target.checked);
                          await reload();
                        }}
                      />
                      启用
                    </label>
                    <button
                      className="transition hover:text-ink"
                      onClick={async () => {
                        setOpenBody(openBody?.id === skill.id ? null : { id: skill.id, body: (await api2.skillBody(skill.id)).body });
                        setOpenFiles(null);
                      }}
                    >
                      正文
                    </button>
                    <button className="transition hover:text-ink" onClick={() => void toggleSkillFiles(skill)}>
                      文件
                    </button>
                    <button
                      className="transition hover:text-ink"
                      onClick={() => setChatPrefill(`/${skill.name} `)}
                      title="回到对话，本回合强制使用该技能"
                    >
                      使用
                    </button>
                    {skill.status === "failed" && (
                      <button
                        className="transition hover:text-ink"
                        onClick={async () => {
                          await api2.retrySkillInstall(skill.id);
                          watchInstall(skill.id);
                        }}
                      >
                        重试
                      </button>
                    )}
                    <button
                      className="transition hover:text-warm"
                      onClick={async () => {
                        await api2.deleteSkill(skill.id);
                        await reload();
                      }}
                    >
                      卸载
                    </button>
                  </div>
                  {openBody?.id === skill.id && (
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface2 px-3 py-2 text-xs leading-relaxed text-ink2">
                      {openBody.body}
                    </pre>
                  )}
                  {openFiles?.id === skill.id && (
                    <div className="mt-2 rounded-lg bg-surface2 px-3 py-2 text-xs">
                      {openFiles.files.length === 0 && <span className="text-ink3">无捆绑文件</span>}
                      <div className="flex flex-wrap gap-1.5">
                        {openFiles.files.map((path) => (
                          <button
                            key={path}
                            className={`rounded-md px-2 py-1 transition hover:text-ink ${openFiles.reading?.path === path ? "bg-surface text-ink" : "text-ink2"}`}
                            onClick={() => void readSkillFile(skill.id, path)}
                          >
                            {path}
                          </button>
                        ))}
                      </div>
                      {openFiles.reading && (
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-ink2">{openFiles.reading.content}</pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

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

      <p className="mt-5 text-xs leading-relaxed text-ink3">在「伙伴」页编辑的「能力绑定」里把技能/MCP 绑给伙伴，对话中即可被点名载入；聊天输入框敲 / 可快速选技能。</p>
    </div>
  );
}
