import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 按 owner 抓取并直接写 owner 自己的库。
 *
 * 这是新模型的写入核心，测的是三条"错了就丢数据"的不变量：
 *   1. **暂停/脏文档不写库**（写了就是复活已退订的内容）；
 *   2. **只写真正新增的条目**（判别存在时漏判 → 409 冲突或重复写）；
 *   3. **写完顺手裁到 N 条**（不裁就是库只增不减）。
 */
const state = vi.hoisted(() => ({
  // 已存在的文档 id（`_all_docs?keys=` 的结果来源）
  existing: new Set<string>(),
  tombstoned: new Set<string>(),
  // 写库记录
  inserted: [] as Array<Record<string, unknown>>,
  multipartInserted: [] as Array<Record<string, unknown>>,
  // 视图行（裁剪用：按 [feedId, publishedAt] 升序返回该源全部条目）
  viewRows: [] as Array<{ id: string, doc: { _id: string, _rev: string } }>,
  // purge 记录
  purged: [] as Array<Record<string, string[]>>,
  // feed 正文
  content: "",
  fromCache: false,
  // feedDoc 读取结果
  feedDoc: null as Record<string, unknown> | null,
}))

vi.mock("../couchdb/client", () => ({
  // retention.purgeRequest 会动态 import 本模块取 nanoServer。
  // 返回 { purged: body } —— 与 CouchDB 的响应同形（每个请求的 rev 都被"清掉了"），
  // 这样 countPurged 才数得出来；返回空对象会被当成"一条都没清掉"，裁减少于预期。
  nanoServer: {
    request: async (req: { body?: Record<string, string[]> }) => {
      const body = req?.body ?? {}
      state.purged.push(body)
      // 真实 CouchDB 在 _purge 之后这些行就从视图里消失了：mock 必须照做，
      // 否则裁剪循环会反复删同一批（实测会数出 3 × 批数）
      state.viewRows = state.viewRows.filter((row) => !(row.id in body))
      return { purged: body }
    },
  },
  createCouchDb: () => ({
    fetch: async ({ keys }: { keys: string[] }) => ({
      rows: keys.map((key) => {
        if (state.existing.has(key)) return { key, value: { rev: "1-x" } }
        if (state.tombstoned.has(key)) return { key, value: { rev: "1-x", deleted: true } }
        return { key, error: "not_found" }
      }),
    }),
    get: async () => {
      if (state.feedDoc) return state.feedDoc
      throw Object.assign(new Error("not found"), { statusCode: 404 })
    },
    insert: async (doc: Record<string, unknown>) => {
      state.inserted.push(doc)
      return { ok: true }
    },
    multipart: {
      insert: async (doc: Record<string, unknown>) => {
        state.multipartInserted.push(doc)
        return { ok: true }
      },
    },
    view: async (_design: string, _view: string, params: Record<string, unknown>) => {
      // 裁剪走的是 startkey/endkey 区间查询；descending 时反过来
      const rows = state.viewRows
      return { rows: params.descending ? [...rows].reverse() : rows }
    },
  }),
  ensureTimelineDatabase: async (userId: string) => `user-timeline_${userId}`,
  ensureBotDatabase: async (botId: string) => `bot_${botId}`,
}))

// 裁剪走 `_purge`：真实实现会动态 import client 拿 nanoServer，所以这里把整个函数换掉，
// 只记录"哪些 id 被要求清掉"（这才是用例要钉的语义）
vi.mock("../couchdb/retention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../couchdb/retention")>()
  return {
    ...actual,
    purgeRequest: async (_dbName: string, body: Record<string, string[]>) => {
      state.purged.push(body)
      return body
    },
  }
})

vi.mock("../rss/fetch-cache", () => ({
  getFeedContent: async () => ({ content: state.content, meta: {}, fromCache: state.fromCache }),
}))

vi.mock("../rss/entry-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rss/entry-images")>()
  return {
    ...actual,
    cacheEntryImages: async () => ({ attachments: [], images: [] }),
    cacheSingleImage: async () => null,
  }
})

const { fetchOwnerFeed, normalizeRetention } = await import("../services/owner-fetch")
const { deriveFeedId } = await import("../couchdb/subscription-doc")

const URL = "https://example.com/feed.xml"
const FEED_ID = deriveFeedId(URL)

