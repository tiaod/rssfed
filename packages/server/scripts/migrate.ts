import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://rssfed:rssfed@127.0.0.1:5432/rssfed'

const sql = postgres(connectionString, { max: 1 })
const db = drizzle(sql)

console.log('Running migrations...')
await migrate(db, { migrationsFolder: './drizzle' })
console.log('Done!')
await sql.end()
