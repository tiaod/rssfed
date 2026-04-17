import { db } from '~/lib/db'
import { siteSettings } from '~/lib/schema/site-settings'

export default defineEventHandler(async (event) => {
  // 验证管理员权限
  const { user } = event.context

  if (!user || user.role !== 'admin') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden'
    })
  }

  const body = await readBody(event)

  // 使用 upsert：如果不存在则插入，存在则更新
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
})
