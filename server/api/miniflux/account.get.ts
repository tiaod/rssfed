import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { minifluxAccount } from '~/lib/schema/miniflux'
import { eq } from 'drizzle-orm'
import { minifluxAccountService, MinifluxServiceError } from '~/lib/miniflux/service'

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({
    headers: event.headers
  })

  if (!session?.user) {
    throw createError({
      statusCode: 401,
      message: '未登录'
    })
  }

  try {
    // 仅返回非敏感信息，apiKey 仅在服务端内部使用，永不暴露给客户端
    const existing = await db.query.minifluxAccount.findFirst({
      columns: {
        minifluxUserId: true,
        minifluxUsername: true
      },
      where: eq(minifluxAccount.userId, session.user.id)
    })

    if (existing) {
      return {
        success: true,
        data: {
          minifluxUserId: existing.minifluxUserId,
          username: existing.minifluxUsername
        }
      }
    }

    await minifluxAccountService.createMinifluxAccount(session.user.id, session.user.email)

    const created = await db.query.minifluxAccount.findFirst({
      columns: {
        minifluxUserId: true,
        minifluxUsername: true
      },
      where: eq(minifluxAccount.userId, session.user.id)
    })

    return {
      success: true,
      data: {
        minifluxUserId: created!.minifluxUserId,
        username: created!.minifluxUsername
      }
    }
  } catch (error) {
    if (error instanceof MinifluxServiceError) {
      throw createError({
        statusCode: 502,
        message: `Miniflux 服务错误: ${error.message}`
      })
    }

    if (error instanceof Error && 'statusCode' in error) {
      throw error
    }

    if (error instanceof Error) {
      throw createError({
        statusCode: 500,
        message: error.message
      })
    }

    throw createError({
      statusCode: 500,
      message: '未知错误'
    })
  }
})
