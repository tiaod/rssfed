import { describe, expect, it } from "vitest"
import { selectNewestItems } from "../workers/entry-selection"

/** 构造一个带发布时间的条目（pubDate 用 ISO，方便 Date.parse） */
function item(title: string, iso?: string, extra: Record<string, unknown> = {}) {
  return { title, pubDate: iso, ...extra }
}

const NOW = Date.parse("2026-10-18T12:00:00Z")

describe("selectNewestItems", () => {
  it("未超上限时原样返回（不排序、不拷贝）", () => {
    const items = [item("a", "2026-01-01T00:00:00Z"), item("b", "2026-02-01T00:00:00Z")]
    expect(selectNewestItems(items, 50, NOW)).toBe(items)
  })

  it("按发布时间降序截到最新 N 条（乱序 feed 也不漏新条目）", () => {
    const items = [
      item("old", "2026-09-01T00:00:00Z"),
      item("newest", "2026-10-17T00:00:00Z"),
      item("middle", "2026-09-20T00:00:00Z"),
    ]
    expect(selectNewestItems(items, 2, NOW).map(i => i.title)).toEqual(["newest", "middle"])
  })

  it("同一时间戳保持 feed 原顺序（稳定排序）", () => {
    const items = [
      item("first", "2026-10-01T00:00:00Z"),
      item("second", "2026-10-01T00:00:00Z"),
      item("third", "2026-10-01T00:00:00Z"),
    ]
    expect(selectNewestItems(items, 2, NOW).map(i => i.title)).toEqual(["first", "second"])
  })

  it("无发布时间的条目按抓取时刻算，优先于旧存档", () => {
    const items = [
      item("archive", "2025-01-01T00:00:00Z"),
      item("undated"),
    ]
    expect(selectNewestItems(items, 1, NOW).map(i => i.title)).toEqual(["undated"])
  })

  it("isoDate 作为 pubDate 的回退；非法时间按抓取时刻算", () => {
    const items = [
      item("old", "2025-01-01T00:00:00Z"),
      item("atom", undefined, { isoDate: "2026-10-01T00:00:00Z" }),
      item("broken", "not-a-date"),
    ]
    expect(selectNewestItems(items, 1, NOW).map(i => i.title)).toEqual(["broken"])
  })

  it("limit <= 0 视为不截断（调用方传 0 不应清空候选）", () => {
    const items = [item("a", "2026-01-01T00:00:00Z")]
    expect(selectNewestItems(items, 0, NOW)).toBe(items)
  })
})
