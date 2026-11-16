import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // 单测大量依赖 127.0.0.1 上的临时 HTTP 服务（抓取、图片、大小上限、代理回退）。
      // 不关掉 SSRF 闸门的话这些测试会因为"拒绝访问内网"而全灭 —— 它们测的是抓取逻辑，
      // 不是防护本身。防护自己在 src/__tests__/ssrf-guard.test.ts 里被单独验证
      // （那个文件内的用例不受此开关影响：它在用例里直接断言 isBlockedIp）。
      SSRF_GUARD_ALLOW_PRIVATE: "1",
    },
  },
})
