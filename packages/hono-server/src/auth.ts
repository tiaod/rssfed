import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins/admin"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "./db"
import { allowedOrigins } from "./config"

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  plugins: [
    admin(),
  ],
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: allowedOrigins,
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
    },
  },
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.BOTS_BASE_URL ?? "http://localhost:3001",
})