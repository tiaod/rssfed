import { describe, it, expect } from "vitest"
import { writeEntries } from "../services/timeline"

/**
 * `writeEntries` 是派生库唯一的写入口。聚合阶段**不再产生附件**（图片在抓取时就按 per-feed
 * 策略压好了，见 rss/entry-images.ts），这里的职责变成「按 _id 回源库取一次含附件的文档 →
 * 原样搬进派生库」，所以必须保证四件事不退化：
 *
 *   1. 写的条数 = 库里还没有的条数（已存在的跳过：既不再取附件，也不重传）；
 *   2. 只对**真正要写**的条目回源库取附件（这是本路径唯一的额外往返）；
 *   3. 附件字节原样搬运（源库的 revpos/digest 等定位元数据不带过去）；
 *   4. 取不到附件时条目照常入库、只是没图，并计入 attachmentFailures。
 *
 * 这里刻意用不碰网络的假源库：真正的图片下载/压缩链路由 entry-images / image-cache
 * 的单测覆盖，本文件只盯写入语义。
 */
function fakeTargetScope(existingIds: string[] = []) {
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

/** 假源库：`get(id, {attachments:true})` 返回预置文档；没预置的抛错（模拟条目被删 / 源库抖动） */
function fakeSourceScope(docsById: Record<string, Record<string, unknown>>) {
  const getCalls: string[] = []
  return {
    scope: {
      get: async (id: string) => {
        getCalls.push(id)
        const doc = docsById[id]
        if (!doc) throw new Error("not_found")
        return structuredClone(doc)
      },
    } as never,
    getCalls,
  }
}

function entryDoc(index: number, attachmentBytes?: string) {
  const id = `entry:feed1:${String(index).padStart(3, "0")}`
  return {
    _id: id,
    _rev: `${index}-rev`,
    _revisions: { start: index, ids: [`${index}-rev`] },
    type: "entry",
    feedId: "feed1",
    title: `条目 ${index}`,
    url: `https://example.invalid/${index}`,
    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    content: `<p>条目 ${index} 的正文，没有图片</p>`,
    ...(attachmentBytes
      ? {
          _attachments: { "img-0.avif": { content_type: "image/avif", data: attachmentBytes, revpos: 2, digest: "md5-x" } },
          images: [{ url: `https://example.invalid/${index}.png`, attachment: "img-0.avif" }],
        }
      : {}),
  }
}

/** 源库 `_changes`/视图给的文档：附件只有 stub、没有 data（所以必须再按 _id 取一次） */
function stubOf(doc: Record<string, unknown>) {
  const { _attachments, ...rest } = doc
  if (!_attachments) return rest
  return {
    ...rest,
    _attachments: Object.fromEntries(
      Object.entries(_attachments as Record<string, { content_type: string }>)
        .map(([name, att]) => [name, { content_type: att.content_type, stub: true, revpos: 2, digest: "md5-x" }]),
    ),
  }
}

describe("writeEntries（派生库写入）", () => {
  it("全部新条目一次 bulk 写完，且顺序与源库一致", async () => {
    const { scope, bulkCalls } = fakeTargetScope()
    const docs = Array.from({ length: 12 }, (_, i) => entryDoc(i))
    const source = fakeSourceScope(Object.fromEntries(docs.map(d => [d._id, d])))

    const outcome = await writeEntries(scope, source.scope, docs.map(stubOf))

    expect(outcome.written).toBe(12)
    expect(outcome.attachmentFailures).toBe(0)
    // 限并发不等于「各写各的」：仍然只提交一次
    expect(bulkCalls).toHaveLength(1)
    expect(bulkCalls[0]!.map(d => d._id)).toEqual(docs.map(d => d._id))
  })

  it("库里已有的条目直接跳过：不取附件、不重传", async () => {
    const docs = Array.from({ length: 5 }, (_, i) => entryDoc(i))
    const { scope, bulkCalls } = fakeTargetScope([docs[1]!._id, docs[3]!._id])
    const source = fakeSourceScope(Object.fromEntries(docs.map(d => [d._id, d])))

    const outcome = await writeEntries(scope, source.scope, docs.map(stubOf))

    expect(outcome.written).toBe(3)
    expect(bulkCalls[0]!.map(d => d._id)).toEqual([docs[0]!._id, docs[2]!._id, docs[4]!._id])
    expect(source.getCalls.sort()).toEqual([docs[0]!._id, docs[2]!._id, docs[4]!._id])
  })

  it("全是已有条目时不提交 bulk，也不回源库取附件", async () => {
    const docs = Array.from({ length: 3 }, (_, i) => entryDoc(i))
    const { scope, bulkCalls } = fakeTargetScope(docs.map(d => d._id))
    const source = fakeSourceScope(Object.fromEntries(docs.map(d => [d._id, d])))

    const outcome = await writeEntries(scope, source.scope, docs.map(stubOf))

    expect(outcome.written).toBe(0)
    expect(bulkCalls).toHaveLength(0)
    expect(source.getCalls).toEqual([])
  })

  it("非 entry 文档（FeedDoc 等）不写进派生库的条目批量里", async () => {
    const { scope, bulkCalls } = fakeTargetScope()
    const doc = entryDoc(0)
    const source = fakeSourceScope({ [doc._id]: doc })

    const outcome = await writeEntries(
      scope,
      source.scope,
      [stubOf(doc), { _id: "feed1", type: "feed", title: "源" }],
    )

    expect(outcome.written).toBe(1)
    expect(bulkCalls[0]).toHaveLength(1)
  })

  it("附件原样搬运：只留 content_type + base64 data，并且带上 images", async () => {
    const { scope, bulkCalls } = fakeTargetScope()
    const doc = entryDoc(0, "AVIFBYTES")
    const source = fakeSourceScope({ [doc._id]: doc })

    const outcome = await writeEntries(scope, source.scope, [stubOf(doc)])

    expect(outcome.written).toBe(1)
    const written = bulkCalls[0]![0]!
    expect(written._attachments).toEqual({
      "img-0.avif": { content_type: "image/avif", data: "AVIFBYTES" },
    })
    expect(written.images).toEqual([{ url: "https://example.invalid/0.png", attachment: "img-0.avif" }])
    // 派生库里是另一份文档：修订信息不能跟着过去
    expect(written._rev).toBeUndefined()
    expect(written._revisions).toBeUndefined()
  })

  it("取不到带附件的源文档：条目照常入库，计入 attachmentFailures 且不带 _attachments", async () => {
    const { scope, bulkCalls } = fakeTargetScope()
    const doc = entryDoc(0, "AVIFBYTES")
    const source = fakeSourceScope({}) // 源库取不到（条目刚好被删 / 源库抖动）

    const outcome = await writeEntries(scope, source.scope, [stubOf(doc)])

    expect(outcome.written).toBe(1)
    expect(outcome.attachmentFailures).toBe(1)
    expect(bulkCalls[0]![0]!._attachments).toBeUndefined()
  })

  it("源条目本来就没有附件时不算失败", async () => {
    const { scope } = fakeTargetScope()
    const doc = entryDoc(0)
    const source = fakeSourceScope({ [doc._id]: doc })

    const outcome = await writeEntries(scope, source.scope, [stubOf(doc)])

    expect(outcome.attachmentFailures).toBe(0)
  })
})
