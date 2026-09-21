import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  /**
   * Fedify（@fedify/postgres）自建自管 `fedify_kv_v2` / `fedify_message_v2` 两张表。
   * 它们不在本仓库的 schema 里，不排除的话 push 会把它们当成「多余的副本」直接 DROP，
   * 而 migrate 服务跑的是 `push --force`（无人值守、自动批准数据丢失语句）——
   * KV 表里存着 Bot 的 ActivityPub 密钥对，被删即永久丢失联邦身份。
   * 详见 ARCHITECTURE.md 的「为什么订阅关系在 CouchDB 而不在 PostgreSQL」一节。
   */
  tablesFilter: ["*", "!fedify_*"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/rssfed",
  },
})
