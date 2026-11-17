import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `DELETE /api/feeds/:feedId` 的契约。
 *
 * 删除是破坏性且跨多存储的（注册表、水位、bot 引用、用户库订阅/条目/FeedDoc、源库），
 * 这里钉住最容易出错的几条：
 *  1. **订阅者守卫**：还有人订阅时拒绝，并把订阅者列出来；
 *  2. `?force=1` 才越过守卫；
 *  3. 守卫查的是**权威来源**——水位表为空时必须回落到用户库的 `subscription:` 文档
 *     （休眠账号在暂停期间能订阅但不会建水位行，只查水位表会误判成"没人订阅"）；
 *  4. 清理顺序：注册表行最后删。
 */

const state = vi.hoisted(() => ({
  session: { user: { id: "admin1", role: "admin" } } as { user: { id: string, role: string } } | null,
  /** feeds 表里那一行（null = 不存在） */
  feed: { id: "f1", url: "https://example.com/rss", title: "测试源" } as { id: string, url: string, title: string } | null,
  /** 水位表行 */
  watermarks: [] as Array<{ userId: string }>,
  /** bot_feeds join 结果 */
  botRefs: [] as Array<{ userId: string }>,
  /** 用户库里的 subscription 文档（慢路径用） */
  subscriptionDocs: new Map<string, Set<string>>(),
  /** 所有用户库 */
  users: [] as Array<{ id: string, dbName: string, email: string }>,
  /** 调用顺序日志 */
  calls: [] as string[],
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

vi.mock("../db", () => {
  const feeds = { id: "id", url: "url", title: "title", couchDbName: "couch_db_name" }
  const timelineSourceSync = { sourceId: "source_id", userId: "user_id" }
  const botFeeds = { feedId: "feed_id", botId: "bot_id" }
  const bots = { id: "id", userId: "user_id" }
  const user = { id: "id", email: "email", timelineDbName: "timeline_db_name" }

  /** 模拟 drizzle 的链式查询：where() 既可直接 await，也可继续 .limit() / .innerJoin() */
  const chain = (rows: unknown[] | (() => unknown[])) => {
    const resolveRows = () => (typeof rows === "function" ? rows() : rows)
    const obj: Record<string, unknown> = {}
    obj.where = () => obj
    obj.limit = async () => resolveRows()
    obj.innerJoin = () => obj
    obj.orderBy = () => obj
    // 直接 await 也能拿到结果
    obj.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolveRows()).then(res, rej)
    obj.catch = (rej: (e: unknown) => unknown) => Promise.resolve(resolveRows()).catch(rej)
    return obj
  }

  const selectChain = (cols: Record<string, unknown>) => ({
    // 按**表对象**识别，而不是按列名 —— 水位表与 bot 引用都只 select userId，列名分不开
    from: (table: unknown) => {
      if (table === timelineSourceSync) return chain(() => state.watermarks)
      if (table === botFeeds) return chain(() => state.botRefs)
      if (table === user) return chain(() => state.users)
      if (table === feeds) return chain(() => (state.feed ? [{ ...state.feed, couchDbName: "feed_x" }] : []))
      return chain(() => [])
    },
  })

  return {
    db: {
      select: (cols: Record<string, unknown> = {}) => selectChain(cols),
      delete: (table: unknown) => ({
        where: async () => {
          if (table === feeds) state.calls.push("delete:feeds")
          else if (table === timelineSourceSync) state.calls.push("delete:watermarks")
          else if (table === botFeeds) state.calls.push("delete:bot_feeds")
          return []
        },
      }),
    },
    feeds,
    bots,
    botFeeds,
    timelineSourceSync,
    user,
  }
})

vi.mock("../couchdb/client", () => ({
  createCouchDb: (dbName: string) => ({
    get: async (id: string) => {
      if (id.startsWith("subscription:")) {
        const feedId = id.slice("subscription:".length)
        if (state.subscriptionDocs.get(dbName)?.has(feedId)) {
          return { _id: id, _rev: "1-x", feedId }
        }
        throw Object.assign(new Error("not found"), { statusCode: 404 })
      }
      throw Object.assign(new Error("not found"), { statusCode: 404 })
    },
    destroy: async (id: string) => { state.calls.push(`destroy:${dbName}:${id}`) },
    list: async () => ({ rows: [] }),
  }),
  ensureTimelineDatabase: async (userId: string) => `db_${userId}`,
  nanoServer: {
    db: { destroy: async (name: string) => { state.calls.push(`destroy-db:${name}`) } },
  },
}))

vi.mock("../couchdb/retention", () => ({
  buildPurgeBody: (docs: Array<{ _id: string, _rev: string }>) => Object.fromEntries(docs.map((d) => [d._id, [d._rev]])),
  countPurged: () => 0,
  purgeRequest: async () => ({}),
}))

vi.mock("../services/timeline", () => ({
  entryIdPrefix: (feedId: string) => `entry:${feedId}:`,
}))

vi.mock("../workers", () => ({
  enqueueFetch: async () => {},
  fetchQueue: { getJob: async () => null },
}))

const { feedsRouter } = await import("../routes/feeds")
const app = new Hono().route("/api/feeds", feedsRouter)

function del(feedId = "f1", query = "") {
  return app.request(`/api/feeds/${feedId}${query}`, { method: "DELETE" })
}

beforeEach(() => {
  state.session = { user: { id: "admin1", role: "admin" } }
  state.feed = { id: "f1", url: "https://example.com/rss", title: "测试源" }
  state.watermarks = []
  state.botRefs = []
  state.subscriptionDocs = new Map()
  state.users = []
  state.calls = []
})

describe("DELETE /api/feeds/:feedId", () => {
  it("有订阅者时拒绝，并列出订阅者", async () => {
    state.watermarks = [{ userId: "u1" }]

    const res = await del()

    expect(res.status).toBe(409)
    const body = await res.json() as { code: string, subscribers: Array<{ userId: string }> }
    expect(body.code).toBe("feed_has_subscribers")
    expect(body.subscribers.map((s) => s.userId)).toEqual(["u1"])
    // 拒绝时一个字都不许删
    expect(state.calls.filter((c) => c.startsWith("delete:") || c.startsWith("destroy"))).toEqual([])
  })

  it("?force=1 时越过守卫并执行删除", async () => {
    state.watermarks = [{ userId: "u1" }]

    const res = await del("f1", "?force=1")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: true, forced: true })
    expect(state.calls).toContain("delete:feeds")
  })

  it("没有订阅者时直接删除，注册表行最后删", async () => {
    const res = await del()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: true, forced: false })
    if (state.feed && "couch_db_name" in state.feed) { /* 无 couchDbName 场景 */ }
    // 注册表行必须是最后一个被删的：先删它，用户侧清理就失去依据
    expect(state.calls[state.calls.length - 1]).toBe("delete:feeds")
  })

  it("水位表为空时回落用户库确认订阅者（休眠账号没有水位行）", async () => {
    // 模拟：用户库里有 subscription 文档，但水位表为空 —— 这正是一条容易被误删的情况
    state.watermarks = []
    state.users = [{ id: "u1", dbName: "db_u1", email: "u1@example.com" }]
    state.subscriptionDocs = new Map([["db_u1", new Set(["f1"])]])

    const res = await del()

    expect(res.status).toBe(409)
    const body = await res.json() as { subscribers: Array<{ userId: string }> }
    expect(body.subscribers.map((s) => s.userId)).toEqual(["u1"])
  })

  it("源不存在时 404", async () => {
    state.feed = null

    const res = await del()

    expect(res.status).toBe(404)
  })

  it("非管理员被拒", async () => {
    state.session = { user: { id: "u1", role: "user" } }

    const res = await del()

    expect(res.status).toBe(403)
  })
})
