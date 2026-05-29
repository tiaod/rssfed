import { drizzle } from 'drizzle-orm/node-postgres'
import * as auth from '~/lib/schema/auth'
import * as files from '~/lib/schema/files'
import * as siteSettings from '~/lib/schema/site-settings'
import * as miniflux from '~/lib/schema/miniflux'
import * as federation from '~/lib/schema/federation'

const schema = {
  ...auth,
  ...files,
  ...siteSettings,
  ...miniflux,
  ...federation
}

export const db = drizzle(process.env.DATABASE_URL!, { schema })
