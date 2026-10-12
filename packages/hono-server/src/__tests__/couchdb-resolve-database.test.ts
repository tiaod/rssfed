import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 回归用例：库名解析的「快路径」。
 *
 * 库名一旦登记在业务表上，抓取/查询条目/下发寻址等高频路径就只应查一次 PostgreSQL，
 * 不再碰 CouchDB —— 否则每个订阅每次都要多打一次 GET /db 和一次 PUT /_security。
 * 只有库名缺失（首次）时才建库、装设计文档/索引、设授权、回写库名。
 */
const mocks = vi.hoisted(() => ({
  dbGet: vi.fn(),
  dbCreate: vi.fn(),
  securityPut: vi.fn(),
  insert: vi.fn(),
  findFirst: vi.fn(),
  returning: vi.fn(),
  dbDestroy: vi.fn(),
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { get: mocks.dbGet, create: mocks.dbCreate, destroy: mocks.dbDestroy },
    request: mocks.securityPut,
    use: () => ({ insert: mocks.insert, get: mocks.dbGet }),
  }),
}))

// drizzle 的 eq/and/isNull 只用来拼 SQL 条件，这里不需要真实列元数据
vi.mock("drizzle-orm", () => ({ eq: () => ({}), and: () => ({}), isNull: () => ({}) }))

vi.mock("../db", () => ({
  db: {
    query: {
      feeds: { findFirst: mocks.findFirst },
      bots: { findFirst: mocks.findFirst },
      user: { findFirst: mocks.findFirst },
    },
    update: () => ({
      set: () => ({ where: () => ({ returning: mocks.returning }) }),
    }),
  },
  feeds: { id: "feeds.id", couchDbName: "feeds.couch_db_name" },
  bots: { id: "bots.id", couchDbName: "bots.couch_db_name" },
  user: { id: "user.id", couchDbName: "user.couch_db_name", timelineDbName: "user.timeline_db_name" },
  COUCHDB_FEED_PREFIX: "feed_",
  COUCHDB_BOT_PREFIX: "bot_",
  COUCHDB_USER_TIMELINE_PREFIX: "user-timeline_",
}))

const { ensureFeedDatabase, ensureTimelineDatabase } = await import("../couchdb/client")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.returning.mockResolvedValue([{ id: "x" }])
  mocks.dbGet.mockResolvedValue({ db_name: "x" })
  mocks.securityPut.mockResolvedValue({ ok: true })
  mocks.insert.mockResolvedValue({ ok: true })
  mocks.dbDestroy.mockResolvedValue({ ok: true })
})

