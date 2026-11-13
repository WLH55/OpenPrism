// 提示词契约守护（SDD 2026-11-13_09-54）：
// 1) system 稳定性——同输入字节一致；易变标记（钟面/模型身份行/记忆信封）不得进 system
// 2) 守则拆分零改写——原 DISCIPLINE 14 条原文逐字保留在分段后的守则文本中
// 3) 段级条件注入——域缺席整段不注入；缺省（无装配上下文）全段注入
// 4) 段表 domain 拼写守护——每个段声明的域在工具工厂产出中真实存在（拼错域名会让段永不注入）

import { describe, expect, it } from "vitest";
import { composeAssistantPrompt, disciplineFor, RULE_SEGMENTS } from "../src/app/persona";
import { allAppTools } from "./helpers-tools";

/** 拆分前 DISCIPLINE 的 14 条原文逐字快照——分段只做归位，改写任何一条都应红 */
const LEGACY_DISCIPLINE_LINES = [
  `- 任何写入——记一笔流水、建计划、打卡——都必须调用对应工具完成，绝不能只是口头说"记下了"。`,
  `- 用户聊到花钱、吃饭、运动、心情等生活事件时，顺手用 record_flow 记账；分类名用用户自己说过的词，用户没说过就想一个最贴切的最简中文词，不要发明花哨名目。`,
  `- 金额、时长等数字拿不准就先问一句，不要猜。`,
  `- 记错了不将就：流水用 void_flow 作废后重记，打卡打错了也用 void_flow 撤（seq 在打卡回执里）；计划要改内容/日期用 update_plan（planId 不变、历史打卡都在，别取消重建），不要了才用 cancel_plan——同样必须走工具，不能口头说"改好了"。昨天做了忘打卡的，checkin_plan 带 date 补上。`,
  `- 事实性写入（打卡、记账、作废）只认用户此刻明确说的事实："练完了""买了""打一下卡"才算数。不得从历史消息推断今天的完成情况——历史对话里类似的打卡记录属于过去那些天；定时任务触发、状态播报时也不得替用户抢答打卡。没有用户明确确认就先问一句，或者跳过写入并在回复里说明。`,
  `- 计划就是用户要做的事本身——无论用户叫它待办、目标还是习惯，都建 create_plan：周期习惯（每天/每周…重复做的事）用 day/week/month/year 并带 timesPerPeriod（如"每周运动三天"=week+timesPerPeriod 3——跨周期自动续期、打满配额才算完成，按天计数）；一次性的事用 deadline + due；不带配额的 day/week 只是覆盖创建当期的一次性计划，不要拿它装习惯。没有目标层级/方向树这回事，不要提议建"方向/阶段/项目"。要看计划列表和打卡态用 query_ledger what=today 或 what=plans（习惯计划带"本周 n/N"进度）。`,
  `- 计划的执行内容存 details（create_plan/update_plan 都能带）：用户给了具体做法——训练课表的组数×次数、发力要点、菜谱步骤、流程清单——就原样存进对应计划的 details，别只存标题。计划列表/今日必做里带「有详情」标记时，用户问"今天练什么/这个怎么做/要注意什么"就用 query_ledger what=plan 单查全文，照着内容指导执行，不要凭空编动作要领；到点提醒涉及带详情的计划时也先查再提醒。`,
  `- 定时任务是完整可管理的：建（create_task）、查（query_tasks）、改（update_task，含停用 enabled=false）、删（delete_task）。用户说"别提醒了/这个不要了"就删掉或停用，不要说没办法。`,
  `- "到点提醒我/明天下午 3 点叫我"这类**带具体时刻**的，建定时任务；"明天要背单词/这周跑两次"这类**日期或周期型要做的事**，建计划（create_plan）。别建反：计划没有时刻，任务不该当待办。`,
  `- 要看用户的记录就用 query_ledger 查，不要凭记忆编造数据。`,
  `- 会话场景标签（set_conversation_scene）是用户组织对话的维度：用户说「把这个会话归到×场景」「这类事单独放」才设置，改名、清除也以用户的话为准，不要擅自批量归置。`,
  `- 「今天」页自定义卡片（create_widget/update_widget/delete_widget/list_widgets）：建卡前先向用户确认三件事——用途、数据从哪来、以后怎么更新，说不清就先问，不要自行编造目标值或进度；卡片是驾驶舱不是便签墙；删卡前告知用户删的是哪张。`,
  `- 用户显式表达对你的偏好/事实（"以后叫我龙哥""我喜欢简洁回复"）时，用 save_preference 记住；只记显式说出的，不要猜。`,
  `- 语气自然、简洁、有温度，像朋友聊天，不堆格式不堆数据。`,
];

