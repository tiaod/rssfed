import { describe, expect, it, vi, beforeEach } from "vitest"

/**
 * 零订阅孤儿源的统计与暂停/恢复。
 *
 * 核心不变量（这个文件必须钉住的）：
 *  1. **判定零订阅必须回到权威来源**（用户库里的 `subscription:` 文档），不能只看水位表 ——
 *     休眠账号有订阅但没有水位行；
 *  2. **读用户库失败时整体放弃**，宁可少暂停也不误暂停；
 *  3. **自动恢复只碰 `pausedBySystem = true`**，管理员手动暂停的源不能因为有人订阅就被打开；
 *  4. `bot_feeds` 引用算"有人关注"，不能被当成孤儿。
 */

const state = vi.hoisted(() => ({
  /** 用户库：[{ id, dbName }] */
  users: [] as Array<{ id: string, dbName: string | null }>,
  /** 每个用户库里的订阅 feedId */
  subscriptions: new Map<string, string[]>(),
  /** 读取失败的库 */
  failingDbs: new Set<string>(),
  /** feeds 表全部行 */
  feeds: [] as Array<{
    id: string
    url: string
    title: string
    status: string
    pausedBySystem: boolean | null
    lastFetchedAt: Date | null
  }>,
  /** bot_feeds 引用的 feedId */
  botRefs: [] as string[],
  /** 记录 update().set() 的入参 */
  updates: [] as Array<Record<string, unknown>>,
  /** update 影响的行数（模拟"状态已变"） */
  returnedRows: [] as Array<{ id: string, url?: string }>,
  enqueued: [] as string[],
}))

vi.mock("../db", () => {
  const feeds = { id: "id", url: "url", title: "title", status: "status", pausedBySystem: "paused_by_system", lastFetchedAt: "last_fetched_at" }
  const user = { id: "id", timelineDbName: "timeline_db_name" }
  const botFeeds = { feedId: "feed_id" }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === user) return Promise.resolve(state.users)
          // feeds 的两种查询：全量读（scanOrphanFeeds，直接 await）与
          // 带 where 的过滤读（resumeSubscribedAutoPaused，只取自动暂停的行）。
          // 生产里过滤由 SQL 完成，这里在内存里复现同样的语义。
          const allRows = state.feeds
          const autoPausedRows = () => state.feeds.filter(
            (f) => f.status === "paused" && f.pausedBySystem === true,
          )
          const chain = {
            where: () => Promise.resolve(autoPausedRows()),
            then: (res: (v: unknown) => unknown) => Promise.resolve(allRows).then(res),
          }
          return chain as unknown as Promise<typeof state.feeds>
        },
      }),
      // bot_feeds 引用
      selectDistinct: () => ({
        from: () => Promise.resolve(state.botRefs.map((feedId) => ({ feedId }))),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          state.updates.push(values)
          return {
            where: () => ({
              returning: async () => state.returnedRows,
            }),
          }
        },
      }),
    },
    feeds,
    user,
    botFeeds,
  }
})

vi.mock("../couchdb/client", () => ({
  createCouchDb: (dbName: string) => ({
    list: async () => {
      if (state.failingDbs.has(dbName)) throw new Error("db unavailable")
      const ids = state.subscriptions.get(dbName) ?? []
      return {
        rows: ids.map((feedId) => ({
          id: `subscription:${feedId}`,
          doc: { feedId, type: "subscription" },
        })),
      }
    },
  }),
}))

vi.mock("../workers", () => ({
  enqueueFetch: async (feedId: string) => { state.enqueued.push(feedId) },
}))

const {
  scanOrphanFeeds, pauseOrphanFeeds, resumeIfAutoPaused, resumeSubscribedAutoPaused,
} = await import("../services/feed-orphans")

function feed(id: string, overrides: Partial<(typeof state)["feeds"][number]> = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    status: "active",
    pausedBySystem: null as boolean | null,
    lastFetchedAt: new Date("2026-01-01"),
    ...overrides,
  }
}

beforeEach(() => {
  state.users = []
  state.subscriptions = new Map()
  state.failingDbs = new Set()
  state.feeds = []
  state.botRefs = []
  state.updates = []
  state.returnedRows = []
  state.enqueued = []
})

