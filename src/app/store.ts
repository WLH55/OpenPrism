// 数据目录布局（ADR 0008）：SQLite 单库 + 主密钥文件。用户数据全部入库（users/{uid}/ 文件沙盒取消）。
// uid 一律为服务端生成的 UUID，用户名不进任何路径语义。

import { join } from "node:path";

export interface AppPaths {
  dataRoot: string;
  /** SQLite 数据库（全部领域数据） */
  dbFile: string;
  /** 主密钥（AES-256-GCM 加密 BYOK Key 用）；已 gitignore */
  secretKeyFile: string;
}

export function appPaths(dataRoot: string): AppPaths {
  return {
    dataRoot,
    dbFile: join(dataRoot, "openprism.db"),
    secretKeyFile: join(dataRoot, "secret.key"),
  };
}
