import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins/admin"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "./db"
import { allowedOrigins } from "./config"

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  plugins: [
    admin(),
  ],
  emailAndPassword: {
    enabled: true,
  },
  // 开发环境放开 origin 校验（通配 *）：easytier/局域网 IP 动态变化，
  // 逐一配置白名单不现实；生产环境应替换为明确的 trustedOrigins 白名单
  trustedOrigins: [...allowedOrigins, "*"],
  // 不使用跨子域 cookie：前端 3000 与后端 3001 同 host（不同端口），
  // cookie 按 host 共享即可；crossSubDomainCookies 会把 Domain 设为 baseURL 的
  // host（localhost），导致手机经局域网 IP 访问时 cookie 不被保存（登录态丢失）
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.BOTS_BASE_URL ?? "http://localhost:3001",
})