// 跨页预填（2026-10-21 技能卡片「使用」→ 聊天输入框预填 /技能名）：
// Skills 页写入并广播 op-go-chat；App 监听切页；Chat 挂载时取走。

let pending = "";

export function setChatPrefill(text: string): void {
  pending = text;
  window.dispatchEvent(new CustomEvent("op-go-chat"));
}

export function takeChatPrefill(): string {
  const text = pending;
  pending = "";
  return text;
}
