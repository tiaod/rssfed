import { drizzle } from 'drizzle-orm/node-postgres'
import * as authSchema from './schema/auth'
import * as minifluxSchema from './schema/miniflux'

const schema = {
  ...authSchema,
  ...minifluxSchema
}

export const db = drizzle(process.env.DATABASE_URL!, { schema })
