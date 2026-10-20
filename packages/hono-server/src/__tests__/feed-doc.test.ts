import { describe, expect, it } from "vitest"
import { buildFeedDoc, feedDocDisplayChanged, mergeFeedDocDisplay, shouldCacheFeedIcon, shouldWriteFeedDoc } from "../workers/feed-doc"
import type { ParsedFeed } from "../rss/parser"

/**
 * FeedDoc 是会被复制进**每个订阅者用户库**的源元信息快照，所以这里钉两条不变量：
 *   1. 展示字段没变化时不产生新修订（否则每轮抓取都给所有用户库写一版）；
 *   2. 抓取簿记（lastFetchedAt / ETag / errorMessage…）永远不进这份文档。
 */

const parsed: ParsedFeed = {
  title: "果壳",
  link: "https://www.guokr.com/",
  description: "科学和技术",
  image: { url: "https://wx.qlogo.cn/icon.png" },
  items: [],
}

function display(overrides: Partial<ReturnType<typeof mergeFeedDocDisplay>> = {}) {
  return { ...mergeFeedDocDisplay(null, parsed, "https://feed.example/rss"), ...overrides }
}

describe("mergeFeedDocDisplay", () => {
  it("首次：从解析结果取展示字段，url 用抓取地址", () => {
    expect(display()).toEqual({
      title: "果壳",
      description: "科学和技术",
      siteUrl: "https://www.guokr.com/",
      image: "https://wx.qlogo.cn/icon.png",
      url: "https://feed.example/rss",
    })
  })

  it("解析不到的字段沿用旧值（不要用 undefined 把文档字段抹掉）", () => {
    const existing = {
      title: "旧标题",
      description: "旧简介",
      siteUrl: "https://old.example/",
      image: "https://old.example/icon.png",
      url: "https://feed.example/rss",
    }
    const next = mergeFeedDocDisplay(existing, { title: "", items: [] }, "https://feed.example/rss")
    expect(next).toEqual({
      title: "旧标题", // 空标题也回退
      description: "旧简介",
      siteUrl: "https://old.example/",
      image: "https://old.example/icon.png",
      url: "https://feed.example/rss",
    })
  })

  it("url 以旧文档为准（重定向不回写源地址）", () => {
    const next = mergeFeedDocDisplay({ title: "t", url: "https://original/" }, parsed, "https://redirected/")
    expect(next.url).toBe("https://original/")
  })
})

describe("shouldWriteFeedDoc", () => {
  it("首次创建要写", () => {
    expect(shouldWriteFeedDoc(null, display())).toBe(true)
  })

  it("展示字段完全没变 → 不写（这是不产生无意义修订的关键）", () => {
    const next = display()
    const existing = { ...next, _id: "f1", _rev: "3-abc", createdAt: "2026-01-01T00:00:00.000Z" }
    expect(shouldWriteFeedDoc(existing, next)).toBe(false)
  })

  it("标题 / 简介 / 站点 / 封面任一变化都要写", () => {
    const next = display()
    const existing = { ...next, _id: "f1", _rev: "3-abc" }
    expect(shouldWriteFeedDoc(existing, { ...next, title: "新标题" })).toBe(true)
    expect(shouldWriteFeedDoc(existing, { ...next, description: "新简介" })).toBe(true)
    expect(shouldWriteFeedDoc(existing, { ...next, siteUrl: "https://new.example/" })).toBe(true)
    expect(shouldWriteFeedDoc(existing, { ...next, image: "https://new.example/icon.png" })).toBe(true)
  })

  it("旧文档还带着抓取簿记 → 写一次做清理（一次性迁移）", () => {
    const next = display()
    const existing = { ...next, _id: "f1", _rev: "900-abc", lastFetchedAt: "2026-01-01T00:00:00.000Z" }
    expect(shouldWriteFeedDoc(existing, next)).toBe(true)
  })
})

