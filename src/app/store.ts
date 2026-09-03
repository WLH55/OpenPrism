// 数据目录布局与用户沙盒（ADR 0007：users/{uid}/ 完整沙盒 = 账本 + 会话 + 模型配置）。
// uid 一律为服务端生成的 UUID，用户名不进路径（无遍历风险）。

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface AppPaths {
  dataRoot: string;
  /** 追加式用户注册表（username → uid → PasswordRecord） */
  usersFile: string;
  userDir(uid: string): string;
  /** 账本（只追加） */
  lifeFile(uid: string): string;
  /** 模型接入配置（BYOK：keyEnc 为 AES-256-GCM 密文） */
  modelFile(uid: string): string;
  conversationsDir(uid: string): string;
  /** 单会话目录（内含 session.jsonl，harness 九事件格式） */
  convDir(uid: string, cid: string): string;
}

export function appPaths(dataRoot: string): AppPaths {
  const userDir = (uid: string) => join(dataRoot, "users", uid);
  const conversationsDir = (uid: string) => join(userDir(uid), "conversations");
  return {
    dataRoot,
    usersFile: join(dataRoot, "users.jsonl"),
    userDir,
    lifeFile: (uid) => join(userDir(uid), "life.jsonl"),
    modelFile: (uid) => join(userDir(uid), "model.json"),
    conversationsDir,
    convDir: (uid, cid) => join(conversationsDir(uid), cid),
  };
}

/** 注册即建沙盒（D2b）：目录幂等，重复调用无害 */
export async function ensureUserSandbox(paths: AppPaths, uid: string): Promise<void> {
  await mkdir(paths.userDir(uid), { recursive: true });
  await mkdir(paths.conversationsDir(uid), { recursive: true });
}
