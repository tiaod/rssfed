import { Hono } from 'hono'
import { db } from '~server/lib/db'
import { siteSettings } from '~/lib/schema/site-settings'
import { eq } from 'drizzle-orm'
import { requireAdmin } from './_auth'

const app = new Hono()

app.get('/', async (c) => {
  const settings = await db.select().from(siteSettings).where(eq(siteSettings.id, 'main')).limit(1)
  return c.json({ settings: settings[0] || null })
})

app.put('/', async (c) => {
  requireAdmin(c)

  const body = await c.req.json()
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

  return c.json({ success: true, settings: result[0] })
})

export default app