describe("feedDocDisplayChanged", () => {
  it("首次算变化", () => {
    expect(feedDocDisplayChanged(null, display())).toBe(true)
  })

  it("只清理遗留簿记不算展示变化（不该因此叫醒所有订阅者）", () => {
    const next = display()
    const existing = { ...next, _id: "f1", _rev: "900-abc", lastFetchedAt: "2026-01-01T00:00:00.000Z" }
    expect(feedDocDisplayChanged(existing, next)).toBe(false)
    // 但文档仍然需要重写（清理）
    expect(shouldWriteFeedDoc(existing, next)).toBe(true)
  })

  it("标题变化算展示变化", () => {
    const next = display()
    expect(feedDocDisplayChanged({ ...next }, { ...next, title: "新标题" })).toBe(true)
  })
})

describe("buildFeedDoc", () => {
  it("首次创建：带 _id/type/createdAt，且不含任何抓取簿记字段", () => {
    const doc = buildFeedDoc(null, display(), "f1", "2026-10-20T00:00:00.000Z")
    expect(doc).toMatchObject({
      _id: "f1",
      type: "feed",
      title: "果壳",
      description: "科学和技术",
      siteUrl: "https://www.guokr.com/",
      image: "https://wx.qlogo.cn/icon.png",
      url: "https://feed.example/rss",
      createdAt: "2026-10-20T00:00:00.000Z",
    })
    for (const key of ["lastFetchedAt", "errorMessage", "fetchEtag", "fetchLastModified", "fetchValidatorUrl"]) {
      expect(doc).not.toHaveProperty(key)
    }
  })

  it("更新：保留 _rev/createdAt/imageCached 与未知字段，清掉旧簿记", () => {
    const existing = {
      _id: "f1",
      _rev: "900-abc",
      type: "feed",
      url: "https://feed.example/rss",
      title: "旧标题",
      description: undefined,
      siteUrl: undefined,
      image: undefined,
      imageCached: { url: "https://x/icon.png", attachment: "feed-image.avif", v: 2 },
      createdAt: "2026-01-01T00:00:00.000Z",
      lastFetchedAt: "2026-01-01T00:00:00.000Z",
      errorMessage: "boom",
      fetchEtag: 'W/"old"',
      fetchLastModified: "LM",
      fetchValidatorUrl: "https://feed.example/rss",
      someFutureField: 42,
    }
    const doc = buildFeedDoc(existing, display(), "f1", "2026-10-20T00:00:00.000Z")
    expect(doc).toMatchObject({
      _id: "f1",
      _rev: "900-abc",
      createdAt: "2026-01-01T00:00:00.000Z",
      imageCached: existing.imageCached,
      someFutureField: 42,
      title: "果壳",
    })
    for (const key of ["lastFetchedAt", "errorMessage", "fetchEtag", "fetchLastModified", "fetchValidatorUrl"]) {
      expect(doc).not.toHaveProperty(key)
    }
  })
})

describe("shouldCacheFeedIcon", () => {
  const url = "https://x.example/icon.png"
  const cached = { url, attachment: "feed-image.avif", v: 2 }

  it("没有图标 URL → 不缓存", () => {
    expect(shouldCacheFeedIcon(null, undefined, 2)).toBe(false)
    expect(shouldCacheFeedIcon({ imageCached: cached }, undefined, 2)).toBe(false)
  })

  it("首次 / URL 变了 / 参数版本升级 → 重做", () => {
    expect(shouldCacheFeedIcon(null, url, 2)).toBe(true)
    expect(shouldCacheFeedIcon({}, url, 2)).toBe(true)
    expect(shouldCacheFeedIcon({ imageCached: { ...cached, url: "https://old/icon.png" } }, url, 2)).toBe(true)
    expect(shouldCacheFeedIcon({ imageCached: { ...cached, v: 1 } }, url, 2)).toBe(true)
  })

  it("URL 与版本都一致 → 不重做（否则每次抓取都重下图标）", () => {
    expect(shouldCacheFeedIcon({ imageCached: cached }, url, 2)).toBe(false)
  })
})
