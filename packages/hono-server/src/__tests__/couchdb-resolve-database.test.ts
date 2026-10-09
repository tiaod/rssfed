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
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { get: mocks.dbGet, create: mocks.dbCreate },
    request: mocks.securityPut,
    use: () => ({ insert: mocks.insert, get: mocks.dbGet }),
  }),
}))

// drizzle 的 eq 只用来拼 SQL 条件，这里不需要真实列元数据
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }))

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

/** 已登记的库名（24 位随机后缀） */
const EXISTING = `feed_${"a".repeat(24)}`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.returning.mockResolvedValue([{ id: "x" }])
  mocks.dbGet.mockResolvedValue({ db_name: "x" })
  mocks.securityPut.mockResolvedValue({ ok: true })
  mocks.insert.mockResolvedValue({ ok: true })
})

describe("resolveDatabase：库名已登记", () => {
  it("直接返回库名，一个 CouchDB 请求都不发", async () => {
    mocks.findFirst.mockResolvedValue({ couchDbName: EXISTING })

    expect(await ensureFeedDatabase("f1")).toBe(EXISTING)

    expect(mocks.dbGet).not.toHaveBeenCalled()
    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("用户库读的是 user.timeline_db_name 这一列，走同一条快路径", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: "user-timeline_cccccccccccccccccccccccc" })
    // 库里的设计文档已带闸门：快路径只查一次设计文档，一个写请求都不发
    const { TIMELINE_VALIDATE_DOC_UPDATE } = await import("../couchdb/client")
    mocks.dbGet.mockResolvedValue({
      _id: "_design/timeline-maintain",
      _rev: "5-ok",
      validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
    })

    expect(await ensureTimelineDatabase("u1")).toBe("user-timeline_cccccccccccccccccccccccc")

    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
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
    // feed 库的设计文档（entries-by-date 视图）
    expect(mocks.insert).toHaveBeenCalledTimes(1)
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

    // 另一个库：设计文档已带同样的闸门 → 读到即返回，不覆盖
    const { TIMELINE_VALIDATE_DOC_UPDATE } = await import("../couchdb/client")
    const other = `user-timeline_${"f".repeat(24)}`
    mocks.dbGet.mockResolvedValue({
      _id: "_design/timeline-maintain",
      _rev: "4-ok",
      validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
    })
    await ensureTimelineDesignDoc(other)
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
