import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 聚合库的「重建 / 升级 / 稳态」：换一个空库重新从源库搬一遍，用户状态跟着走。
 *
 * 合并成单库之后，聚合库里的文档分两类：
 *   - 服务端写：`entry:*` 与 **裸源 id** 的 FeedDoc 副本（复制器会重搬，重建时不用管）
 *   - 客户端写：`subscription:`、`entry-state:`、`group-pref:`（用户意图，丢不得）
 *
 * 三条不变量在这里钉死：
 *   ① 重建**不丢用户状态**（订阅、已读收藏要搬到新库；丢了就是「重建一次，订阅全没了」）；
 *   ② 重建必须**换库**而不是就地清空 —— 复制是变更投递不是投影，目标端自己删过的 rev
 *      复制器不会再送（实测），就地清空等于永久丢内容；换库连 checkpoint（在库的 `_local` 里）
 *      一起清掉，新的一次性复制才会从 0 扫源库；
 *   ③ reconcile **只判定"哪些源脏了"**（返回 dirtySources），搬运本身由 rss-timeline-sync
 *      队列限并发地跑（见 timeline-source-sync.test.ts 与 workers/timeline-sync.ts）。
 *
 * FeedDoc 副本用的是**裸源 id**（与源库同 id），不是 `feed:` 前缀 —— 这是从真实用户库里核对过的
 * 事实。
 */
const mocks = vi.hoisted(() => ({
  /** 当前用户的聚合库名（换库后会被 createTimelineDatabase 改写） */
  userDbName: "user-timeline_old",
  /** 旧库里已有的文档（换库重搬时按页读出来） */
  oldDocs: [] as Array<Record<string, unknown>>,
  /** 每个库收到的 bulk 文档（按库名分组） */
  bulkByDb: {} as Record<string, Array<Record<string, unknown>>>,
  /** 每个库被 destroy 的文档 id */
  destroyedByDb: {} as Record<string, string[]>,
  /** 每个库的状态文档（`_local/state`） */
  stateByDb: {} as Record<string, Record<string, unknown> | undefined>,
  /** 每个库按前缀预置的行（退订删除 / 剪枝用） */
  rowsByRange: {} as Record<string, Array<{ id: string, value: { rev: string } }>>,
  subscriptions: [] as Array<{ feedId: string }>,
  settingsWindowDays: 3,
  /** PG 里的同步水位行（`timeline_source_sync` 的 select 结果） */
  watermarks: [] as Array<Record<string, unknown>>,
  /** `feeds` / `bots` 的 lastNewEntryAt（喂给脏源判定） */
  feedFreshness: [] as Array<{ id: string, at: Date | null }>,
  botFreshness: [] as Array<{ id: string, at: Date | null }>,
  /** 遗留常驻复制任务的清理调用（每个用户一次） */
  purgeCalls: [] as string[],
  legacyPurgeCount: 0,
  /** 水位行被清理的次数（退订 / 换库作废） */
  watermarkDeleteCalls: 0,
  createdTimelines: 0,
  destroyedDbs: [] as string[],
  viewCalls: [] as Array<Record<string, unknown>>,
  /** 剪枝视图不可用（设计文档没装上 / JS 查询服务卡死）：view() 直接抛 */
  viewThrows: false,
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { destroy: async (name: string) => { mocks.destroyedDbs.push(name) } },
    use: () => ({}),
    request: async () => ({}),
  }),
}))

