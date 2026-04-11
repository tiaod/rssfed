import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { createAuthMiddleware } from 'better-auth/api'
import { db } from './db'
import { Redis } from 'ioredis'
import { redisStorage } from '@better-auth/redis-storage'
import { minifluxAccountService, MinifluxServiceError } from './miniflux'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg'
  }),
  secondaryStorage: redisStorage({
    client: redis,
    keyPrefix: 'better-auth:'
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: true
  },

  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: false,
    expiresIn: 60 * 60
  },

  session: {
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    cookieCache: {
      strategy: 'jwe',
      maxAge: 60 * 60
    }
  },

  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path.startsWith('/sign-up')) {
        const newSession = ctx.context.newSession
        if (newSession) {
          const { user } = newSession
          try {
            await ctx.context.runInBackgroundOrAwait(
              minifluxAccountService.createMinifluxAccount(user.id, user.email)
            )
            console.log(`Miniflux 账户创建成功: 用户ID ${user.id}`)
          } catch (error) {
            if (error instanceof MinifluxServiceError) {
              console.error(`Miniflux 服务错误: ${error.message}`, error.cause)
            } else {
              console.error('创建 Miniflux 账户时发生未知错误:', error)
            }
          }
        }
      }
    })
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    disableCSRFCheck: false,
    disableOriginCheck: false
  },

  rateLimit: {
    enabled: true,
    window: 15 * 60,
    max: 100,
    storage: 'secondary-storage'
  }
})
