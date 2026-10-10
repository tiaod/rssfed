import { describe, expect, it, vi } from "vitest"

/**
 * FeedDoc 的 CouchDB 文档 id 规则。
 *
 * feedId 是 base64url 派生的，会以 `_` 开头（现网 707 个源里 9 个），而 CouchDB 保留
 * `_` 开头的文档 id：直接用 feedId 当 `_id` 的源，每次抓取都在写 FeedDoc 时失败，
 * 库里只剩 `_design/main`，表现为「订阅在、永远没数据」。
 */

// services/feeds 会拉进 Redis/PG 客户端，这里只关心 deriveFeedId，mock 掉即可
vi.mock("../workers", () => ({ enqueueFetch: async () => {} }))
vi.mock("../db", () => ({ db: {}, feeds: {}, bots: {} }))
vi.mock("../couchdb/client", () => ({
  createCouchDb: () => ({}),
  ensureFeedDatabase: async () => "db_feed",
  ensureTimelineDatabase: async () => "db_user",
}))

const { feedDocId } = await import("../couchdb/doc-ids")
const { deriveFeedId } = await import("../services/feeds")

describe("feedDocId", () => {
  it("下划线开头的 feedId 加前缀，CouchDB 才肯收", () => {
    expect(feedDocId("_2lv5T_YCYekFKFn")).toBe("feed_2lv5T_YCYekFKFn")
    expect(feedDocId("_2lv5T_YCYekFKFn").startsWith("_")).toBe(false)
  })

  it("普通 feedId（含历史 12 位短 id）原样返回，存量文档不受影响", () => {
    expect(feedDocId("bggSCJ7OCiDyRiZ5")).toBe("bggSCJ7OCiDyRiZ5")
    expect(feedDocId("up3NhjCYA4Ra")).toBe("up3NhjCYA4Ra")
  })

  it("加前缀后长度 20，与未加前缀的 12/16 位 id 不可能撞车", () => {
    const escaped = feedDocId("_2lv5T_YCYekFKFn")
    const plain = feedDocId("2lv5T_YCYekFKFn1")
    expect(escaped).toHaveLength(20)
    expect(plain).toHaveLength(16)
    expect(escaped).not.toBe(plain)
  })

  it("任何 feedId 都转不出下划线开头的文档 id", () => {
    const ids = ["_x", "_2lv5T_YCYekFKFn", "-2lv5T_YCYekFKFn", "normalId12345678"]
    for (const id of ids) expect(feedDocId(id).startsWith("_")).toBe(false)
  })

  it("真实案例：smashingsecurity 的 feedId 以 _ 开头（就是报 reserved 错的那批）", () => {
    const feedId = deriveFeedId("https://www.smashingsecurity.com/rss")
    expect(feedId.startsWith("_")).toBe(true)
    expect(feedDocId(feedId)).toBe(`feed${feedId}`)
  })
})
