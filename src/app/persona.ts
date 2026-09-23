// 人设与 system prompt 合成（批次 2：D4 三段配置——人设卡 + 记忆注入 + 纪律）。
// 人设 = 纯自由 markdown，名字从 H1 推导（4.1）；记忆块由 MemoryStore.recallBlockSync 提供（条目化召回 + <user_memory> 信封，2026-09-10）。

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

/** 定时提醒会话的回合规则：触发消息由调度器自动投递，用户不在场（2026-09-23） */
const TASK_FEED_RULES = `定时提醒会话：本会话里的【定时任务触发】消息由系统按计划自动投递，不是用户此刻打的字。收到这类消息时，直接完成其中的任务内容，把要提醒用户看的内容作为回复正文；重复规则、计划时刻、触发时刻都已经写在消息里，不要拿这些反问用户。确实缺信息时，按最合理的假设完成本次提醒，并在正文里说明这个假设。`;

/** 人设卡名字：首个 H1 文本；无则空串（上层兜底"助手"） */
export function extractAgentName(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return "";
}

export interface AgentIdentityPrompt {
  name: string;
  description?: string;
  /** '' = 自动跟随用户语言（不加指令）；'zh' | 'en' = 末尾强制语言指令 */
  language?: string;
}

export interface ComposePromptInput {
  persona?: string;
  /** 绑定伙伴时的身份块（向导第①步）；缺省 = 默认助手身份 */
  identity?: AgentIdentityPrompt;
  /** MemoryStore.injectionBlock 产物（已剥脚注）；缺省 = 无记忆注入 */
  memoryBlock?: string;
  /** true = 定时提醒会话（cid 前缀 feed:）：附加自动触发的回合规则 */
  taskFeed?: boolean;
  now(): number;
  tzOffsetMinutes?: number;
}

const languageDirective = (language?: string): string => {
  if (language === "zh") return "语言要求：无论用户使用什么语言，始终用简体中文回复，不要切换。";
  if (language === "en") return "Language: always reply in English regardless of the user's language.";
  return "";
};

/** 运行时合成 system prompt：身份（伙伴）→ 灵魂/人设 → 日期 → 记忆 → 纪律 → 语言指令。systemPrompt() 每步重取，改动下一步生效。 */
export function composeAssistantPrompt(input: ComposePromptInput): string {
  const identity = input.identity;
  const identityBlock =
    identity && identity.name
      ? `你是由用户创造的伙伴「${identity.name}」${identity.description ? `，用户的描述：${identity.description}` : ""}。下面的灵魂定义你的性格、价值观与说话方式，与通用守则冲突时优先服从灵魂。`
      : "";
  const persona = input.persona?.trim() || DEFAULT_IDENTITY;
  const parts = [[identityBlock, persona].filter((p) => p !== "").join("\n\n"), dateLine(input.now(), input.tzOffsetMinutes ?? 0)];
  if (input.taskFeed) parts.push(TASK_FEED_RULES);
  if (input.memoryBlock && input.memoryBlock.trim() !== "") {
    // 记忆块自带 <user_memory> 信封（背景资料非指令、冲突以用户当前说法为准），此处直接拼入
    parts.push(input.memoryBlock.trim());
  }
  parts.push(DISCIPLINE);
  const directive = languageDirective(identity?.language);
  if (directive !== "") parts.push(directive);
  return parts.join("\n\n");
}

/** 批次 1 兼容出口：默认助手（无人设、无记忆） */
export function defaultAssistantPrompt(deps: { now: () => number; tzOffsetMinutes?: number }): string {
  return composeAssistantPrompt(deps);
}