/** 极简的 drizzle 链式 mock：`select().from(表)` 按表名给行，写操作只记次数 */
vi.mock("../db", () => {
  const table = (name: string, extra: Record<string, unknown> = {}) => ({ __name: name, ...extra })
  const rowsFor = (name: string): unknown[] => {
    switch (name) {
      case "userTimelineSettings":
        return [{ windowDays: mocks.settingsWindowDays, aiSummaryEnabled: false }]
      case "timelineSourceSync":
        return mocks.watermarks
      case "feeds":
        return mocks.feedFreshness
      case "bots":
        return mocks.botFreshness
      default:
        return []
    }
  }
  return {
    db: {
      select: () => ({
        from: (t: { __name?: string }) => {
          const chain = {
            where: () => chain,
            limit: async () => rowsFor(t?.__name ?? ""),
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(rowsFor(t?.__name ?? "")).then(resolve),
          }
          return chain
        },
      }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
      delete: () => ({
        where: async () => {
          mocks.watermarkDeleteCalls += 1
          return []
        },
      }),
      query: { user: { findFirst: async () => ({ timelineDbName: mocks.userDbName }) } },
    },
    user: table("user", { id: "user.id", timelineDbName: "user.timeline_db_name" }),
    userTimelineSettings: table("userTimelineSettings", {
      userId: "user_id",
      windowDays: "window_days",
      aiSummaryEnabled: "ai_summary_enabled",
    }),
    timelineSourceSync: table("timelineSourceSync", {
      userId: "user_id",
      sourceId: "source_id",
      windowDays: "window_days",
      boundIso: "bound_iso",
      syncedAt: "synced_at",
      status: "status",
      sourceSeq: "source_seq",
      lastError: "last_error",
    }),
    feeds: table("feeds", { id: "id", lastNewEntryAt: "last_new_entry_at" }),
    bots: table("bots", { id: "id", lastNewEntryAt: "last_new_entry_at" }),
  }
})

vi.mock("../couchdb/client", () => ({
  ensureTimelineDatabase: async () => mocks.userDbName,
  /** 重建用的"另起一个库"：真实实现会生成新库名并回写业务表 */
  createTimelineDatabase: async () => {
    mocks.createdTimelines += 1
    mocks.userDbName = "user-timeline_new"
    return mocks.userDbName
  },
  ensureBotDatabase: async () => "bot_test",
  ensureFeedDatabase: async () => "feed_test",
  nanoServer: {
    db: { destroy: async (name: string) => { mocks.destroyedDbs.push(name) } },
    request: async (opts: { db?: string, method?: string, doc?: string, body?: Record<string, unknown> }) => {
      if (opts?.doc !== "_local/state" || !opts.db) return {}
      if (opts.method === "PUT") {
        mocks.stateByDb[opts.db] = opts.body ?? {}
        return { ok: true }
      }
      const state = mocks.stateByDb[opts.db]
      // 状态文档不存在 = 新库/刚换的库：必须是 404（reconcile 靠它判断"水位要不要整份作废"）
      if (!state) throw Object.assign(new Error("missing"), { statusCode: 404 })
      return { ...state, _rev: "1-state" }
    },
  },
  createCouchDb: (dbName: string) => ({
    list: async (opts: { startkey?: string, endkey?: string, limit?: number, include_docs?: boolean, skip?: number }) => {
      // ① 订阅列表（listSubscriptionSources）
      if (opts.include_docs && opts.startkey === "subscription:") {
        return { rows: mocks.subscriptions.map(s => ({ id: `subscription:${s.feedId}`, doc: s })) }
      }
      // ② 换库重搬时的全库分页（不带 startkey，带 include_docs）
      if (opts.include_docs) {
        if (opts.startkey) return { rows: [] } // 第二页起给空，让循环退出
        return { rows: mocks.oldDocs.map(doc => ({ id: String(doc._id), doc })) }
      }
      // ③ 按前缀删（退订/剪枝）
      const key = String(opts.startkey ?? "")
      const rows = mocks.rowsByRange[key] ?? []
      mocks.rowsByRange[key] = [] // 只给一页
      return { rows }
    },
    get: async (id: string) => {
      const doc = mocks.oldDocs.find(d => d._id === id)
      if (!doc || !opts_hasRev(doc)) throw Object.assign(new Error("not_found"), { statusCode: 404 })
      return { _rev: String(doc._rev) }
    },
    destroy: async (id: string) => {
      mocks.destroyedByDb[dbName] = [...(mocks.destroyedByDb[dbName] ?? []), id]
      mocks.oldDocs = mocks.oldDocs.filter(d => d._id !== id)
    },
    bulk: async ({ docs }: { docs: Array<Record<string, unknown>> }) => {
      mocks.bulkByDb[dbName] = [...(mocks.bulkByDb[dbName] ?? []), ...docs]
      return docs.map(() => ({ ok: true }))
    },
    view: async (_ddoc: string, _name: string, opts: Record<string, unknown>) => {
      mocks.viewCalls.push(opts)
      if (mocks.viewThrows) throw Object.assign(new Error("missing"), { statusCode: 404 })
      return { rows: [] }
    },
    info: async () => ({ update_seq: 0 }),
    changes: async () => ({ results: [], last_seq: 0 }),
  }),
}))

function opts_hasRev(doc: Record<string, unknown>): boolean {
  return typeof doc._rev === "string" && !doc._deleted
}

// 复制层：新实现只用到「清理遗留常驻任务」与「跑一次性复制」两个入口
vi.mock("../couchdb/replicator", () => ({
  initialWindowBoundIso: (windowDays: number, now: number = Date.now()) =>
    new Date(now - windowDays * 86_400_000).toISOString(),
  purgeLegacyReplications: async (userId: string) => {
    mocks.purgeCalls.push(userId)
    const count = mocks.legacyPurgeCount
    mocks.legacyPurgeCount = 0
    return count
  },
  runSourceReplication: async () => ({ docsWritten: 0, sourceLastSeq: null, elapsedMs: 0 }),
}))

const { rebuildUserTimeline, reconcileUserTimeline } = await import("../services/timeline")

const HOUR = 3_600_000

beforeEach(() => {
  mocks.userDbName = "user-timeline_old"
  mocks.oldDocs = [
    { _id: "subscription:feed1", _rev: "1-s", type: "subscription", feedId: "feed1" },
    { _id: "entry-state:feed1:001", _rev: "1-e", type: "entry-state", read: true },
    { _id: "group-pref:g1", _rev: "1-g", type: "group-pref" },
    { _id: "entry:feed1:001", _rev: "1-a", type: "entry", title: "聚合产物" },
    { _id: "feed1", _rev: "1-f", type: "feed", title: "源元信息副本" },
    { _id: "_design/timeline-maintain", _rev: "1-d", views: {} },
  ]
  mocks.bulkByDb = {}
  mocks.destroyedByDb = {}
  mocks.stateByDb = {}
  mocks.rowsByRange = { "entry:feed1:": [] }
  mocks.subscriptions = [{ feedId: "feed1" }]
  mocks.settingsWindowDays = 3
  mocks.watermarks = []
  mocks.feedFreshness = []
  mocks.botFreshness = []
  mocks.purgeCalls = []
  mocks.legacyPurgeCount = 0
  mocks.watermarkDeleteCalls = 0
  mocks.createdTimelines = 0
  mocks.destroyedDbs = []
  mocks.viewCalls = []
  mocks.viewThrows = false
})

const copiedIds = () => (mocks.bulkByDb["user-timeline_new"] ?? []).map(d => String(d._id))
const deletedIds = (db = "user-timeline_old") => (mocks.bulkByDb[db] ?? []).filter(d => d._deleted).map(d => String(d._id))

/** 一行"已经同步过、且源那边没有新内容"的水位 */
const settledWatermark = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "feed1",
  windowDays: 3,
  boundIso: "2025-01-07T00:00:00.000Z",
  syncedAt: new Date(Date.now() - HOUR),
  status: "idle",
  sourceSeq: "10-abc",
  lastError: null,
  ...overrides,
})