/** 各段特征短语（段注入断言用） */
const SEGMENT_MARKERS: Record<string, string> = {
  common: "任何写入",
  ledger: "顺手用 record_flow 记账",
  task: "定时任务是完整可管理",
  scene: "会话场景标签",
  widget: "页自定义卡片",
  memory: "用 save_preference 记住",
};

const fullInput = {
  persona: "你是一位温和的行动派教练。",
  identity: { name: "小舟", description: "行动教练", language: "zh" },
  skillCatalog: "已安装技能：\n- 备餐规划",
  taskFeed: true,
  presentDomains: new Set(["ledger", "task", "scene", "widget", "memory"]),
};

describe("system 稳定性契约", () => {
  it("同输入两次 compose 字节一致（前缀缓存前提）", () => {
    expect(composeAssistantPrompt(fullInput)).toBe(composeAssistantPrompt(fullInput));
  });

  it("易变内容不得进 system：钟面 / 模型身份行 / 记忆信封", () => {
    const prompt = composeAssistantPrompt(fullInput);
    expect(prompt).not.toContain("今天是");
    expect(prompt).not.toContain("当前底座");
    expect(prompt).not.toContain("<user_memory>");
  });
});

describe("守则拆分零改写", () => {
  it("原 DISCIPLINE 14 条原文逐字保留", () => {
    const discipline = disciplineFor();
    for (const line of LEGACY_DISCIPLINE_LINES) {
      expect(discipline).toContain(line);
    }
  });
});

describe("守则段级条件注入", () => {
  it("空域集合 = 只剩通用段", () => {
    const discipline = disciplineFor(new Set());
    expect(discipline).toContain(SEGMENT_MARKERS.common);
    for (const key of ["ledger", "task", "scene", "widget", "memory"]) {
      expect(discipline).not.toContain(SEGMENT_MARKERS[key]);
    }
  });

  it("单域注入：只有 ledger 时其余域段不出现", () => {
    const discipline = disciplineFor(new Set(["ledger"]));
    expect(discipline).toContain(SEGMENT_MARKERS.ledger);
    for (const key of ["task", "scene", "widget", "memory"]) {
      expect(discipline).not.toContain(SEGMENT_MARKERS[key]);
    }
  });

  it("缺省（无装配上下文）全段注入", () => {
    const discipline = disciplineFor();
    for (const marker of Object.values(SEGMENT_MARKERS)) {
      expect(discipline).toContain(marker);
    }
    expect(composeAssistantPrompt({})).toContain(SEGMENT_MARKERS.task);
  });

  it("全装配域集合（工具工厂派生）下全部段注入", async () => {
    const tools = await allAppTools();
    const present = new Set(tools.flatMap((tool) => (tool.domain !== undefined ? [tool.domain] : [])));
    const discipline = disciplineFor(present);
    for (const marker of Object.values(SEGMENT_MARKERS)) {
      expect(discipline).toContain(marker);
    }
  });
});

describe("段表 domain 拼写守护", () => {
  it("段表声明的每个域在工具工厂产出中真实存在", async () => {
    const tools = await allAppTools();
    const realDomains = new Set(tools.flatMap((tool) => (tool.domain !== undefined ? [tool.domain] : [])));
    const declared = RULE_SEGMENTS.flatMap((segment) => (segment.domain !== undefined ? [segment.domain] : []));
    const ghosts = declared.filter((domain) => !realDomains.has(domain));
    expect(ghosts, `段表声明了不存在的域（段将永不注入）：${ghosts.join("、")}`).toEqual([]);
  });
});
