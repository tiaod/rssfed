import { describe, expect, it } from "vitest"
import {
  chunkArray,
  computeTombstoneCutoff,
  deletedTombstoneCandidates,
  selectPurgeable,
} from "../couchdb/tombstone-gc"

describe("computeTombstoneCutoff", () => {
  it("没有活跃订阅者 → 全部可清", () => {
    expect(computeTombstoneCutoff([], 60_000)).toEqual({ mode: "all" })
  })

  it("订阅者还没成功同步过 → 挡住（不能清）", () => {
    const cutoff = computeTombstoneCutoff([{ syncedAt: null, status: "idle" }], 0)
    expect(cutoff.mode).toBe("blocked")
  })

  it("上一次同步失败/进行中 → 挡住", () => {
    expect(computeTombstoneCutoff([{ syncedAt: new Date("2026-10-19T03:00:00Z"), status: "error" }], 0).mode)
      .toBe("blocked")
    expect(computeTombstoneCutoff([{ syncedAt: new Date("2026-10-19T03:00:00Z"), status: "syncing" }], 0).mode)
      .toBe("blocked")
    // 只要有一个订阅者不满足就整体挡住（保守）
    expect(computeTombstoneCutoff([
      { syncedAt: new Date("2026-10-19T03:00:00Z"), status: "idle" },
      { syncedAt: null, status: "idle" },
    ], 0).mode).toBe("blocked")
  })

  it("取所有订阅者里最旧的成功同步时刻，再减掉 grace", () => {
    const cutoff = computeTombstoneCutoff([
      { syncedAt: new Date("2026-10-19T03:00:00Z"), status: "idle" },
      { syncedAt: new Date("2026-10-19T02:00:00Z"), status: "idle" },
    ], 60_000)
    expect(cutoff).toEqual({ mode: "before", before: new Date("2026-10-19T01:59:00Z") })
  })
})

describe("selectPurgeable", () => {
  const rows = [
    { docId: "old", firstSeenAt: new Date("2026-10-19T01:00:00Z") },
    { docId: "new", firstSeenAt: new Date("2026-10-19T03:00:00Z") },
  ]

  it("all = 全部", () => {
    expect(selectPurgeable(rows, { mode: "all" })).toHaveLength(2)
  })

  it("blocked = 一条都不清", () => {
    expect(selectPurgeable(rows, { mode: "blocked", reason: "x" })).toEqual([])
  })

  it("before = 只清严格早于边界的（边界本身不清）", () => {
    expect(selectPurgeable(rows, { mode: "before", before: new Date("2026-10-19T03:00:00Z") }))
      .toEqual([rows[0]])
  })
})

describe("deletedTombstoneCandidates", () => {
  it("只挑单叶、entry: 前缀的删除", () => {
    const candidates = deletedTombstoneCandidates([
      { id: "entry:feed:1", deleted: true, changes: [{ rev: "2-a" }] },
      { id: "entry:feed:2", deleted: false, changes: [{ rev: "1-b" }] },          // 活文档
      { id: "feed:x", deleted: true, changes: [{ rev: "2-c" }] },                  // FeedDoc
      { id: "_design/main", deleted: true, changes: [{ rev: "2-d" }] },            // 设计文档
      { id: "entry:feed:3", deleted: true, changes: [{ rev: "2-e" }, { rev: "2-f" }] }, // 冲突多叶
      { id: "entry:feed:4", deleted: true, changes: [] },                          // 没 rev
    ])
    expect(candidates).toEqual([{ docId: "entry:feed:1", rev: "2-a" }])
  })
})

describe("chunkArray", () => {
  it("按 size 切块，最后一块可以不满", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkArray([], 2)).toEqual([])
  })

  it("非法 size 直接报错（避免无限循环）", () => {
    expect(() => chunkArray([1], 0)).toThrow()
    expect(() => chunkArray([1], -1)).toThrow()
  })
})
