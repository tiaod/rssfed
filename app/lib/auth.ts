import { betterAuth } from 'better-auth'
import { admin, customSession } from 'better-auth/plugins'
import { organization } from 'better-auth/plugins/organization'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { createAuthMiddleware } from 'better-auth/api'
import { db } from '~server/lib/db'
import { Redis } from 'ioredis'
import { redisStorage } from '@better-auth/redis-storage'
import { minifluxAccountService, MinifluxServiceError } from './miniflux'
import { minifluxAccount } from './schema/miniflux'
import { eq } from 'drizzle-orm'

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

  session: {
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60
  },

  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // 注册成功后自动创建 Miniflux 账户
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

  trustedOrigins: [
    'http://127.0.0.1:3000',
    'http://localhost:3000'
  ],

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    disableCSRFCheck: false,
    disableOriginCheck: false
  },

  plugins: [
    admin(),
    organization({
      // 允许用户创建组织
      allowUserToCreateOrganization: async (user) => {
        // 只允许已验证邮箱的用户创建组织
        return user.emailVerified === true
      },
      // 每个用户最多创建多少组织
      organizationLimit: 5,
      // 每个组织最多多少成员
      membershipLimit: 50,
      // 启用动态权限控制（自定义角色）
      dynamicAccessControl: {
        enabled: true
      }
    }),
    // 自定义 session，添加 Miniflux 信息
    customSession(async ({ user, session }) => {
      // 查询 Miniflux 账户信息
      const miniflux = await db.query.minifluxAccount.findFirst({
        columns: {
          minifluxUserId: true,
          minifluxUsername: true,
          minifluxApiKey: true
        },
        where: eq(minifluxAccount.userId, user.id)
      })

      // 返回拓展后的 session，包含 miniflux 信息
      // admin 插件已经添加了 role/banned 等字段，这里用类型断言
      const userWithAdmin = user as typeof user & {
        role?: string
        banned?: boolean
        banReason?: string | null
        banExpires?: Date | null
      }

      return {
        user: {
          ...userWithAdmin,
          miniflux: miniflux
            ? {
                minifluxUserId: miniflux.minifluxUserId,
                minifluxUsername: miniflux.minifluxUsername,
                minifluxApiKey: miniflux.minifluxApiKey
              }
            : null
        },
        session
      }
    })
  ]
})
