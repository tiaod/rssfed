import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 汇聚库保留（reconcile 的第 ④ 步）：**逐源**裁到最新 N 条，多余的 `_purge`。
 *
 * 为什么用户库也要裁（以前是"源库裁、删除传播、用户库只做镜像"）：
 * 汇聚改用 Mango selector 之后，删除不再随复制传播（墓碑静默丢失），所以两侧必须各自执行
 * 同一条保留规则。这条规则如果**只在源库执行**，用户库会永远留着源库已经裁掉的旧条目
 * （新订阅时先搬进来的一批，之后就再也没人清）。
 *
 * 这里钉死四件事：
 *   ① 裁剪用汇聚库自己的视图（按 `[feedId, publishedAt]`），不是源库那个；
 *   ② 是**逐源**各留 N 条，不是整库留 N 条（用户库一个库装着几百个源）；
 *   ③ N 取**订阅源里最大的那个**（取最小会误删：A 源留 10 条时会把 B 源该留的 50 条删掉）；
 *   ④ 裁剪失败不影响搬运与退订清理（只记一条失败，下一轮继续）。
 */
const mocks = vi.hoisted(() => ({
  userDbName: "user-timeline_test",
  /** 状态文档（`_local/state`）；undefined = 新库（404） */
  state: undefined as Record<string, unknown> | undefined,
  /** 每轮 trimSourceToLatestN 收到的参数（断言"逐源 + 正确视图 + 正确 N"） */
  trimCalls: [] as Array<Record<string, unknown>>,
  /** 裁剪要模拟抛错时置为 string */
  trimError: null as string | null,
  /** 裁剪"清掉了多少条"（模拟返回值） */
  trimDeleted: 0,
  /** sources 列表 */
  subscriptions: [] as Array<{ feedId: string, kind?: string }>,
  /** feeds 表里的 retention_entries（喂给 resolveTimelineRetentionEntries） */
  feedRetention: [] as Array<{ id: string, n: number | null }>,
  /** PG 里的水位行 */
  watermarks: [] as Array<Record<string, unknown>>,
  createdTimelines: 0,
  destroyedDbs: [] as string[],
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { destroy: async (name: string) => { mocks.destroyedDbs.push(name) } },
    use: () => ({}),
    request: async () => ({}),
  }),
}))

/** 极简 drizzle mock：`select()` 按 from 的表返回预置行，写操作只记次数 */
vi.mock("../db", () => {
  const tableOf = (name: string) => ({ __table: name })
  // rows 用 thunk：mock 工厂在 beforeEach 之前求值，直接捕获数组会永远读到空的初值
  const chain = (rows: () => unknown[]) => {
    const api = {
      from: () => api,
      where: () => api,
      limit: () => api,
      leftJoin: () => api,
      orderBy: () => api,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
    }
    return api
  }
  return {
    db: {
      select: () => ({
        from: (table: { __table: string }) => {
          // 表名用驼峰（与 ../db 导出的变量名一致），不是库里的蛇形表名
          if (table.__table === "feeds") return chain(() => mocks.feedRetention)
          if (table.__table === "timelineSourceSync") return chain(() => mocks.watermarks)
          return chain(() => [])
        },
      }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      delete: () => ({ where: async () => {} }),
      execute: async () => {},
    },
    feeds: tableOf("feeds"),
    bots: tableOf("bots"),
    user: tableOf("user"),
    userTimelineSettings: tableOf("userTimelineSettings"),
    timelineSourceSync: tableOf("timelineSourceSync"),
    timelineEvents: tableOf("timelineEvents"),
    timelineReconcileHeartbeat: tableOf("timelineReconcileHeartbeat"),
  }
})

vi.mock("../couchdb/client", () => ({
  createCouchDb: () => ({
    list: async (opts: { startkey?: string }) => {
      if (opts.startkey === "subscription:") {
        return {
          rows: mocks.subscriptions.map(s => ({
            id: `subscription:${s.feedId}`,
            doc: { feedId: s.feedId, kind: s.kind ?? "feed" },
          })),
        }
      }
      return { rows: [] }
    },
    get: async () => { throw Object.assign(new Error("not_found"), { statusCode: 404 }) },
    destroy: async () => {},
    bulk: async () => [],
    info: async () => ({ update_seq: 0 }),
    changes: async () => ({ results: [], last_seq: 0 }),
  }),
  createTimelineDatabase: async () => "user-timeline_test",
  ensureBotDatabase: async () => "bot_test",
  ensureFeedDatabase: async () => "feed_test",
  ensureTimelineDatabase: async () => mocks.userDbName,
  ensureTimelineDesignDoc: async () => true,
  nanoServer: {
    db: { destroy: async (name: string) => { mocks.destroyedDbs.push(name) } },
    request: async (opts: { doc?: string, method?: string, body?: Record<string, unknown> }) => {
      if (opts?.doc !== "_local/state") return {}
      if (opts.method === "PUT") {
        mocks.state = opts.body
        return { ok: true }
      }
      if (!mocks.state) throw Object.assign(new Error("missing"), { statusCode: 404 })
      return { ...mocks.state, _rev: "1-state" }
    },
  },
}))

vi.mock("../couchdb/replicator", () => ({
  purgeLegacyReplications: async () => 0,
  runSourceReplication: async () => ({ docsWritten: 0, sourceLastSeq: null, elapsedMs: 0, writeFailures: 0 }),
}))

vi.mock("../couchdb/retention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../couchdb/retention")>()
  return {
    ...actual,
    // 只替换"真的去碰 CouchDB"的那层：纯函数（trimExcess / buildPurgeBody / countPurged）保留
    createTrimDb: () => ({}),
    trimSourceToLatestN: async (_db: unknown, opts: Record<string, unknown>) => {
      mocks.trimCalls.push(opts)
      if (mocks.trimError) throw new Error(mocks.trimError)
      return { total: 0, deleted: mocks.trimDeleted, batches: 0 }
    },
  }
})

