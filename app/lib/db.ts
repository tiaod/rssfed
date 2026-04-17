import { drizzle } from 'drizzle-orm/node-postgres'
import * as auth from './schema/auth'
import * as files from './schema/files'
import * as siteSettings from './schema/site-settings'
import * as miniflux from './schema/miniflux'

// 合并所有导出的表定义到 schema 对象
const schema = {
  ...auth,
  ...files,
  ...siteSettings,
  ...miniflux
}

export const db = drizzle(process.env.DATABASE_URL!, { schema })
