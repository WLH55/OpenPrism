// 测试夹具：:memory: SQLite（零磁盘 IO），DDL 由 openDb 幂等建好。

import { openDb } from "../src/app/db";

export function testDb(): ReturnType<typeof openDb> {
  return openDb(":memory:");
}