describe("resolveDatabase：库名已登记", () => {
  it("源库快路径只补装一次复制过滤器（进程内缓存），不建库、不重设授权", async () => {
    // 每个用例用不同的库名：过滤器「已 ensure」是进程内缓存的，同名会跨用例串味
    const dbName = `feed_${"b".repeat(24)}`
    mocks.findFirst.mockResolvedValue({ couchDbName: dbName })
    const { TIMELINE_REPLICATION_FILTER } = await import("../couchdb/client")
    mocks.dbGet.mockResolvedValue({
      _id: "_design/main",
      _rev: "1-ok",
      views: { "entries-by-date": {} },
      filters: { timeline: TIMELINE_REPLICATION_FILTER },
    })

    expect(await ensureFeedDatabase("f1")).toBe(dbName)

    // 正好一次设计文档 GET（比对过滤器源码）；过滤器已在 → 一个写请求都不发
    expect(mocks.dbGet).toHaveBeenCalledTimes(1)
    expect(mocks.dbGet).toHaveBeenCalledWith("_design/main")
    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("存量源库补装过滤器：设计文档缺 filters.timeline 时带 _rev 覆盖一次（保留视图），之后缓存命中不再查", async () => {
    const dbName = `feed_${"c".repeat(24)}`
    mocks.findFirst.mockResolvedValue({ couchDbName: dbName })
    mocks.dbGet.mockResolvedValue({
      _id: "_design/main",
      _rev: "2-old",
      views: { "entries-by-date": { map: "function(doc){}" } },
    })

    await ensureFeedDatabase("f2")
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const written = mocks.insert.mock.calls[0]![0] as {
      _rev?: string
      filters?: Record<string, string>
      views?: Record<string, unknown>
    }
    expect(written._rev).toBe("2-old")
    expect(typeof written.filters?.timeline).toBe("string")
    // 覆盖时不能把视图弄丢（复制过滤器是后加的，视图是老库本来就有的）
    expect(written.views).toEqual({ "entries-by-date": { map: "function(doc){}" } })

    mocks.dbGet.mockClear()
    mocks.insert.mockClear()
    await ensureFeedDatabase("f2")
    expect(mocks.dbGet).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("用户库读的是 user.timeline_db_name 这一列，走同一条快路径", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: "user-timeline_cccccccccccccccccccccccc" })
    // 库里的设计文档已带闸门与全部视图：快路径只查一次设计文档，一个写请求都不发
    const { TIMELINE_DESIGN_DOC_VIEWS, TIMELINE_VALIDATE_DOC_UPDATE } = await import("../couchdb/client")
    mocks.dbGet.mockResolvedValue({
      _id: "_design/timeline-maintain",
      _rev: "5-ok",
      validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
      views: TIMELINE_DESIGN_DOC_VIEWS,
    })

    expect(await ensureTimelineDatabase("u1")).toBe("user-timeline_cccccccccccccccccccccccc")

    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
  })

  /**
   * 只比校验函数、不比视图是个真实的坑：视图是后加的（`by_feed_published_at` 为条数保底而加），
   * 而存量库的校验函数早就一致 —— 那样"视图还没装"的库会被当成已就位，剪枝查不到视图 → 404
   * → 剪枝整步被跳过（窗口与保底条数一起失效，用户库只增不减）。
   */
  it("存量库缺新视图：校验函数一致也照样带 _rev 覆盖装一次", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: `user-timeline_${"8".repeat(24)}` })
    const { TIMELINE_VALIDATE_DOC_UPDATE } = await import("../couchdb/client")
    mocks.dbGet.mockResolvedValue({
      _id: "_design/timeline-maintain",
      _rev: "3-old",
      validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
      // 老库：只有按发布时间排的那个视图
      views: { by_published_at: { map: "function(doc){ emit(doc.publishedAt, null); }" } },
    })

    await ensureTimelineDatabase("u1")

    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const written = mocks.insert.mock.calls[0]![0] as { _rev?: string, views?: Record<string, unknown> }
    expect(written._rev).toBe("3-old")
    expect(Object.keys(written.views ?? {}).sort()).toEqual(["by_feed_published_at", "by_published_at"])
  })

  it("并发建库：没抢到库名的一方删掉自己刚建的空库，改用赢家的库（否则订阅会写进没人指得着的孤儿库）", async () => {
    const winner = `feed_${"e".repeat(24)}`
    // 第一次 findFirst（解析前查列）没有库名；认领失败后回读，拿到赢家的库名
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ couchDbName: winner })
    // 认领失败：条件更新（列还是空才写）没写到任何行
    mocks.returning.mockResolvedValue([])
    mocks.dbGet.mockRejectedValueOnce(new Error("not_found")).mockResolvedValue({
      _id: "_design/main",
      _rev: "1-ok",
      views: { "entries-by-date": {} },
      filters: { timeline: "function(doc, req) { return true; }" },
    })

    const name = await ensureFeedDatabase("f-race")

    expect(name).toBe(winner)
    expect(mocks.dbDestroy).toHaveBeenCalledTimes(1)
    expect(String(mocks.dbDestroy.mock.calls[0]![0])).toMatch(/^feed_/)
    expect(String(mocks.dbDestroy.mock.calls[0]![0])).not.toBe(winner)
  })

  it("用户库快路径同样会补装闸门：老库（设计文档缺闸门）带 _rev 覆盖一次，之后不再查", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: `user-timeline_${"9".repeat(24)}` })
    // 老库的设计文档存在但没有闸门
    mocks.dbGet.mockResolvedValue({ _id: "_design/timeline-maintain", _rev: "2-old", views: {} })

    await ensureTimelineDatabase("u1")
    expect(mocks.insert).toHaveBeenCalledTimes(1)

    // 第二次调用：进程内缓存命中，连设计文档都不再查
    mocks.dbGet.mockClear()
    mocks.insert.mockClear()
    await ensureTimelineDatabase("u1")
    expect(mocks.dbGet).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

