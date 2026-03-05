import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "./db";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg"
  }),
  baseURL: "http://localhost:3000/",
  emailAndPassword: { enabled: true },
  // socialProviders: {
  //   github: {
  //     clientId: process.env.GITHUB_CLIENT_ID || "",
  //     clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  //   },
  // },
});
