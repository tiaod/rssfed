import { betterAuth } from "better-auth"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "./db"

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
    },
  },
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.BOTS_BASE_URL ?? "http://localhost:3001",
})