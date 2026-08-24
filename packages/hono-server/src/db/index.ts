import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"
import * as authSchema from "./auth-schema"

const connectionString = process.env.DATABASE_URL ?? "postgres://localhost:5432/rssfed"

const client = postgres(connectionString)

const fullSchema = { ...schema, ...authSchema }

export const db = drizzle(client, { schema: fullSchema })

export { fullSchema as schema }
export * from "./schema"
export * from "./auth-schema"
export * from "./types"
export * from "./constants"