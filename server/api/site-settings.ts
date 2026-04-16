import { db } from '~/lib/db'
import { siteSettings } from '~/lib/schema/site-settings'
import { eq } from 'drizzle-orm'
import { auth } from '~/lib/auth'

export default defineEventHandler(async (event) => {
  // GET: 获取网站设置（公开访问）
  if (event.method === 'GET') {
    const settings = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.id, 'main'))
      .limit(1)

    return {
      settings: settings[0] || null
    }
  }

  // PUT: 更新网站设置（需要管理员权限）
  if (event.method === 'PUT') {
    const session = await auth.api.getSession({
      headers: event.headers
    })

    if (!session?.user || session.user.role !== 'admin') {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden'
      })
    }

    const body = await readBody(event)

    const result = await db
      .insert(siteSettings)
      .values({
        id: 'main',
        siteName: body.siteName,
        siteDescription: body.siteDescription,
        seoTitle: body.seoTitle,
        seoDescription: body.seoDescription,
        seoKeywords: body.seoKeywords,
        logoUrl: body.logoUrl,
        faviconUrl: body.faviconUrl,
        primaryColor: body.primaryColor,
        secondaryColor: body.secondaryColor,
        footerText: body.footerText
      })
      .onConflictDoUpdate({
        target: siteSettings.id,
        set: {
          siteName: body.siteName,
          siteDescription: body.siteDescription,
          seoTitle: body.seoTitle,
          seoDescription: body.seoDescription,
          seoKeywords: body.seoKeywords,
          logoUrl: body.logoUrl,
          faviconUrl: body.faviconUrl,
          primaryColor: body.primaryColor,
          secondaryColor: body.secondaryColor,
          footerText: body.footerText,
          updatedAt: new Date()
        }
      })
      .returning()

    return {
      success: true,
      settings: result[0]
    }
  }

  throw createError({
    statusCode: 405,
    statusMessage: 'Method Not Allowed'
  })
})
