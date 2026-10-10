import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 聚合库的「重建 / 升级」：换一个空库重新从源库搬一遍，用户状态跟着走。
 *
 * 合并成单库之后，聚合库里的文档分两类：
 *   - 服务端写：`entry:*` 与 **裸源 id** 的 FeedDoc 副本（复制器会重搬，重建时不用管）
 *   - 客户端写：`subscription:`、`entry-state:`、`group-pref:`（用户意图，丢不得）
 *
 * 两条不变量在这里钉死：
 *   ① 重建**不丢用户状态**（订阅、已读收藏要搬到新库；丢了就是「重建一次，订阅全没了」）；
 *   ② 重建必须**换库**而不是就地清空 —— 复制是变更投递不是投影，目标端自己删过的 rev
 *      复制器不会再送（实测），就地清空等于永久丢内容；换库连 checkpoint（在库的 `_local` 里）
 *      一起清掉，新任务才会从 0 扫源库。
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
  /** `_replicator` 里的任务（可变：删/建都会反映到后续列举） */
  replications: [] as Array<{ docId: string, rev: string, userId: string, windowDays: number, sourceId: string }>,
  deleteReplicationCalls: [] as string[][],
  ensureReplicationCalls: [] as Array<Record<string, unknown>>,
  createdTimelines: 0,
  destroyedDbs: [] as string[],
  viewCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { destroy: async (name: string) => { mocks.destroyedDbs.push(name) } },
    use: () => ({}),
    request: async () => ({}),
  }),
}))

vi.mock("../db", () => ({
  db: {
    query: { user: { findFirst: async () => ({ timelineDbName: mocks.userDbName }) } },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "u1" }] }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ windowDays: mocks.settingsWindowDays, aiSummaryEnabled: false }] }) }) }),
  },
  user: { id: "user.id", timelineDbName: "user.timeline_db_name" },
  userTimelineSettings: { userId: "user_id" },
}))

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
      if (!state) throw new Error("missing")
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
      return { rows: [] }
    },
    info: async () => ({ update_seq: 0 }),
    changes: async () => ({ results: [], last_seq: 0 }),
  }),
}))

function opts_hasRev(doc: Record<string, unknown>): boolean {
  return typeof doc._rev === "string" && !doc._deleted
}

// 复制拓扑：用一份可变的内存清单代替真 `_replicator`
vi.mock("../couchdb/replicator", () => ({
  listUserReplications: async (userId: string) => mocks.replications.filter(r => r.userId === userId),
  deleteReplications: async (items: Array<{ docId: string }>) => {
    mocks.deleteReplicationCalls.push(items.map(i => i.docId))
    const gone = new Set(items.map(i => i.docId))
    mocks.replications = mocks.replications.filter(r => !gone.has(r.docId))
  },
  ensureReplication: async (spec: Record<string, unknown>) => {
    mocks.ensureReplicationCalls.push(spec)
    mocks.replications.push({
      docId: `rssfed-${spec.userId}:w${spec.windowDays}:${spec.sourceId}`,
      rev: "1-new",
      userId: String(spec.userId),
      windowDays: Number(spec.windowDays),
      sourceId: String(spec.sourceId),
    })
    return "created" as const
  },
}))

const { rebuildUserTimeline, reconcileUserTimeline } = await import("../services/timeline")

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
  mocks.replications = []
  mocks.deleteReplicationCalls = []
  mocks.ensureReplicationCalls = []
  mocks.createdTimelines = 0
  mocks.destroyedDbs = []
  mocks.viewCalls = []
})

const copiedIds = () => (mocks.bulkByDb["user-timeline_new"] ?? []).map(d => String(d._id))
const deletedIds = (db = "user-timeline_old") => (mocks.bulkByDb[db] ?? []).filter(d => d._deleted).map(d => String(d._id))

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

  it("旧任务作废、按新库当前窗口重建：目标库变了 = 复制哈希变了 = 从 0 重扫", async () => {
    mocks.replications = [{ docId: "rssfed-u1:w3:feed1", rev: "1-old", userId: "u1", windowDays: 3, sourceId: "feed1" }]

    const result = await rebuildUserTimeline("u1")

    expect(mocks.deleteReplicationCalls.flat()).toEqual(["rssfed-u1:w3:feed1"])
    expect(mocks.ensureReplicationCalls).toHaveLength(1)
    expect(mocks.ensureReplicationCalls[0]).toMatchObject({ userId: "u1", windowDays: 3, sourceId: "feed1", targetDb: "user-timeline_new" })
    // 被作废的旧任务计进返回值（供日志/排查）
    expect(result.removedReplications).toBeGreaterThanOrEqual(1)
  })
})

