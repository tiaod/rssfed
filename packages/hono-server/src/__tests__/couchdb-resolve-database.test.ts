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
  createIndex: vi.fn(),
  findFirst: vi.fn(),
  returning: vi.fn(),
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { get: mocks.dbGet, create: mocks.dbCreate },
    request: mocks.securityPut,
    use: () => ({ insert: mocks.insert, createIndex: mocks.createIndex }),
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
  user: { id: "user.id", couchDbName: "user.couch_db_name" },
  COUCHDB_FEED_PREFIX: "feed_",
  COUCHDB_USER_STATE_PREFIX: "user-state_",
  COUCHDB_BOT_PREFIX: "bot_",
}))

const { ensureFeedDatabase, ensureUserStateDatabase } = await import("../couchdb/client")

/** 已登记的库名（24 位随机后缀） */
const EXISTING = `feed_${"a".repeat(24)}`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.returning.mockResolvedValue([{ id: "x" }])
  mocks.dbGet.mockResolvedValue({ db_name: "x" })
  mocks.securityPut.mockResolvedValue({ ok: true })
  mocks.insert.mockResolvedValue({ ok: true })
  mocks.createIndex.mockResolvedValue({ ok: true })
})

describe("resolveDatabase：库名已登记", () => {
  it("直接返回库名，一个 CouchDB 请求都不发", async () => {
    mocks.findFirst.mockResolvedValue({ couchDbName: EXISTING })

    expect(await ensureFeedDatabase("f1")).toBe(EXISTING)

    expect(mocks.dbGet).not.toHaveBeenCalled()
    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.createIndex).not.toHaveBeenCalled()
  })

  it("用户状态库同样走快路径（不再每次 createIndex ×3）", async () => {
    mocks.findFirst.mockResolvedValue({ couchDbName: "user-state_bbbbbbbbbbbbbbbbbbbbbbbb" })

    expect(await ensureUserStateDatabase("u1")).toBe("user-state_bbbbbbbbbbbbbbbbbbbbbbbb")

    expect(mocks.createIndex).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
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

  it("用户状态库建库时装索引，_security 只授权本人", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const dbName = await ensureUserStateDatabase("u1")

    expect(mocks.createIndex).toHaveBeenCalledTimes(3)
    expect(mocks.securityPut.mock.calls[0]![0]).toMatchObject({
      doc: "_security",
      body: { members: { names: ["u1"], roles: [] } },
    })
    expect(dbName).toMatch(/^user-state_[a-z0-9]{24}$/)
  })

  it("并发建库时（GET 成功但没库名）不重复写设计文档与索引", async () => {
    mocks.findFirst.mockResolvedValue(null)
    // 另一个请求已抢先建好库
    mocks.dbGet.mockResolvedValue({ db_name: "x" })

    await ensureFeedDatabase("f1")

    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
