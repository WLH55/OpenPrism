// 批次·env：nodeEnv 代理开关纯函数（零网络；undici 分发器本身无法离线测，只测决策逻辑）。

import { describe, expect, it } from "vitest";
import { proxyEnvEnabled } from "../src/app/env";

describe("proxyEnvEnabled", () => {
  it("未设任何代理变量 → 关", () => {
    expect(proxyEnvEnabled({})).toBe(false);
  });

  it("大小写任一变体 → 开（HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy）", () => {
    expect(proxyEnvEnabled({ HTTPS_PROXY: "http://127.0.0.1:7890" })).toBe(true);
    expect(proxyEnvEnabled({ https_proxy: "http://127.0.0.1:7890" })).toBe(true);
    expect(proxyEnvEnabled({ HTTP_PROXY: "http://127.0.0.1:7890" })).toBe(true);
    expect(proxyEnvEnabled({ http_proxy: "http://127.0.0.1:7890" })).toBe(true);
  });

  it("空串视为未设置", () => {
    expect(proxyEnvEnabled({ HTTPS_PROXY: "" })).toBe(false);
  });

  it("只设 NO_PROXY 不算启用（例外表单独存在，不构成代理配置）", () => {
    expect(proxyEnvEnabled({ NO_PROXY: "localhost" })).toBe(false);
  });
});