describe("reconcileUserTimeline：升级与稳态", () => {
  it("老库（状态文档 version 1）走同一条换库重搬路径：老库里我们写的修订不能再留着", async () => {
    mocks.stateByDb["user-timeline_old"] = { version: 1, windowDays: 3 }

    await reconcileUserTimeline("u1")

    expect(mocks.createdTimelines).toBe(1)
    expect(mocks.destroyedDbs).toContain("user-timeline_old")
    // 新库被写成 version 2，下一轮不再重搬
    expect(mocks.stateByDb["user-timeline_new"]).toMatchObject({ version: 2, windowDays: 3 })
    expect(mocks.ensureReplicationCalls[0]).toMatchObject({ targetDb: "user-timeline_new", windowDays: 3 })
  })

  it("新库（没有状态文档）不重搬，直接按当前窗口建任务", async () => {
    const result = await reconcileUserTimeline("u1")

    expect(mocks.createdTimelines).toBe(0)
    expect(mocks.createdTimelines).toBe(0)
    expect(result.createdReplications).toBe(1)
    expect(result.removedReplications).toBe(0)
  })

  it("稳态（任务已在、窗口一致）一个写请求都不发", async () => {
    mocks.replications = [{ docId: "rssfed-u1:w3:feed1", rev: "1-cur", userId: "u1", windowDays: 3, sourceId: "feed1" }]

    const result = await reconcileUserTimeline("u1")

    expect(mocks.deleteReplicationCalls).toHaveLength(0)
    expect(mocks.ensureReplicationCalls).toHaveLength(0)
    expect(result.createdReplications).toBe(0)
    expect(result.removedReplications).toBe(0)
  })

  it("退订：删任务 + 删该源条目 + 删裸源 id 的 FeedDoc 副本", async () => {
    mocks.replications = [{ docId: "rssfed-u1:w3:feed1", rev: "1-cur", userId: "u1", windowDays: 3, sourceId: "feed1" }]
    mocks.subscriptions = []
    mocks.rowsByRange = { "entry:feed1:": [
      { id: "entry:feed1:001", value: { rev: "1-a" } },
      { id: "entry:feed1:002", value: { rev: "1-b" } },
    ] }

    const result = await reconcileUserTimeline("u1")

    expect(mocks.deleteReplicationCalls.flat()).toEqual(["rssfed-u1:w3:feed1"])
    expect(deletedIds()).toEqual(expect.arrayContaining(["entry:feed1:001", "entry:feed1:002"]))
    expect(mocks.destroyedByDb["user-timeline_old"]).toContain("feed1")
    expect(result.removedReplications).toBe(1)
    expect(result.removedEntries).toBeGreaterThan(0)
  })

  it("换窗口：只换任务，不动数据（旧任务删掉，新任务按新窗口建 = 新哈希 = 重扫回填）", async () => {
    mocks.replications = [{ docId: "rssfed-u1:w3:feed1", rev: "1-cur", userId: "u1", windowDays: 3, sourceId: "feed1" }]
    mocks.settingsWindowDays = 7

    const result = await reconcileUserTimeline("u1")

    expect(mocks.deleteReplicationCalls.flat()).toEqual(["rssfed-u1:w3:feed1"])
    expect(mocks.ensureReplicationCalls[0]).toMatchObject({ windowDays: 7 })
    // 数据不删：窗口的裁剪由剪枝负责，换任务只是让复制器重新扫一遍
    expect(deletedIds()).toEqual([])
    expect(mocks.destroyedByDb["user-timeline_old"] ?? []).toEqual([])
    expect(result.removedReplications).toBe(1)
  })

  it("换库重搬只搬用户意图：entry-state: 与 entry: 只差一个字符，靠字典序分开", () => {
    expect("entry-state:abc" < "entry:").toBe(true)
    expect("entry:feed1:001" >= "entry:" && "entry:feed1:001" <= "entry:\uffff").toBe(true)
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

    // 只换了一次库（第二个 reconcile 看到的是新库的 version 2，直接对齐拓扑）
    expect(mocks.createdTimelines).toBe(1)
    expect(mocks.destroyedDbs).toEqual(["user-timeline_old"])
    expect(first.createdReplications + second.createdReplications).toBe(1)
  })
})
