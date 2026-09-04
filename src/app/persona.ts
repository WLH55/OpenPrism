// 人设与 system prompt 合成（批次 2：D4 三段配置——人设卡 + 记忆注入 + 纪律）。
// 人设 = 纯自由 markdown，名字从 H1 推导（4.1）；记忆块由 MemoryStore.injectionBlock 提供（已剥脚注，5.2）。

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const DEFAULT_IDENTITY = "你是 OpenPrism 的生活记录助理，陪用户记录生活、管理计划、看见自己的进步。";

function dateLine(now: number, tzOffsetMinutes: number): string {
  const shifted = new Date(now + tzOffsetMinutes * 60000);
  const date = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
  return `今天是 ${date} ${WEEKDAYS[shifted.getUTCDay()]}（用户当地时间）。`;
}

const DISCIPLINE = `守则：
- 任何写入——记一笔流水、建计划、打卡——都必须调用对应工具完成，绝不能只是口头说"记下了"。
- 用户聊到花钱、吃饭、运动、心情等生活事件时，顺手用 record_flow 记账；分类名用用户自己说过的词，用户没说过就想一个最贴切的最简中文词，不要发明花哨名目。
- 金额、时长等数字拿不准就先问一句，不要猜。
- 记错了不将就：流水用 void_flow 作废后重记，计划不要了用 cancel_plan 取消——同样必须走工具，不能口头说"改好了"。
- 定时任务是完整可管理的：建（create_task）、查（query_tasks）、改（update_task，含停用 enabled=false）、删（delete_task）。用户说"别提醒了/这个不要了"就删掉或停用，不要说没办法。
- 要看用户的记录就用 query_ledger 查，不要凭记忆编造数据。
- 用户显式表达对你的偏好/事实（"以后叫我龙哥""我喜欢简洁回复"）时，用 save_preference 记住；只记显式说出的，不要猜。
- 语气自然、简洁、有温度，像朋友聊天，不堆格式不堆数据。`;

/** 人设卡名字：首个 H1 文本；无则空串（上层兜底"助手"） */
export function extractAgentName(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return "";
}

export interface ComposePromptInput {
  persona?: string;
  /** MemoryStore.injectionBlock 产物（已剥脚注）；缺省 = 无记忆注入 */
  memoryBlock?: string;
  now(): number;
  tzOffsetMinutes?: number;
}

/** 运行时合成 system prompt：人设（或默认身份）→ 日期 → 记忆 → 纪律。systemPrompt() 每步重取，改动下一步生效。 */
export function composeAssistantPrompt(input: ComposePromptInput): string {
  const persona = input.persona?.trim() || DEFAULT_IDENTITY;
  const parts = [persona, dateLine(input.now(), input.tzOffsetMinutes ?? 0)];
  if (input.memoryBlock && input.memoryBlock.trim() !== "") {
    parts.push(`关于这个用户的长期记忆（自动注入，用它调整语气与举例，不要原文背诵）：\n${input.memoryBlock.trim()}`);
  }
  parts.push(DISCIPLINE);
  return parts.join("\n\n");
}

/** 批次 1 兼容出口：默认助手（无人设、无记忆） */
export function defaultAssistantPrompt(deps: { now: () => number; tzOffsetMinutes?: number }): string {
  return composeAssistantPrompt(deps);
}
