import { useCallback, useEffect, useState } from "react";
import { api2, type SkillLoose } from "../api";

const SAMPLE = `---
name: 技能名
description: 一句话说清何时用（进模型常驻目录，≤1024 字符）
when_to_use: 触发场景
---

# 技能正文（模型点名 load_skill 时载入）`;

export function Skills() {
  const [skills, setSkills] = useState<SkillLoose[]>([]);
  const [content, setContent] = useState("");
  const [openBody, setOpenBody] = useState<{ id: string; body: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => setSkills(await api2.listSkills()), []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const install = async () => {
    try {
      const meta = await api2.installSkill(content);
      setMessage(`已安装「${meta.name}」`);
      setContent("");
      await reload();
    } catch (e) {
      setMessage(`安装失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: "0 0 4px" }}>技能</h1>
      <p className="muted">标准 Agent Skill（SKILL.md）· 目录常驻、正文按需载入 · 自带自装、零预设</p>

      <div className="card" style={{ marginTop: 16 }}>
        <label className="label">粘贴 SKILL.md 内容安装</label>
        <textarea className="input" rows={10} placeholder={SAMPLE} value={content} onChange={(e) => setContent(e.target.value)} />
        <button className="btn small" style={{ marginTop: 8 }} onClick={install}>
          安装
        </button>
        {message && <p className="muted" style={{ margin: "8px 0 0" }}>{message}</p>}
      </div>

      <div className="section-title">已安装（{skills.length}）</div>
      <div className="card" style={{ padding: 0 }}>
        {skills.length === 0 && <div className="flow-row muted">还没有技能</div>}
        {skills.map((skill) => (
          <div key={skill.id} className="flow-row">
            <div className="meta">
              <div>{skill.name}</div>
              <div className="sub">
                {skill.description}
                {skill.whenToUse ? ` · 何时用：${skill.whenToUse}` : ""}
              </div>
            </div>
            <button
              className="btn ghost small"
              onClick={async () => {
                setOpenBody(openBody?.id === skill.id ? null : { id: skill.id, body: (await api2.skillBody(skill.id)).body });
              }}
            >
              {openBody?.id === skill.id ? "收起" : "正文"}
            </button>
            <button
              className="btn ghost small"
              onClick={async () => {
                await api2.deleteSkill(skill.id);
                await reload();
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      {openBody && (
        <pre className="card" style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12.5, maxHeight: 320, overflow: "auto" }}>
          {openBody.body}
        </pre>
      )}
      <p className="muted" style={{ marginTop: 12 }}>在「伙伴」页把技能绑定给某个伙伴后，对话中即可被点名载入。</p>
    </div>
  );
}
