// Node 平台缝实现（设计 §2 平台注入的宿主侧）：harness 零平台依赖，本文件是它跑在 Node 上的那份注入。
// 仅 app 层可 import Node 模块；harness 目录的铁律不因此松动。

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { FileIO, PlatformEnv } from "../harness/index";

/** 是否启用了出网代理（curl 同款变量集合）；导出供纯函数测试。 */
export function proxyEnvEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
}

// Node 22 内置 fetch 不认 HTTP(S)_PROXY/NO_PROXY（NODE_USE_ENV_PROXY 要 Node 24+），
// 直连被墙的端点（如 api.jina.ai）只会报 "fetch failed"；设了任一代理变量就换 undici
// 的 EnvHttpProxyAgent 分发（NO_PROXY 例外表同样生效），一个没设则保持原生 fetch 零差异。
const proxyDispatcher = proxyEnvEnabled() ? new EnvHttpProxyAgent() : undefined;

export const nodeEnv: PlatformEnv = {
  fetch: (input, init) =>
    proxyDispatcher
      ? (undiciFetch(input, { ...init, dispatcher: proxyDispatcher }) as unknown as Promise<Response>)
      : fetch(input, init),
  now: () => Date.now(),
  randomUUID: () => randomUUID(),
};

export const nodeFileIO: FileIO = {
  // 追加前确保父目录存在：账本/会话日志的 open 不必预建目录
  async appendLine(path: string, line: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line + "\n", "utf8");
  },
  async readAll(path: string): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      // 文件不存在 = 空日志（首次创建）；其余 IO 错误照抛
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter((line) => line.trim() !== "");
  },
};