describe("rebuildUserTimeline：换一个空库重新修剪", () => {
  it("另起一个聚合库并接管用户（不是就地清空），旧库随后删掉", async () => {
    await rebuildUserTimeline("u1")

    expect(mocks.createdTimelines).toBe(1)
    expect(mocks.userDbName).toBe("user-timeline_new")
    expect(mocks.destroyedDbs).toContain("user-timeline_old")
  })

  it("用户自己写的文档搬到新库：订阅、已读收藏、分组偏好", async () => {
    await rebuildUserTimeline("u1")

    expect(copiedIds()).toEqual(expect.arrayContaining([
      "subscription:feed1",
      "entry-state:feed1:001",
      "group-pref:g1",
    ]))
  })

  it("聚合产物不搬：entry:* 与裸源 id 的 FeedDoc 副本交给复制器重搬（设计文档也不搬）", async () => {
    await rebuildUserTimeline("u1")

    expect(copiedIds()).not.toContain("entry:feed1:001")
    expect(copiedIds()).not.toContain("feed1")
    expect(copiedIds()).not.toContain("_design/timeline-maintain")
    // 搬过去的文档不能带旧库的修订谱系（新库按自己的谱系写）
    expect((mocks.bulkByDb["user-timeline_new"] ?? []).every(d => !("_rev" in d) && !("_revisions" in d))).toBe(true)
  })

  /**
   * 重建之后聚合库是空的，此时若还信水位，那些"源那边没有新内容"的源就永远不会被搬 ——
   * 重建完等于什么都没有。判据是**新库没有状态文档**，所以水位整份作废、全部源重搬。
   */
  it("重建让水位整份作废：所有源重新入队（新库 = 新哈希 = 从 0 重扫），并清掉遗留常驻任务", async () => {
    mocks.watermarks = [settledWatermark()]
    mocks.legacyPurgeCount = 1

    const result = await rebuildUserTimeline("u1")

    expect(result.dirtySources).toEqual(["feed1"])
    expect(mocks.watermarkDeleteCalls).toBeGreaterThan(0) // 换库后水位作废
    expect(mocks.purgeCalls).toEqual(["u1"]) // 遗留常驻复制任务清掉
    expect(result.purgedReplications).toBe(1)
  })
})

