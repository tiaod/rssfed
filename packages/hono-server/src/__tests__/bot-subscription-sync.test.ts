import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「用户订阅了某个 Bot」的内容搬运。
 *
 * 这是新模型里唯一还需要"从别的库把内容送过来"的路径：用户库与 Bot 库之间没有复制
 * （抓取按 owner 各写各的），而订阅一个 Bot 是用户侧的行为，只能由我们主动搬。
 *
 * 三条不变量：
 *   1. **只搬 `entry:`**（设计文档与 `_local` 不该出现在用户库里）；
 *   2. **已存在就跳过**（重复跑不该重复写 / 重复读附件）；
 *   3. **附件随文档一起搬**（否则用户离线看不到图）。
 */
const state = vi.hoisted(() => ({
  /** Bot 库视图返回的条目 id */
  viewIds: [] as string[],
  /** 用户库里已存在的 id */
  existing: new Set<string>(),
  /** bot 库的文档（get 返回） */
  botDocs: new Map<string, Record<string, unknown>>(),
  /** 写进用户库的记录 */
  inserted: [] as Array<Record<string, unknown>>,
  multipartInserted: [] as Array<Record<string, unknown>>,
  /** purge 请求体 */
  purged: [] as Array<Record<string, string[]>>,
  /** 用户库 list 返回的行（退订清理用） */
  listRows: [] as Array<{ id: string, value: { rev: string } }>,
}))

