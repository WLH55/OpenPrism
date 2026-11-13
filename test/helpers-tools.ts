// 全部仓库内工具工厂的一次性装配（契约/预算测试共用）：真实 store + testDb，零网络。
// MCP 工具（外部服务器）与 conversations 内联系统工具（compact）不在列——预算与域断言只覆盖自有工具面。

import { testDb } from "./helpers-db";
import { Ledger } from "../src/app/ledger";
import { TaskStore, createTaskTools } from "../src/app/tasks";
import { MemoryStore, createSavePreferenceTool, createSearchMemoryTool } from "../src/app/memory";
import { WidgetStore, createWidgetTools } from "../src/app/widgets";
import { createLedgerTools, type AppTool } from "../src/app/tools";
import { createSceneTools } from "../src/app/conversations";
import { SkillStore, createLoadSkillTool, createReadSkillFileTool } from "../src/app/skills";
import { createSkillExecTool } from "../src/app/skillexec";
import { createReadShadowTool } from "../src/app/shadow";
import type { SkillFilesIO } from "../src/app/skillpkg";

const now = () => 1731480000000;
const randomUUID = () => "uuid-fixed";

/** 技能文件面（测试注入 fake，skillpkg 注释认可的做法）：无捆绑文件 */
const emptyFiles: SkillFilesIO = {
  list: () => [],
  read: (_uid, _sid, path) => {
    throw new Error(`测试技能文件面无文件：${path}`);
  },
};

export async function allAppTools(): Promise<AppTool[]> {
  const db = testDb();
  const ledger = await Ledger.open(db, "u1");
  const tasks = new TaskStore({ db, now, randomUUID });
  const memory = new MemoryStore({ db, now, randomUUID });
  const widgets = new WidgetStore(db, { now, randomUUID });
  const skills = new SkillStore({ db, now, randomUUID });
  const allowedSkillIds = new Set<string>();
  return [
    ...createLedgerTools({ ledger, now, tzOffsetMinutes: () => 480 }),
    ...createTaskTools({ store: tasks, uid: "u1", now, tzOffsetMinutes: 480 }),
    createSavePreferenceTool({ store: memory, uid: "u1", now }),
    createSearchMemoryTool({ store: memory, uid: "u1" }),
    ...createWidgetTools({ store: widgets, uid: "u1" }),
    ...createSceneTools({ uid: "u1", cid: "c1", setScene: async () => undefined }),
    createLoadSkillTool({ store: skills, uid: "u1", files: emptyFiles, allowedSkillIds }),
    createReadSkillFileTool({ store: skills, uid: "u1", files: emptyFiles, allowedSkillIds }),
    createSkillExecTool({ docker: undefined as never, store: skills, blobs: { save: async () => "b1" }, uid: "u1", runsRoot: "runs", randomUUID }),
    createReadShadowTool({ log: { readAll: () => [], append: async () => {} } as never }),
  ];
}