describe("reconcileUserTimeline：升级与稳态", () => {
  it("老库（状态文档 version 1）走同一条换库重搬路径：老库里我们写的修订不能再留着", async () => {
    mocks.stateByDb["user-timeline_old"] = { version: 1, windowDays: 3 }

    const result = await reconcileUserTimeline("u1")

    expect(mocks.createdTimelines).toBe(1)
    expect(mocks.destroyedDbs).toContain("user-timeline_old")
    // 新库被写成 version 2，下一轮不再重搬
    expect(mocks.stateByDb["user-timeline_new"]).toMatchObject({ version: 2, windowDays: 3 })
    // 换库 = 内容全空：订阅的源全部重搬一遍
    expect(result.dirtySources).toEqual(["feed1"])
  })

  it("新库（没有状态文档）不重搬，把订阅的源判成脏源", async () => {
    const result = await reconcileUserTimeline("u1")

    expect(mocks.createdTimelines).toBe(0)
    expect(result.dirtySources).toEqual(["feed1"])
    expect(result.removedSyncs).toBe(0)
  })

  /**
   * 稳态 = 源那边没有新内容：**连一次复制请求都不发**。这是把常驻复制换成按需复制之后
   * 每 5 分钟一轮的全部成本（实测单源空转复制也要 ~1.3s，600 个源就是十几分钟机器时间）。
   */
  it("稳态（水位在手、源没更新、窗口一致）没有脏源，也不碰复制器", async () => {
    mocks.stateByDb["user-timeline_old"] = { version: 2, windowDays: 3, replicatorsPurged: true }
    mocks.watermarks = [settledWatermark()]
    mocks.feedFreshness = [{ id: "feed1", at: new Date(Date.now() - 2 * HOUR) }]

    const result = await reconcileUserTimeline("u1")

    expect(result.dirtySources).toEqual([])
    expect(mocks.purgeCalls).toEqual([]) // 升级清理只做一次（状态文档里已标记）
    expect(deletedIds()).toEqual([])
  })

  it("源在上次同步之后有新内容 → 判成脏源（水位就是干这个的）", async () => {
    mocks.stateByDb["user-timeline_old"] = { version: 2, windowDays: 3, replicatorsPurged: true }
    mocks.watermarks = [settledWatermark({ syncedAt: new Date(Date.now() - 2 * HOUR) })]
    mocks.feedFreshness = [{ id: "feed1", at: new Date(Date.now() - HOUR) }]

    const result = await reconcileUserTimeline("u1")

    expect(result.dirtySources).toEqual(["feed1"])
  })

  it("退订：删条目 + 删裸源 id 的 FeedDoc 副本 + 删水位行", async () => {
    mocks.stateByDb["user-timeline_old"] = { version: 2, windowDays: 3, replicatorsPurged: true }
    mocks.watermarks = [settledWatermark()]
    mocks.subscriptions = []
    mocks.rowsByRange = { "entry:feed1:": [
      { id: "entry:feed1:001", value: { rev: "1-a" } },
      { id: "entry:feed1:002", value: { rev: "1-b" } },
    ] }

    const result = await reconcileUserTimeline("u1")

    expect(deletedIds()).toEqual(expect.arrayContaining(["entry:feed1:001", "entry:feed1:002"]))
    expect(mocks.destroyedByDb["user-timeline_old"]).toContain("feed1")
    expect(result.removedSyncs).toBe(1)
    expect(result.removedEntries).toBeGreaterThan(0)
    expect(result.dirtySources).toEqual([])
  })

  it("换窗口：数据不动，只把源判成脏源（重算下界 = 换哈希 = 重扫回填）", async () => {
    mocks.stateByDb["user-timeline_old"] = { version: 2, windowDays: 3, replicatorsPurged: true }
    mocks.watermarks = [settledWatermark({ windowDays: 3 })]
    mocks.settingsWindowDays = 7

    const result = await reconcileUserTimeline("u1")

    // 数据不删：窗口的裁剪由剪枝负责，重扫只是把窗口外的历史重新过滤一遍
    expect(deletedIds()).toEqual([])
    expect(mocks.destroyedByDb["user-timeline_old"] ?? []).toEqual([])
    expect(result.removedSyncs).toBe(0)
    expect(result.dirtySources).toEqual(["feed1"])
  })

  it("换库重搬只搬用户意图：entry-state: 与 entry: 只差一个字符，靠字典序分开", () => {
    expect("entry-state:abc" < "entry:").toBe(true)
    expect("entry:feed1:001" >= "entry:" && "entry:feed1:001" <= "entry:\uffff").toBe(true)
  })

  /**
   * 剪枝视图不可用（用户库的设计文档没装上 / CouchDB 的 JS 查询服务卡死）时，
   * 剪枝抛 404。它**不能**把整轮 reconcile 带走：把脏源入队才是关键路径，
   * 原实现让 404 冒泡出去，结果是一条内容都不搬、状态也不写，客户端拿到 500、
   * 一条内容都同步不到（真机上就是这么表现的）。
   */
  it("剪枝失败只跳过剪枝：脏源照判、状态照写", async () => {
    mocks.viewThrows = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await reconcileUserTimeline("u1")

    expect(result.prunedEntries).toBe(0)
    expect(result.dirtySources).toEqual(["feed1"])
    expect(mocks.stateByDb["user-timeline_old"]).toMatchObject({ version: 2, windowDays: 3 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("剪枝失败"))
    warn.mockRestore()
  })
})

describe("同一用户串行化：并发重建 / 升级只能有一个赢家", () => {
  it("两轮并发聚合落在同一条队列上：第二轮的 reconcile 看到新库的状态（version 2），不再换库", async () => {
    // 第一个 reconcile 会走「老库 version 1 → 换库重搬」，第二个必须等它跑完再开始
    mocks.stateByDb["user-timeline_old"] = { version: 1, windowDays: 3 }

    const [first, second] = await Promise.all([
      reconcileUserTimeline("u1"),
      reconcileUserTimeline("u1"),
    ])

    // 只换了一次库（第二个 reconcile 看到的是新库的 version 2）
    expect(mocks.createdTimelines).toBe(1)
    expect(mocks.destroyedDbs).toEqual(["user-timeline_old"])
    // 两轮都会把源判成脏源：真正的去重由队列的 jobId（(用户 × 源) 一个 job）保证
    expect(first.dirtySources).toEqual(["feed1"])
    expect(second.dirtySources).toEqual(["feed1"])
  })
})
