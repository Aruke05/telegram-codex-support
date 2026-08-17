import { describe, expect, it } from "vitest"

import { loadEnv } from "../../src/config/env.js"

describe("loadEnv", () => {
  it("空配置使用仅本机可访问的安全默认值", () => {
    expect(loadEnv({})).toEqual({
      host: "127.0.0.1",
      port: 3210,
      dataDir: "./data",
      logLevel: "info",
    })
  })

  it("拒绝监听所有网卡", () => {
    expect(() => loadEnv({ HOST: "0.0.0.0" })).toThrow("HOST 只允许本机回环地址")
  })

  it("受限容器可配合宿主机回环端口监听", () => {
    expect(loadEnv({ HOST: "0.0.0.0", CONTAINER_BIND: "true" }).host).toBe("0.0.0.0")
  })

  it("拒绝超出范围的端口", () => {
    expect(() => loadEnv({ PORT: "70000" })).toThrow("PORT")
  })
})
