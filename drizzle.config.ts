import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: [
    './auth-schema.ts', // 这个是使用better-auth生成的schema，npx auth generate就可以生成。
    './lib/schema/*.ts'
  ],
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!
  }
})
