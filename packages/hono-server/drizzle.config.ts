import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  /**
   * Fedify（@fedify/postgres）自建自管 `fedify_kv_v2` / `fedify_message_v2` 两张表。
   *
   * 主防线是**把这两张表放进独立 schema**（见 src/bots/index.ts 的 FEDIFY_SCHEMA）：
   * drizzle 默认只管理 `public`，非 public 的表它根本看不到。
   * 这里再排除一次是第二道防线 —— 万一将来有人把它们建回 public，push 也不会当
   * 「多余的副本」DROP。migrate 服务跑的是 `push --force`（无人值守、自动批准数据
   * 丢失语句），而 KV 表里存着 Bot 的 ActivityPub 密钥对，被删即永久丢失联邦身份。
   * 详见 ARCHITECTURE.md 的「为什么订阅关系在 CouchDB 而不在 PostgreSQL」一节。
   */
  tablesFilter: ["*", "!fedify_*"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/rssfed",
  },
})
