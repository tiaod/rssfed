import { db } from '~/lib/db'
import { siteSettings } from '~/lib/schema/site-settings'
import { eq } from 'drizzle-orm'

export default defineEventHandler(async () => {
  const settings = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.id, 'main'))
    .limit(1)

  return {
    settings: settings[0] || null
  }
})