function rss(items: Array<{ title: string, link: string, pubDate?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>示例源</title>${
    items.map((item) => `<item><title>${item.title}</title><link>${item.link}</link>`
      + `${item.pubDate ? `<pubDate>${item.pubDate}</pubDate>` : ""}</item>`).join("")
  }</channel></rss>`
}

const TWO_ITEMS = rss([
  { title: "第一篇", link: "https://example.com/1", pubDate: "Mon, 20 Oct 2025 10:00:00 GMT" },
  { title: "第二篇", link: "https://example.com/2", pubDate: "Tue, 21 Oct 2025 10:00:00 GMT" },
])

beforeEach(() => {
  state.existing.clear()
  state.tombstoned.clear()
  state.inserted = []
  state.multipartInserted = []
  state.viewRows = []
  state.purged = []
  state.content = TWO_ITEMS
  state.fromCache = false
  state.feedDoc = null
})

describe("fetchOwnerFeed：跳过路径", () => {
  it("暂停的订阅：不抓、不读库、不写", async () => {
    const result = await fetchOwnerFeed({
      owner: { kind: "user", id: "u1" },
      feedId: FEED_ID,
      url: URL,
      paused: true,
    })
    expect(result.skipped).toBe("paused")
    expect(result.newEntries).toBe(0)
    expect(state.inserted).toHaveLength(0)
  })

  it("feedId 与 url 不匹配：拒绝写入（否则条目会以错误的 id 前缀落库）", async () => {
    const result = await fetchOwnerFeed({
      owner: { kind: "user", id: "u1" },
      feedId: deriveFeedId("https://other.test/feed"),
      url: URL,
    })
    expect(result.skipped).toBe("feed-id-mismatch")
    expect(state.inserted).toHaveLength(0)
  })
})

describe("fetchOwnerFeed：正常写入", () => {
  it("首次抓取：写 FeedDoc + 两条条目", async () => {
    const result = await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })

    expect(result.newEntries).toBe(2)
    expect(result.networkFetch).toBe(true)
    // 一条 FeedDoc + 两个条目
    const types = state.inserted.map((doc) => doc.type)
    expect(types.filter((t) => t === "feed")).toHaveLength(1)
    expect(types.filter((t) => t === "entry")).toHaveLength(2)
  })

  it("条目 doc id 用 `entry:{feedId}:{hash}`，同一 owner 重跑命中「已存在」不再写", async () => {
    const first = await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })
    expect(first.newEntries).toBe(2)

    // 把刚写的条目当作"已存在"
    for (const doc of state.inserted) {
      if (doc.type === "entry") state.existing.add(doc._id as string)
    }
    state.inserted = []
    state.feedDoc = state.inserted.find((doc) => doc.type === "feed") as Record<string, unknown> ?? { type: "feed", title: "示例源", url: URL }

    const second = await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })
    expect(second.newEntries).toBe(0)
    expect(state.inserted.filter((doc) => doc.type === "entry")).toHaveLength(0)
  })

  it("墓碑的条目不会被写回（那是被保留策略裁掉的老条目，写回就是复活）", async () => {
    // 先算出两条会生成的 id，再全部标成墓碑
    await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })
    const entryIds = state.inserted.filter((doc) => doc.type === "entry").map((doc) => doc._id as string)
    state.tombstoned = new Set(entryIds)
    state.inserted = []

    const result = await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })
    expect(result.newEntries).toBe(0)
    expect(state.inserted.filter((doc) => doc.type === "entry")).toHaveLength(0)
  })

  it("只处理保留窗口内的最新 N 条（超出的下一刻就会被裁掉，先写纯属写放大）", async () => {
    const many = rss(Array.from({ length: 10 }, (_, i) => ({
      title: `第 ${i} 篇`,
      link: `https://example.com/${i}`,
      pubDate: new Date(Date.UTC(2025, 9, i + 1)).toUTCString(),
    })))
    state.content = many

    const result = await fetchOwnerFeed({
      owner: { kind: "user", id: "u1" },
      feedId: FEED_ID,
      url: URL,
      retentionEntries: 3,
    })
    expect(result.newEntries).toBe(3)
  })

  it("Bot 作为 owner 时写 bot 库（与用户库互不相干）", async () => {
    const result = await fetchOwnerFeed({ owner: { kind: "bot", id: "b1" }, feedId: FEED_ID, url: URL })
    expect(result.newEntries).toBe(2)
    expect(result.owner).toEqual({ kind: "bot", id: "b1" })
  })
})

describe("fetchOwnerFeed：裁剪", () => {
  it("库里有 5 条、N=2 时裁掉 3 条（用 _purge，不留墓碑）", async () => {
    state.viewRows = Array.from({ length: 5 }, (_, i) => ({
      id: `entry:${FEED_ID}:${i}`,
      doc: { _id: `entry:${FEED_ID}:${i}`, _rev: `${i + 1}-x` },
    }))

    const result = await fetchOwnerFeed({
      owner: { kind: "user", id: "u1" },
      feedId: FEED_ID,
      url: URL,
      retentionEntries: 2,
    })

    expect(result.trimmed).toBe(3)
    // 裁的是最旧的 3 条（视图升序 = 最旧在前）
    expect(state.purged).toHaveLength(1)
    expect(Object.keys(state.purged[0]!)).toEqual([
      `entry:${FEED_ID}:0`,
      `entry:${FEED_ID}:1`,
      `entry:${FEED_ID}:2`,
    ])
  })

  it("没超限时一条都不删", async () => {
    state.viewRows = [{ id: "entry:x:1", doc: { _id: "entry:x:1", _rev: "1-x" } }]
    const result = await fetchOwnerFeed({
      owner: { kind: "user", id: "u1" },
      feedId: FEED_ID,
      url: URL,
      retentionEntries: 50,
    })
    expect(result.trimmed).toBe(0)
    expect(state.purged).toHaveLength(0)
  })
})

describe("fetchOwnerFeed：内容没变", () => {
  it("命中缓存且没有新条目、展示字段也没变 → notModified（不产生任何写入）", async () => {
    state.fromCache = true
    state.feedDoc = {
      _id: FEED_ID,
      _rev: "1-x",
      type: "feed",
      url: URL,
      title: "示例源",
    }
    // 两个条目都已在库里
    await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })
    for (const doc of state.inserted) {
      if (doc.type === "entry") state.existing.add(doc._id as string)
    }
    state.inserted = []

    const result = await fetchOwnerFeed({ owner: { kind: "user", id: "u1" }, feedId: FEED_ID, url: URL })
    expect(result.notModified).toBe(true)
    expect(result.newEntries).toBe(0)
    expect(result.networkFetch).toBe(false)
  })
})

describe("normalizeRetention", () => {
  it("缺省/非法值回退全局默认（50），否则取整", () => {
    expect(normalizeRetention(undefined)).toBe(50)
    expect(normalizeRetention(null)).toBe(50)
    expect(normalizeRetention(0)).toBe(50)
    expect(normalizeRetention(-5)).toBe(50)
    expect(normalizeRetention(Number.NaN)).toBe(50)
    expect(normalizeRetention(10)).toBe(10)
    expect(normalizeRetention(10.7)).toBe(10)
  })
})
