import { describe, it, expect } from "vitest"
import { writeEntries, DEFAULT_TIMELINE_SETTINGS } from "../services/timeline"

/**
 * `writeEntries` 是派生库唯一的写入口，条目之间限并发（ENTRY_WRITE_CONCURRENCY）之后
 * 必须保证三件事不退化：
 *
 *   1. 写的条数 = 库里还没有的条数（已存在的跳过，不重传附件）；
 *   2. 写入顺序与源库一致（派生库的 map view 靠 publishedAt 排序，但同秒条目要稳定）；
 *   3. 一次 `bulk` 提交，不要变成「并发各写各的」把请求数放大。
 *
 * 这里刻意用**没有正文图**的条目：图片那条链路由 entry-images / image-cache 的单测覆盖，
 * 本文件只盯并发改造后的写入语义，跑起来不碰网络。
 */
function fakeScope(existingIds: string[] = []) {
  const bulkCalls: Array<Array<Record<string, unknown>>> = []
  const existing = new Set(existingIds)
  const scope = {
    fetch: async ({ keys }: { keys: string[] }) => ({
      rows: keys.map(id => (existing.has(id) ? { id, value: { rev: "1-x" } } : { id, error: "not_found" })),
    }),
    bulk: async ({ docs }: { docs: Array<Record<string, unknown>> }) => {
      bulkCalls.push(docs)
      return docs.map(() => ({ ok: true }))
    },
  }
  return { scope: scope as never, bulkCalls }
}

function entryDoc(index: number) {
  return {
    _id: `entry:feed1:${String(index).padStart(3, "0")}`,
    type: "entry",
    feedId: "feed1",
    title: `条目 ${index}`,
    url: `https://example.invalid/${index}`,
    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    content: `<p>条目 ${index} 的正文，没有图片</p>`,
  }
}

describe("writeEntries（派生库写入）", () => {
  it("全部新条目一次 bulk 写完，且顺序与源库一致", async () => {
    const { scope, bulkCalls } = fakeScope()
    const docs = Array.from({ length: 12 }, (_, i) => entryDoc(i))

    const outcome = await writeEntries(scope, docs, DEFAULT_TIMELINE_SETTINGS)

    expect(outcome.written).toBe(12)
    expect(outcome.imageFailures).toBe(0)
    // 限并发不等于「各写各的」：仍然只提交一次
    expect(bulkCalls).toHaveLength(1)
    expect(bulkCalls[0]!.map(d => d._id)).toEqual(docs.map(d => d._id))
  })

  it("库里已有的条目直接跳过（不重传附件）", async () => {
    const docs = Array.from({ length: 5 }, (_, i) => entryDoc(i))
    const { scope, bulkCalls } = fakeScope([docs[1]!._id, docs[3]!._id])

    const outcome = await writeEntries(scope, docs, DEFAULT_TIMELINE_SETTINGS)

    expect(outcome.written).toBe(3)
    expect(bulkCalls[0]!.map(d => d._id)).toEqual([docs[0]!._id, docs[2]!._id, docs[4]!._id])
  })

  it("全是已有条目时不提交 bulk，也不产生附件开销", async () => {
    const docs = Array.from({ length: 3 }, (_, i) => entryDoc(i))
    const { scope, bulkCalls } = fakeScope(docs.map(d => d._id))

    const outcome = await writeEntries(scope, docs, DEFAULT_TIMELINE_SETTINGS)

    expect(outcome.written).toBe(0)
    expect(bulkCalls).toHaveLength(0)
  })

  it("非 entry 文档（FeedDoc 等）不写进派生库的条目批量里", async () => {
    const { scope, bulkCalls } = fakeScope()
    const docs = [entryDoc(0), { _id: "feed1", type: "feed", title: "源" }]

    const outcome = await writeEntries(scope, docs, DEFAULT_TIMELINE_SETTINGS)

    expect(outcome.written).toBe(1)
    expect(bulkCalls[0]).toHaveLength(1)
  })
})
