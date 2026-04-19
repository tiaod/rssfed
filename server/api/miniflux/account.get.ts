import { pick } from 'es-toolkit/object'
import { head } from 'es-toolkit/array'
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
    // 用 pick 选出需要的列，避免手动写重复的键值对
    const selectedColumns = pick(minifluxAccount, ['minifluxUserId', 'minifluxUsername', 'minifluxApiKey'])

    const existing = await db
      .select(selectedColumns)
      .from(minifluxAccount)
      .where(eq(minifluxAccount.userId, session.user.id))
      .limit(1)

    const account = head(existing)

    if (account?.minifluxApiKey) {
      return {
        success: true,
        data: {
          minifluxUserId: account.minifluxUserId,
          username: account.minifluxUsername,
          apiKey: account.minifluxApiKey,
          endpoint: process.env.MINIFLUX_BASE_URL
        }
      }
    }

    await minifluxAccountService.createMinifluxAccount(session.user.id, session.user.email)

    const created = head(await db
      .select(selectedColumns)
      .from(minifluxAccount)
      .where(eq(minifluxAccount.userId, session.user.id))
      .limit(1)
    )

    return {
      success: true,
      data: {
        minifluxUserId: created!.minifluxUserId,
        username: created!.minifluxUsername,
        apiKey: created!.minifluxApiKey,
        endpoint: process.env.MINIFLUX_BASE_URL
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