vi.mock("../couchdb/client", () => ({
  ensureBotDatabase: async (botId: string) => `bot_${botId}`,
  ensureTimelineDatabase: async (userId: string) => `user-timeline_${userId}`,
  createCouchDb: () => ({
    view: async () => ({ rows: state.viewIds.map(id => ({ id })) }),
    fetch: async ({ keys }: { keys: string[] }) => ({
      rows: keys.map((key) => state.existing.has(key)
        ? { key, value: { rev: "1-x" } }
        : { key, error: "not_found" }),
    }),
    get: async (id: string) => {
      const doc = state.botDocs.get(id)
      if (!doc) throw Object.assign(new Error("not found"), { statusCode: 404 })
      return doc
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
    // 真实 CouchDB 在 _purge 之后这些行就不在区间里了：mock 必须照做，
    // 否则清理循环会反复删同一批（实测会数出 2 × 批数）
    list: async () => ({ rows: state.listRows }),
  }),
  nanoServer: {
    request: async (req: { body?: Record<string, string[]> }) => {
      const body = req?.body ?? {}
      state.purged.push(body)
      state.listRows = state.listRows.filter((row) => !(row.id in body))
      return { purged: body }
    },
  },
}))

const { syncBotEntriesToUser, purgeBotFromUser, listBotSubscribers } = await import("../services/bot-subscription-sync")

beforeEach(() => {
  state.viewIds = []
  state.existing.clear()
  state.botDocs.clear()
  state.inserted = []
  state.multipartInserted = []
  state.purged = []
  state.listRows = []
})

describe("syncBotEntriesToUser", () => {
  it("Bot 库没有产出：什么都不写", async () => {
    const result = await syncBotEntriesToUser("b1", "u1")
    expect(result).toEqual({ copied: 0, scanned: 0 })
    expect(state.inserted).toHaveLength(0)
  })

  it("搬新条目：_id 原样写进用户库（`entry:bot:{botId}:{hash}`）", async () => {
    state.viewIds = ["entry:bot:b1:aaa", "entry:bot:b1:bbb"]
    state.botDocs.set("entry:bot:b1:aaa", {
      _id: "entry:bot:b1:aaa", _rev: "1-x", type: "entry", title: "帖子一", publishedAt: "2026-11-01T00:00:00Z",
    })
    state.botDocs.set("entry:bot:b1:bbb", {
      _id: "entry:bot:b1:bbb", _rev: "1-y", type: "entry", title: "帖子二", publishedAt: "2026-11-02T00:00:00Z",
    })

    const result = await syncBotEntriesToUser("b1", "u1")

    expect(result).toEqual({ copied: 2, scanned: 2 })
    expect(state.inserted.map(d => d._id)).toEqual(["entry:bot:b1:aaa", "entry:bot:b1:bbb"])
    // `_rev` 不能带过去：用户库里这是新文档，不是修订谱系的一部分
    expect(state.inserted[0]).not.toHaveProperty("_rev")
  })

  it("已存在的条目跳过：不重读正文、不重写（幂等）", async () => {
    state.viewIds = ["entry:bot:b1:aaa", "entry:bot:b1:bbb"]
    state.existing.add("entry:bot:b1:aaa")
    state.botDocs.set("entry:bot:b1:bbb", { _id: "entry:bot:b1:bbb", type: "entry", title: "新" })

    const result = await syncBotEntriesToUser("b1", "u1")

    expect(result.copied).toBe(1)
    expect(state.inserted.map(d => d._id)).toEqual(["entry:bot:b1:bbb"])
  })

  it("带附件的条目走 multipart（离线也要能看图）", async () => {
    state.viewIds = ["entry:bot:b1:withimg"]
    state.botDocs.set("entry:bot:b1:withimg", {
      _id: "entry:bot:b1:withimg",
      _rev: "1-z",
      type: "entry",
      title: "带图",
      _attachments: {
        "img-0.avif": { data: Buffer.from("fake-avif").toString("base64"), content_type: "image/avif" },
      },
    })

    const result = await syncBotEntriesToUser("b1", "u1")

    expect(result.copied).toBe(1)
    expect(state.inserted).toHaveLength(0)
    expect(state.multipartInserted).toHaveLength(1)
    expect(state.multipartInserted[0]).toMatchObject({ _id: "entry:bot:b1:withimg" })
    expect(state.multipartInserted[0]).not.toHaveProperty("_attachments")
  })

  it("单条失败不拦下其余（下一轮会补）", async () => {
    state.viewIds = ["entry:bot:b1:bad", "entry:bot:b1:good"]
    state.botDocs.set("entry:bot:b1:good", { _id: "entry:bot:b1:good", type: "entry", title: "好的" })
    // bad 没放进 botDocs → get 抛 404

    const result = await syncBotEntriesToUser("b1", "u1")
    expect(result.copied).toBe(1)
    expect(result.scanned).toBe(2)
  })

  it("非 entry: 开头的文档不搬（设计文档 / 内部状态）", async () => {
    state.viewIds = ["_design/main", "entry:bot:b1:aaa"]
    state.botDocs.set("entry:bot:b1:aaa", { _id: "entry:bot:b1:aaa", type: "entry", title: "x" })

    await syncBotEntriesToUser("b1", "u1")
    expect(state.inserted.map(d => d._id)).toEqual(["entry:bot:b1:aaa"])
  })
})

describe("purgeBotFromUser", () => {
  it("按 `entry:bot:{botId}:` 前缀清掉（用 _purge，不留墓碑）", async () => {
    state.listRows = [
      { id: "entry:bot:b1:aaa", value: { rev: "1-a" } },
      { id: "entry:bot:b1:bbb", value: { rev: "1-b" } },
    ]

    const deleted = await purgeBotFromUser("b1", "u1")

    expect(deleted).toBe(2)
    expect(state.purged).toHaveLength(1)
    expect(Object.keys(state.purged[0]!)).toEqual(["entry:bot:b1:aaa", "entry:bot:b1:bbb"])
  })

  it("没有条目时返回 0（幂等）", async () => {
    state.listRows = []
    expect(await purgeBotFromUser("b1", "u1")).toBe(0)
    expect(state.purged).toHaveLength(0)
  })
})

describe("listBotSubscribers", () => {
  it("只认 kind === 'bot' 的订阅文档（防历史脏文档）", async () => {
    // createCouchDb 的 get 走 botDocs：借用它当"用户库里的订阅文档"
    state.botDocs.set("subscription:bot:b1", { _id: "subscription:bot:b1", kind: "bot" })

    const users = [
      { id: "u1", dbName: "user-timeline_u1" },
      { id: "u2", dbName: "user-timeline_u2" },
      { id: "u3", dbName: null },
    ]
    const hits = await listBotSubscribers("b1", users)

    // 三个用户的 get 都打到同一个 mock，所以都能读到这份文档 —— 这里验的是"没有库名的被跳过"
    expect(hits).toContain("u1")
    expect(hits).toContain("u2")
    expect(hits).not.toContain("u3")
  })

  it("订阅文档不是 bot 类型时不认（比如同名 RSS 订阅）", async () => {
    state.botDocs.set("subscription:bot:b1", { _id: "subscription:bot:b1", kind: "feed" })
    const hits = await listBotSubscribers("b1", [{ id: "u1", dbName: "user-timeline_u1" }])
    expect(hits).toEqual([])
  })
})
