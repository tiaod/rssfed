import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins/admin"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "./db"
import { allowedOrigins, isProduction } from "./config"

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  plugins: [
    admin(),
  ],
  // 注：better-auth 1.7 强制 account 表需有 issuer 字段及 (issuer, accountId) 唯一复合索引。
  // 当前 1.7.2 中尚无 account.identityStrategy 配置项（文档领先于实现），运行时默认即用
  // provider 级身份（local namespace），credential 账号 issuer 为 "local:credential"。
  emailAndPassword: {
    enabled: true,
  },
  // 生产环境只认 CORS_ORIGINS 白名单；开发环境额外放开通配 *，
  // 因为 easytier/局域网 IP 动态变化，逐一配置白名单不现实
  trustedOrigins: isProduction ? allowedOrigins : [...allowedOrigins, "*"],
  // 不使用跨子域 cookie：前端 3000 与后端 3001 同 host（不同端口），
  // cookie 按 host 共享即可；crossSubDomainCookies 会把 Domain 设为 baseURL 的
  // host（localhost），导致手机经局域网 IP 访问时 cookie 不被保存（登录态丢失）
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.BOTS_BASE_URL ?? "http://localhost:3001",
})