const { reconcileUserTimeline, resolveTimelineRetentionEntries } = await import("../services/timeline")
const { USER_TIMELINE_TRIM_VIEW, DEFAULT_SOURCE_RETENTION_ENTRIES } = await import("../couchdb/retention")

beforeEach(() => {
  mocks.trimCalls = []
  mocks.trimError = null
  mocks.trimDeleted = 0
  mocks.subscriptions = [{ feedId: "feed1" }]
  mocks.feedRetention = [{ id: "feed1", n: 50 }]
  mocks.watermarks = []
  // 状态文档先"已升级 + 已清理遗留复制"：避免每轮都走换库重搬那条分支
  mocks.state = { version: 2, replicatorsPurged: true }
  mocks.createdTimelines = 0
  mocks.destroyedDbs = []
})

describe("resolveTimelineRetentionEntries：取订阅源里最大的 N", () => {
  it("多个源 N 不同时取最大（取最小会误删 N 大的那个源）", async () => {
    mocks.feedRetention = [{ id: "a", n: 10 }, { id: "b", n: 50 }]
    const n = await resolveTimelineRetentionEntries([{ id: "a", kind: "feed" }, { id: "b", kind: "feed" }])
    expect(n).toBe(50)
  })

  it("全部低于默认值时仍按默认值（默认是下限，不是上限）", async () => {
    mocks.feedRetention = [{ id: "a", n: 10 }]
    expect(await resolveTimelineRetentionEntries([{ id: "a", kind: "feed" }]))
      .toBe(DEFAULT_SOURCE_RETENTION_ENTRIES)
  })

  it("没算过（null）的源不参与比较，不会把 N 拉成 0", async () => {
    mocks.feedRetention = [{ id: "a", n: null }, { id: "b", n: 30 }]
    expect(await resolveTimelineRetentionEntries([{ id: "a", kind: "feed" }, { id: "b", kind: "feed" }]))
      .toBe(DEFAULT_SOURCE_RETENTION_ENTRIES)
  })

  it("只订阅 bot 的账号：返回 null（本轮不裁 —— bot 库不裁剪，裁了会被原样搬回来）", async () => {
    mocks.feedRetention = []
    expect(await resolveTimelineRetentionEntries([{ id: "bot:b1", kind: "bot" }])).toBeNull()
    // bot + feed 混合时才裁，且只看 feed 的 N
    mocks.feedRetention = [{ id: "a", n: 20 }]
    expect(await resolveTimelineRetentionEntries([
      { id: "bot:b1", kind: "bot" },
      { id: "a", kind: "feed" },
    ])).toBe(DEFAULT_SOURCE_RETENTION_ENTRIES)
  })
})

describe("reconcile 的汇聚库保留步骤", () => {
  it("按逐源方式裁，用汇聚库自己的视图", async () => {
    await reconcileUserTimeline("u1")

    expect(mocks.trimCalls).toHaveLength(1)
    expect(mocks.trimCalls[0]).toMatchObject({
      viewPath: USER_TIMELINE_TRIM_VIEW,
      groupByFeed: true,
      compact: false,
    })
    expect(mocks.trimCalls[0]!.n).toBe(50)
  })

  it("零订阅账号不做裁剪（没有源就没有过期条目，省一次视图查询）", async () => {
    mocks.subscriptions = []
    await reconcileUserTimeline("u1")
    expect(mocks.trimCalls).toHaveLength(0)
  })

  it("只订阅 bot 的账号也不裁（bot 库不裁剪，裁了下一轮会被搬回来）", async () => {
    mocks.subscriptions = [{ feedId: "bot:b1", kind: "bot" }]
    await reconcileUserTimeline("u1")
    expect(mocks.trimCalls).toHaveLength(0)
  })

  it("裁剪失败只记一条失败，不影响退订清理与脏源判定", async () => {
    mocks.trimError = "视图缺失"
    mocks.watermarks = [{
      sourceId: "feedGone",
      syncedAt: new Date(Date.now() - 3600_000),
      status: "idle",
      sourceSeq: null,
      lastError: null,
    }]
    mocks.subscriptions = [{ feedId: "feed1" }]

    const result = await reconcileUserTimeline("u1")

    expect(result.failures).toContainEqual({ sourceId: "*retention", error: "视图缺失" })
    // 退订清理照旧跑完（水位行被删、源被判成已退订）
    expect(result.removedSyncs).toBe(1)
    expect(result.dirtySources).toEqual(["feed1"])
  })

  it("清掉的条数进 result.trimmedEntries（给同步日志与心跳用）", async () => {
    mocks.trimDeleted = 320

    const result = await reconcileUserTimeline("u1")
    expect(result.trimmedEntries).toBe(320)
  })
})