describe("scanOrphanFeeds", () => {
  it("区分被订阅的源与零订阅孤儿", async () => {
    state.users = [{ id: "u1", dbName: "db_u1" }]
    state.subscriptions = new Map([["db_u1", ["f1"]]])
    state.feeds = [feed("f1"), feed("f2"), feed("f3")]

    const result = await scanOrphanFeeds()

    expect(result.total).toBe(3)
    expect(result.referenced).toBe(1)
    expect(result.orphans.map((o) => o.id).sort()).toEqual(["f2", "f3"])
    expect(result.activeOrphans).toBe(2)
  })

  it("bot_feeds 引用的源不算孤儿", async () => {
    state.users = []
    state.feeds = [feed("f1"), feed("f2")]
    state.botRefs = ["f1"]

    const result = await scanOrphanFeeds()

    expect(result.orphans.map((o) => o.id)).toEqual(["f2"])
  })

  it("用户库读取失败时记 scanFailures（不把它当成没有订阅）", async () => {
    state.users = [{ id: "u1", dbName: "db_bad" }]
    state.failingDbs = new Set(["db_bad"])
    state.feeds = [feed("f1")]

    const result = await scanOrphanFeeds()

    expect(result.scanFailures).toBe(1)
  })

  it("正在抓的孤儿排在前面（那才是真浪费）", async () => {
    state.users = []
    state.feeds = [
      feed("paused_one", { status: "paused", pausedBySystem: true }),
      feed("active_one"),
    ]

    const result = await scanOrphanFeeds()

    expect(result.orphans[0]?.id).toBe("active_one")
    expect(result.alreadyPaused).toBe(1)
  })
})

describe("pauseOrphanFeeds", () => {
  it("暂停零订阅的活跃源，并打上 pausedBySystem 标记", async () => {
    state.users = []
    state.feeds = [feed("f1"), feed("f2")]
    state.returnedRows = [{ id: "f1" }, { id: "f2" }]

    const result = await pauseOrphanFeeds()

    expect(result.paused).toBe(2)
    expect(state.updates).toContainEqual({ status: "paused", pausedBySystem: true })
  })

  it("扫描有失败时整体放弃（不能误暂停别人的源）", async () => {
    state.users = [{ id: "u1", dbName: "db_bad" }]
    state.failingDbs = new Set(["db_bad"])
    state.feeds = [feed("f1")]

    const result = await pauseOrphanFeeds()

    expect(result.aborted).toBe(true)
    expect(result.paused).toBe(0)
    expect(state.updates).toEqual([])
  })

  it("已经是暂停态的不重复处理", async () => {
    state.users = []
    state.feeds = [feed("f1", { status: "paused", pausedBySystem: true })]
    state.returnedRows = []

    const result = await pauseOrphanFeeds()

    expect(result.paused).toBe(0)
  })
})

describe("resumeIfAutoPaused", () => {
  it("自动暂停的源被订阅时恢复并入队", async () => {
    state.returnedRows = [{ id: "f1", url: "https://example.com/f1" }]

    const resumed = await resumeIfAutoPaused("f1")

    expect(resumed).toBe(true)
    expect(state.updates).toContainEqual({ status: "active", pausedBySystem: null, errorMessage: null })
    expect(state.enqueued).toEqual(["f1"])
  })

  it("没有命中（管理员手动暂停的源不会命中）时什么都不做", async () => {
    state.returnedRows = []

    const resumed = await resumeIfAutoPaused("f1")

    expect(resumed).toBe(false)
    expect(state.enqueued).toEqual([])
  })
})

describe("resumeSubscribedAutoPaused", () => {
  it("恢复那些自动暂停、但现在确实有人订阅的源", async () => {
    state.users = [{ id: "u1", dbName: "db_u1" }]
    state.subscriptions = new Map([["db_u1", ["f1"]]])
    state.feeds = [
      feed("f1", { status: "paused", pausedBySystem: true }),
      feed("f2", { status: "paused", pausedBySystem: true }),
    ]
    state.returnedRows = [{ id: "f1" }]

    const n = await resumeSubscribedAutoPaused()

    expect(n).toBe(1)
  })

  it("有人订阅但源是被管理员手动暂停的：不恢复", async () => {
    state.users = [{ id: "u1", dbName: "db_u1" }]
    state.subscriptions = new Map([["db_u1", ["f1"]]])
    // 只有 pausedBySystem=true 的行才会进入候选；这里 f1 是手动暂停的
    state.feeds = [feed("f1", { status: "paused", pausedBySystem: false })]

    const n = await resumeSubscribedAutoPaused()

    expect(n).toBe(0)
    expect(state.updates).toEqual([])
  })

  it("扫描失败时不做任何恢复", async () => {
    state.users = [{ id: "u1", dbName: "db_bad" }]
    state.failingDbs = new Set(["db_bad"])
    state.feeds = [feed("f1", { status: "paused", pausedBySystem: true })]

    const n = await resumeSubscribedAutoPaused()

    expect(n).toBe(0)
  })
})
