import { beforeEach, describe, expect, it, vi } from "vitest"
import { deriveFeedId, parseSubscription, subscriptionDocId, SUBSCRIPTION_TYPE } from "../couchdb/subscription-doc"

/**
 * 订阅文档的校验与 feedId 派生。
 *
 * 这是新模型的**入口闸门**：调度读到的每条订阅都要过这里，判错的代价不对称 ——
 * 多拒一条 = 那个源不再被抓（用户看到"订阅在、一直没内容"）；
 * 少拒一条坏文档 = 条目会以错误的 id 前缀落库，下次按正确 id 派生时读不到、永远重复写。
 */

describe("deriveFeedId", () => {
  it("同一个 URL 恒定派生同一个 id（跨 owner 一致）", () => {
    const url = "https://example.com/feed.xml"
    expect(deriveFeedId(url)).toBe(deriveFeedId(url))
    // 16 位 base64url：与历史数据一致，长度不能变
    expect(deriveFeedId(url)).toHaveLength(16)
  })

  it("不同 URL 派生不同 id", () => {
    expect(deriveFeedId("https://a.test/rss")).not.toBe(deriveFeedId("https://b.test/rss"))
  })

  it("只差一个字符也算不同源（不能做前缀截断之类的小聪明）", () => {
    expect(deriveFeedId("https://a.test/rss1")).not.toBe(deriveFeedId("https://a.test/rss2"))
  })

  it("可能带下划线开头（CouchDB 文档 id 要另加前缀，见 doc-ids.ts）", () => {
    // 不是每个 id 都以下划线开头，但只要存在就必须由调用方处理 —— 这里只是确认派生结果原样返回
    const ids = Array.from({ length: 200 }, (_, i) => deriveFeedId(`https://site${i}.test/feed`))
    expect(ids.every((id) => id.length === 16)).toBe(true)
  })
})

describe("subscriptionDocId", () => {
  it("前缀固定为 subscription:", () => {
    expect(subscriptionDocId("abc")).toBe("subscription:abc")
    expect(SUBSCRIPTION_TYPE).toBe("subscription")
  })
})

describe("parseSubscription", () => {
  const url = "https://example.com/feed.xml"
  const feedId = deriveFeedId(url)

  it("正常订阅：返回规范化后的字段", () => {
    const parsed = parseSubscription({
      _id: subscriptionDocId(feedId),
      type: SUBSCRIPTION_TYPE,
      feedId,
      url,
      title: "示例源",
      paused: true,
    })
    expect(parsed).toEqual({
      ok: true,
      feedId,
      url,
      title: "示例源",
      paused: true,
    })
  })

  it("缺标题时用 url 兜底", () => {
    const parsed = parseSubscription({ feedId, url, title: "   " })
    expect(parsed).toMatchObject({ ok: true, title: url })
  })

  it("paused 只有明确 true 才算暂停（老文档没有这个字段 = 未暂停）", () => {
    expect(parseSubscription({ feedId, url })).toMatchObject({ ok: true, paused: false })
    expect(parseSubscription({ feedId, url, paused: false })).toMatchObject({ ok: true, paused: false })
    // 脏值（字符串 "true"）不认 —— 客户端可写，不能信类型
    expect(parseSubscription({ feedId, url, paused: "true" } as never)).toMatchObject({ ok: true, paused: false })
  })

  it("Bot 订阅不算 RSS 源：不抓", () => {
    expect(parseSubscription({ feedId: "bot:abc", url: "https://x.test/rss", kind: "bot" }))
      .toEqual({ ok: false, reason: "bot-subscription" })
  })

  it("缺 feedId → 拒绝", () => {
    expect(parseSubscription({ url })).toEqual({ ok: false, reason: "missing-feed-id" })
    expect(parseSubscription({ feedId: "", url })).toEqual({ ok: false, reason: "missing-feed-id" })
    expect(parseSubscription(null)).toEqual({ ok: false, reason: "missing-feed-id" })
  })

  it("缺 url → 拒绝（重构前写入的老订阅就是这种，没法自动补）", () => {
    expect(parseSubscription({ feedId })).toEqual({ ok: false, reason: "missing-url" })
    expect(parseSubscription({ feedId, url: "   " })).toEqual({ ok: false, reason: "missing-url" })
    expect(parseSubscription({ feedId, url: 42 } as never)).toEqual({ ok: false, reason: "missing-url" })
  })

  it("feedId 与 url 不匹配 → 拒绝（客户端可写，能写出这种脏文档）", () => {
    // url 是 A 的、feedId 是 B 的：按 A 写条目会让 B 的前缀永远读不到它们
    const otherId = deriveFeedId("https://other.test/feed.xml")
    expect(parseSubscription({ feedId, url: "https://other.test/feed.xml" }))
      .toEqual({ ok: false, reason: "url-feed-id-mismatch" })
    // 反过来也一样：id 对但 url 被换掉了
    expect(parseSubscription({ feedId: otherId, url }))
      .toEqual({ ok: false, reason: "url-feed-id-mismatch" })
  })

  it("url 前后的空白会被 trim 掉再比对（粘贴带空格的地址不该被判脏）", () => {
    expect(parseSubscription({ feedId, url: `  ${url}  ` })).toMatchObject({ ok: true, url })
  })
})
