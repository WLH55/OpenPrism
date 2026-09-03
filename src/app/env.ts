// Node 平台缝实现（设计 §2 平台注入的宿主侧）：harness 零平台依赖，本文件是它跑在 Node 上的那份注入。
// 仅 app 层可 import Node 模块；harness 目录的铁律不因此松动。

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileIO, PlatformEnv } from "../harness/index";

export const nodeEnv: PlatformEnv = {
  fetch: (input, init) => fetch(input, init),
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
