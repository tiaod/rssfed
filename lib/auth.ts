import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from './db'
import { Redis } from 'ioredis'
import { redisStorage } from '@better-auth/redis-storage'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg'
  }),
  secondaryStorage: redisStorage({
    client: redis,
    keyPrefix: 'better-auth:'
  }),
  // 从环境变量读取配置，生产环境自动读取
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  
  // 邮箱密码登录配置
  emailAndPassword: {
    enabled: true,
    // 密码策略
    passwordMinLength: 8,
    // 自动发送验证邮件
    requireEmailVerification: true,
  },
  
  // 邮箱验证流程
  emailVerification: {
    enabled: true,
    sendOnSignUp: true,
    sendOnSignIn: false,
    // 验证邮件有效期：1小时
    expiresIn: 60 * 60,
    // 验证后的重定向地址
    redirectTo: '/dashboard',
    // 自定义发送逻辑（需要配置邮件服务后取消注释）
    // sendVerificationEmail: async ({ user, url, token }) => {
    //   // 调用你的邮件服务发送验证邮件
    //   console.log(`发送验证邮件给 ${user.email}: ${url}`)
    // }
  },
  
  // 密码重置配置
  resetPassword: {
    enabled: true,
    // 重置链接有效期：15分钟
    expiresIn: 15 * 60,
    // 重置后的重定向地址
    redirectTo: '/login?reset=success',
    // 自定义发送逻辑
    // sendResetPassword: async ({ user, url, token }) => {
    //   console.log(`发送密码重置邮件给 ${user.email}: ${url}`)
    // }
  },
  
  // 会话配置
  session: {
    // 会话有效期：7天
    expiresIn: 7 * 24 * 60 * 60,
    // 会话更新间隔：24小时
    updateAge: 24 * 60 * 60,
    cookieCache: {
      // 使用加密JWT存储会话信息，更安全
      strategy: 'jwe',
      // 缓存有效期：1小时
      maxAge: 60 * 60,
    },
  },
  
  // 安全配置
  advanced: {
    // 生产环境自动启用安全Cookie
    useSecureCookies: process.env.NODE_ENV === 'production',
    // 允许跨域的来源（生产环境需要配置具体域名）
    trustedOrigins: process.env.NODE_ENV === 'production' 
      ? ['https://yourdomain.com'] 
      : ['http://localhost:3000'],
    // 防止CSRF攻击
    disableCSRFCheck: false,
    // 防止来源伪造
    disableOriginCheck: false,
  },
  
  // 限流配置，防止暴力破解
  rateLimit: {
    enabled: true,
    // 15分钟窗口
    window: 15 * 60,
    // 最多100次请求
    max: 100,
    // 使用 Redis 存储限流数据
    storage: 'secondary-storage',
  },
  
  // 第三方登录（需要时取消注释）
  // socialProviders: {
  //   github: {
  //     clientId: process.env.GITHUB_CLIENT_ID || "",
  //     clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  //   },
  //   // 可以添加更多第三方登录：google, wechat, etc.
  // },
  
  // 插件（需要时添加，比如双因素认证、组织管理等）
  // plugins: [
  //   twoFactor(), // 双因素认证
  //   organization(), // 多租户组织管理
  // ],
})
