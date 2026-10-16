// 网关特殊要求（BYOK 适配层）：个别聚合网关对请求头有硬性要求，缺失直接 4xx。
// OpenCode Go（https://opencode.ai/docs/go/）：
//   - 每个会话须带稳定的 x-opencode-session（网关按它做路由与 prompt 缓存，缺失 = 400 MissingSessionID）
//   - User-Agent 须自报客户端身份（如 OpenPrism/0.2），而非通用 HTTP 库名
// 会话稳定性口径：对话 = conversationId（同会话复用，缓存才能命中）；非对话调用（记忆提取/embedding/连接测试）
// 按 uid 合成固定 key——同一用户同一用途恒定，不随请求漂移。

/** 客户端自报身份（与 package.json version 保持同节奏即可，网关只看是不是通用库名） */
const CLIENT_USER_AGENT = "OpenPrism/0.2";

/** 连接测试总时长（挂起端点到点中断报「连接超时」；测试经 ServerDeps.modelTestTimeoutMs 注入小值） */
export const MODEL_TEST_TIMEOUT_MS = 45_000;

/** 已知需要额外头的网关 → 头表；未知 baseURL 返回空（不影响其余平台） */
export function gatewayExtraHeaders(baseURL: string, sessionKey: string): Record<string, string> {
  let host = "";
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
    return { "x-opencode-session": sessionKey, "User-Agent": CLIENT_USER_AGENT };
  }
  return {};
}

/** 连接测试专用：带总时长的 AbortSignal——挂起端点（连不上/黑洞）不再无限等，到点中断并报「超时」。
 *  cleanup 在 finally 调；timedOut() 区分超时中断与调用方取消。 */
export function timeoutSignal(ms: number): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer), timedOut: () => fired };
}
