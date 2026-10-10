import { describe, expect, it } from "vitest"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import { feeds } from "../db/schema"
import { buildFeedRegistryUpdate } from "../workers/feed-registry"
import type { ParsedFeed } from "../rss/parser"

/**
 * 只用来生成 SQL 文本：drizzle 在 `.toSQL()` 阶段不碰客户端，
 * 传空对象即可（不建连接、不读 DATABASE_URL，避免测试挂住连接池）。
 */
const sqlOnlyDb = drizzle({} as any)

const parsed: ParsedFeed = {
  title: "oO大黄Oo的文章",
  link: "https://www.acfun.cn/u/1384329",
  description: "这个人很懒，神马都没有写…",
  items: [],
}

function toSql(set: Record<string, unknown>) {
  return sqlOnlyDb.update(feeds).set(set as any).where(eq(feeds.id, "f1")).toSQL()
}

describe("buildFeedRegistryUpdate", () => {
  it("抓取成功后把 errorMessage 显式置为 null", () => {
    const update = buildFeedRegistryUpdate("https://rsshub.app/acfun/user/article/1384329", parsed)
    expect(update.errorMessage).toBeNull()
  })

  it("生成的 UPDATE 里带 error_message = NULL", () => {
    const q = toSql(buildFeedRegistryUpdate("https://x/feed", parsed))
    expect(q.sql).toContain('"error_message"')
    expect(q.params).toContain(null)
  })

  // 回归：旧实现写的是 errorMessage: undefined，Drizzle 会把值为 undefined 的列
  // 整条从 UPDATE 里丢掉（见 pg-core dialect 的 buildUpdateSet），于是「抓取成功」
  // 永远清不掉上一轮的错误状态。这条断言就是那个 bug 本身。
  it("反面对照：errorMessage 写 undefined 时该列不会出现在 SQL 里", () => {
    const buggy = toSql({ errorMessage: undefined, lastFetchedAt: new Date() })
    expect(buggy.sql).not.toContain('"error_message"')
  })

  it("标题为空时回退到 url，并原样带上 description/siteUrl 与抓取时间", () => {
    const now = new Date("2026-10-10T13:00:00.000Z")
    const update = buildFeedRegistryUpdate("https://x/feed", { ...parsed, title: undefined as any }, now)
    expect(update.title).toBe("https://x/feed")
    expect(update.description).toBe(parsed.description)
    expect(update.siteUrl).toBe(parsed.link)
    expect(update.lastFetchedAt).toBe(now)
  })

  it("解析不到的字段保持 undefined（表示不动这一列，不要误写成 null 清空）", () => {
    const update = buildFeedRegistryUpdate("https://x/feed", { title: "t", items: [] })
    expect(update.description).toBeUndefined()
    expect(update.siteUrl).toBeUndefined()
    // 这两个字段不该进 UPDATE，只有 errorMessage/lastFetchedAt 必须写
    const q = toSql(update)
    expect(q.sql).not.toContain('"description"')
    expect(q.sql).toContain('"last_fetched_at"')
  })
})