describe("resolveDatabase：库名缺失（首次）", () => {
  it("建库 + 装设计文档 + 设 _security + 回写库名", async () => {
    mocks.findFirst.mockResolvedValue(null)
    // 库不存在：GET 抛错才会走到 create 分支
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const dbName = await ensureFeedDatabase("f1")

    expect(dbName).toMatch(/^feed_[a-z0-9]{24}$/)
    expect(mocks.dbCreate).toHaveBeenCalledWith(dbName)
    // feed 库的设计文档：entries-by-date 视图 + 聚合复制过滤器（一起装，只装一次）
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const designDoc = mocks.insert.mock.calls[0]![0] as { views?: Record<string, unknown>, filters?: Record<string, string> }
    expect(Object.keys(designDoc.views ?? {})).toEqual(["entries-by-date"])
    expect(typeof designDoc.filters?.timeline).toBe("string")
    // 库级 _security：feed 库放行 user 角色
    expect(mocks.securityPut).toHaveBeenCalledTimes(1)
    expect(mocks.securityPut.mock.calls[0]![0]).toMatchObject({
      doc: "_security",
      body: { members: { roles: ["user"] } },
    })
    // 库名回写业务表，下次走快路径
    expect(mocks.returning).toHaveBeenCalledTimes(1)
  })

  it("并发建库时（GET 成功但没库名）不重复写设计文档", async () => {
    mocks.findFirst.mockResolvedValue(null)
    // 另一个请求已抢先建好库
    mocks.dbGet.mockResolvedValue({ db_name: "x" })

    await ensureFeedDatabase("f1")

    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("用户库建库时装「维护视图 + 写方向闸门」，_security 只授权本人", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const dbName = await ensureTimelineDatabase("u1")

    expect(dbName).toMatch(/^user-timeline_[a-z0-9]{24}$/)
    expect(mocks.dbCreate).toHaveBeenCalledWith(dbName)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({
      _id: "_design/timeline-maintain",
      validate_doc_update: expect.stringContaining("forbidden"),
    })
    expect(mocks.securityPut.mock.calls[0]![0]).toMatchObject({
      doc: "_security",
      body: { members: { names: ["u1"], roles: [] } },
    })
  })

})

describe("存量用户库补装写方向闸门", () => {
  /**
   * 闸门是后加的，200+ 个老库里没有它 —— 「只在新库安装」会让老库永久裸奔，
   * 所以 ensure 侧必须比对并覆盖。这里直接调 ensureTimelineDesignDoc（导出给测试用）。
   */
  it("设计文档缺闸门时带 _rev 覆盖；已带闸门时不再写", async () => {
    const { ensureTimelineDesignDoc } = await import("../couchdb/client")
    const dbName = `user-timeline_${"e".repeat(24)}`

    // 老库：设计文档存在，但没有 validate_doc_update
    mocks.dbGet.mockResolvedValue({ _id: "_design/timeline-maintain", _rev: "3-old", views: {} })
    await ensureTimelineDesignDoc(dbName)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({ _rev: "3-old", _id: "_design/timeline-maintain" })

    // 同一个库第二次调用：进程内缓存命中，不再查询/写入
    mocks.insert.mockClear()
    await ensureTimelineDesignDoc(dbName)
    expect(mocks.insert).not.toHaveBeenCalled()

    // 另一个库：设计文档已带同样的闸门与视图 → 读到即返回，不覆盖
    const { TIMELINE_DESIGN_DOC_VIEWS, TIMELINE_VALIDATE_DOC_UPDATE } = await import("../couchdb/client")
    const other = `user-timeline_${"f".repeat(24)}`
    mocks.dbGet.mockResolvedValue({
      _id: "_design/timeline-maintain",
      _rev: "4-ok",
      validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
      views: TIMELINE_DESIGN_DOC_VIEWS,
    })
    await ensureTimelineDesignDoc(other)
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

/**
 * 设计文档写失败（CouchDB 的 JS 查询服务忙/卡死时是 500）**不能**被当成"已就位"缓存下来。
 *
 * 缓存下来就等于这个进程往后每一轮 reconcile 都不再补装：用户库缺 `by_published_at` 视图 →
 * 剪枝每轮 404；源库缺 `filters.timeline` → 复制任务一直 crashing。两种都表现为
 * 「客户端一条内容都同步不到」，且没有任何日志信号（原实现把错误吞在内层 catch 里）。
 */
describe("设计文档写失败不进缓存", () => {
  const internalServerError = () => Object.assign(new Error("internal_server_error"), { statusCode: 500 })

  it("用户库设计文档写失败：告警、返回 false，下一次调用会重试", async () => {
    const { ensureTimelineDesignDoc } = await import("../couchdb/client")
    const dbName = `user-timeline_${"a".repeat(23)}1`
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.dbGet.mockRejectedValue(new Error("not_found"))
    mocks.insert.mockRejectedValueOnce(internalServerError())

    expect(await ensureTimelineDesignDoc(dbName)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dbName))

    // 没进缓存：下一次 ensure 会再写一次（这次成功）
    mocks.insert.mockResolvedValue({ ok: true })
    expect(await ensureTimelineDesignDoc(dbName)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("源库复制过滤器写失败：告警、返回 false；成功之前不会被当成已装", async () => {
    const { ensureReplicationFilter } = await import("../couchdb/client")
    const dbName = `feed_${"g".repeat(24)}`
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.dbGet.mockResolvedValue({ _id: "_design/main", _rev: "2-old", filters: {} })
    mocks.insert.mockRejectedValueOnce(internalServerError())

    expect(await ensureReplicationFilter(dbName)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dbName))

    mocks.insert.mockResolvedValue({ ok: true })
    expect(await ensureReplicationFilter(dbName)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledTimes(2)
    // 装好之后才进缓存：第三次不再写
    expect(await ensureReplicationFilter(dbName)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("并发 ensure 撞出的 409 视为到位（进缓存，不再重写）", async () => {
    const { ensureReplicationFilter } = await import("../couchdb/client")
    const dbName = `feed_${"h".repeat(24)}`
    mocks.dbGet.mockRejectedValue(new Error("not_found"))
    mocks.insert.mockRejectedValueOnce(Object.assign(new Error("conflict"), { statusCode: 409 }))

    expect(await ensureReplicationFilter(dbName)).toBe(true)
    expect(await ensureReplicationFilter(dbName)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
  })
})
