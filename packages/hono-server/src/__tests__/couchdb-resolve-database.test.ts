import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 回归用例：库名解析与 owner 库设计文档。
 *
 * ## 库名解析的「快路径」
 *
 * 库名一旦登记在业务表上，抓取/查询条目/下发寻址等高频路径就只应查一次 PostgreSQL，
 * 不再碰 CouchDB —— 否则每个订阅每次都要多打一次 GET /db 和一次 PUT /_security。
 * 只有库名缺失（首次）时才建库、装设计文档、设授权、回写库名。
 *
 * ## 设计文档只有一份（`_design/main`）
 *
 * 用户库与 Bot 库结构相同，共用同一份设计文档；区别只有用户库多一个 `validate_doc_update`
 * 写方向闸门。旧模型有 `_design/main`（源库）与 `_design/timeline-maintain`（用户库）两份，
 * 那是「共享源库 + 复制」时代的产物 —— 现在已经没有源库了。
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
      bots: { findFirst: mocks.findFirst },
      user: { findFirst: mocks.findFirst },
    },
    update: () => ({
      set: () => ({ where: () => ({ returning: mocks.returning }) }),
    }),
  },
  bots: { id: "bots.id", couchDbName: "bots.couch_db_name" },
  user: { id: "user.id", couchDbName: "user.couch_db_name", timelineDbName: "user.timeline_db_name" },
  COUCHDB_BOT_PREFIX: "bot_",
  COUCHDB_USER_TIMELINE_PREFIX: "user-timeline_",
}))

const {
  ensureBotDatabase,
  ensureTimelineDatabase,
  ensureTimelineDesignDoc,
  ensureOwnerDesignDoc,
  OWNER_DESIGN_DOC_VIEWS,
  TIMELINE_VALIDATE_DOC_UPDATE,
} = await import("../couchdb/client")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.returning.mockResolvedValue([{ id: "x" }])
  mocks.dbGet.mockResolvedValue({ db_name: "x" })
  mocks.securityPut.mockResolvedValue({ ok: true })
  mocks.insert.mockResolvedValue({ ok: true })
  mocks.dbDestroy.mockResolvedValue({ ok: true })
})

/** 已到位的设计文档（用户库：带闸门与全部视图） */
const upToDateTimelineDoc = () => ({
  _id: "_design/main",
  _rev: "1-ok",
  validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
  views: OWNER_DESIGN_DOC_VIEWS,
})

describe("resolveDatabase：库名已登记", () => {
  it("Bot 库快路径只查一次设计文档：视图已在 → 不建库、不重设授权", async () => {
    // 每个用例用不同的库名：设计文档「已 ensure」是进程内缓存的，同名会跨用例串味
    const dbName = `bot_${"b".repeat(24)}`
    mocks.findFirst.mockResolvedValue({ couchDbName: dbName })
    mocks.dbGet.mockResolvedValue({ _id: "_design/main", _rev: "1-ok", views: OWNER_DESIGN_DOC_VIEWS })

    expect(await ensureBotDatabase("b1")).toBe(dbName)

    // 正好一次设计文档 GET（比对视图是否在位）；视图已在 → 一个写请求都不发
    expect(mocks.dbGet).toHaveBeenCalledTimes(1)
    expect(mocks.dbGet).toHaveBeenCalledWith("_design/main")
    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("存量 Bot 库补装视图：缺 by-feed-date 时带 _rev 覆盖一次，之后缓存命中不再查", async () => {
    const dbName = `bot_${"c".repeat(24)}`
    mocks.findFirst.mockResolvedValue({ couchDbName: dbName })
    mocks.dbGet.mockResolvedValue({
      _id: "_design/main",
      _rev: "2-old",
      views: { "some-legacy-view": { map: "function(doc){}" } },
    })

    await ensureBotDatabase("b2")
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const written = mocks.insert.mock.calls[0]![0] as {
      _rev?: string
      views?: Record<string, unknown>
    }
    expect(written._rev).toBe("2-old")
    // 覆盖时不能把老库已有的其它视图弄丢
    expect(Object.keys(written.views ?? {})).toEqual(
      expect.arrayContaining(["entries-by-date", "by-feed-date", "some-legacy-view"]),
    )

    mocks.dbGet.mockClear()
    mocks.insert.mockClear()
    await ensureBotDatabase("b2")
    expect(mocks.dbGet).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("用户库读的是 user.timeline_db_name 这一列，走同一条快路径", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: "user-timeline_cccccccccccccccccccccccc" })
    mocks.dbGet.mockResolvedValue(upToDateTimelineDoc())

    expect(await ensureTimelineDatabase("u1")).toBe("user-timeline_cccccccccccccccccccccccc")

    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.securityPut).not.toHaveBeenCalled()
  })

  /**
   * 只比闸门、不比视图是个真实的坑：视图是后加的（抓取完成后按 `[feedId, publishedAt]`
   * 逐源裁剪要用 `by-feed-date`），而存量库的闸门早就一致 —— 那样"视图还没装"的库会被
   * 当成已就位，裁剪查不到视图 → 404 → 整步被跳过（用户库只增不减、过期条目不清理）。
   */
  it("存量库缺新视图：闸门一致也照样带 _rev 覆盖装一次", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: `user-timeline_${"8".repeat(24)}` })
    mocks.dbGet.mockResolvedValue({
      _id: "_design/main",
      _rev: "3-old",
      validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
      // 老库：只有按发布时间排的那个视图（现在要的是按 [feedId, publishedAt] 排的）
      views: { "entries-by-date": { map: "function(doc){ emit(doc.publishedAt, null); }" } },
    })

    await ensureTimelineDatabase("u1")

    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const written = mocks.insert.mock.calls[0]![0] as { _rev?: string, views?: Record<string, unknown> }
    expect(written._rev).toBe("3-old")
    // 补上新视图（老视图保留：CouchDB 里多一个视图不影响正确性，删它反而要多一轮写）
    expect(Object.keys(written.views ?? {})).toEqual(
      expect.arrayContaining(["entries-by-date", "by-feed-date"]),
    )
  })

  it("并发建库：没抢到库名的一方删掉自己刚建的空库，改用赢家的库（否则订阅会写进没人指得着的孤儿库）", async () => {
    const winner = `bot_${"e".repeat(24)}`
    // 第一次 findFirst（解析前查列）没有库名；认领失败后回读，拿到赢家的库名
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ couchDbName: winner })
    // 认领失败：条件更新（列还是空才写）没写到任何行
    mocks.returning.mockResolvedValue([])
    mocks.dbGet.mockRejectedValueOnce(new Error("not_found")).mockResolvedValue({
      _id: "_design/main",
      _rev: "1-ok",
      views: OWNER_DESIGN_DOC_VIEWS,
    })

    const name = await ensureBotDatabase("b-race")

    expect(name).toBe(winner)
    expect(mocks.dbDestroy).toHaveBeenCalledTimes(1)
    expect(String(mocks.dbDestroy.mock.calls[0]![0])).toMatch(/^bot_/)
    expect(String(mocks.dbDestroy.mock.calls[0]![0])).not.toBe(winner)
  })

  it("用户库快路径同样会补装闸门：老库（设计文档缺闸门）带 _rev 覆盖一次，之后不再查", async () => {
    mocks.findFirst.mockResolvedValue({ timelineDbName: `user-timeline_${"9".repeat(24)}` })
    // 老库的设计文档存在但没有闸门
    mocks.dbGet.mockResolvedValue({ _id: "_design/main", _rev: "2-old", views: {} })

    await ensureTimelineDatabase("u1")
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({
      _rev: "2-old",
      validate_doc_update: expect.stringContaining("forbidden"),
    })

    // 第二次调用：进程内缓存命中，连设计文档都不再查
    mocks.dbGet.mockClear()
    mocks.insert.mockClear()
    await ensureTimelineDatabase("u1")
    expect(mocks.dbGet).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

describe("resolveDatabase：库名缺失（首次）", () => {
  it("建 Bot 库 + 装设计文档 + 设 _security + 回写库名", async () => {
    mocks.findFirst.mockResolvedValue(null)
    // 库不存在：GET 抛错才会走到 create 分支
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const dbName = await ensureBotDatabase("b1")

    expect(dbName).toMatch(/^bot_[a-z0-9]{24}$/)
    expect(mocks.dbCreate).toHaveBeenCalledWith(dbName)
    // Bot 库的设计文档装两个视图，**不装闸门**（Bot 库没有客户端写入口）
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const designDoc = mocks.insert.mock.calls[0]![0] as {
      views?: Record<string, unknown>
      validate_doc_update?: string
    }
    expect(Object.keys(designDoc.views ?? {})).toEqual(
      expect.arrayContaining(["entries-by-date", "by-feed-date"]),
    )
    expect(designDoc.validate_doc_update).toBeUndefined()
    // 库级 _security：Bot 库放行 user 角色
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

    await ensureBotDatabase("b1")

    expect(mocks.dbCreate).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it("用户库建库时装「视图 + 写方向闸门」，_security 只授权本人", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const dbName = await ensureTimelineDatabase("u1")

    expect(dbName).toMatch(/^user-timeline_[a-z0-9]{24}$/)
    expect(mocks.dbCreate).toHaveBeenCalledWith(dbName)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({
      _id: "_design/main",
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
   * 闸门是后加的 —— 「只在新库安装」会让老库永久裸奔，所以 ensure 侧必须比对并覆盖。
   * 这里直接调 ensureTimelineDesignDoc（导出给测试用）。
   */
  it("设计文档缺闸门时带 _rev 覆盖；已带闸门时不再写", async () => {
    const dbName = `user-timeline_${"e".repeat(24)}`

    // 老库：设计文档存在，但没有 validate_doc_update
    mocks.dbGet.mockResolvedValue({ _id: "_design/main", _rev: "3-old", views: {} })
    await ensureTimelineDesignDoc(dbName)
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({ _rev: "3-old", _id: "_design/main" })

    // 同一个库第二次调用：进程内缓存命中，不再写入
    mocks.insert.mockClear()
    await ensureTimelineDesignDoc(dbName)
    expect(mocks.insert).not.toHaveBeenCalled()

    // 另一个库：设计文档已带同样的闸门与视图 → 读到即返回，不覆盖
    const other = `user-timeline_${"f".repeat(24)}`
    mocks.dbGet.mockResolvedValue({ ...upToDateTimelineDoc(), _rev: "4-ok" })
    await ensureTimelineDesignDoc(other)
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

/**
 * 业务行不存在时，同一个 refId 必须稳定拿到同一个库。
 *
 * 这是实机验证抓出来的真 bug：`claimCouchDbName` 没有可持久化的行，每次调用都生成一个
 * 新的随机库名 —— 于是"写进 A 库、读从 B 库"，条目永远读不回来
 * （实测：抓取写入 5 条，按名字再查是 0 条）。
 *
 * 正常路径不会走到这里（真实用户 / Bot 在业务表里都有行），但排障文档里有一条
 * 「把该行的库名置空以重建」，那时就会短暂处于这个状态。
 */
describe("业务行不存在（认领不到库名）", () => {
  it("同一个 refId 两次调用拿到同一个库（进程内备忘）", async () => {
    const { ensureBotDatabase } = await import("../couchdb/client")
    // 行不存在：条件更新一条都没写到，回读也是空
    mocks.findFirst.mockResolvedValue(null)
    mocks.returning.mockResolvedValue([])
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const first = await ensureBotDatabase("row-missing-bot")
    const second = await ensureBotDatabase("row-missing-bot")

    expect(second).toBe(first)
    // 也不该把自己刚建的库删掉：删掉的话调用方拿着一个不存在的库名
    expect(mocks.dbDestroy).not.toHaveBeenCalled()
  })

  it("不同的 refId 互不影响", async () => {
    const { ensureBotDatabase } = await import("../couchdb/client")
    mocks.findFirst.mockResolvedValue(null)
    mocks.returning.mockResolvedValue([])
    mocks.dbGet.mockRejectedValue(new Error("not_found"))

    const a = await ensureBotDatabase("bot-a-missing")
    const b = await ensureBotDatabase("bot-b-missing")
    expect(a).not.toBe(b)
  })
})

/**
 * 设计文档写失败（CouchDB 的 JS 查询服务忙/卡死时是 500）**不能**被当成"已就位"缓存下来。
 *
 * 缓存下来就等于这个进程往后每轮都忘记补装：用户库缺 `by-feed-date` 视图 →
 * 抓取完成后的按源裁剪每轮 404（过期条目永不清理）。表现为「库只增不减」，且没有日志信号。
 */
describe("设计文档写失败不进缓存", () => {
  const internalServerError = () => Object.assign(new Error("internal_server_error"), { statusCode: 500 })

  it("用户库设计文档写失败：告警、返回 false，下一次调用会重试", async () => {
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

  it("Bot 库设计文档写失败：告警、返回 false；失败不进缓存，下次重试", async () => {
    const dbName = `bot_${"g".repeat(24)}`
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.dbGet.mockRejectedValue(new Error("not_found"))
    mocks.insert.mockRejectedValueOnce(internalServerError())

    expect(await ensureOwnerDesignDoc(dbName)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dbName))

    mocks.insert.mockResolvedValue({ ok: true })
    expect(await ensureOwnerDesignDoc(dbName)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledTimes(2)
    // 装好之后才进缓存：第三次不再写
    expect(await ensureOwnerDesignDoc(dbName)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("并发 ensure 撞出的 409 视为到位（不再重写）", async () => {
    const dbName = `bot_${"h".repeat(24)}`
    mocks.dbGet.mockRejectedValue(new Error("not_found"))
    mocks.insert.mockRejectedValueOnce(Object.assign(new Error("conflict"), { statusCode: 409 }))

    expect(await ensureOwnerDesignDoc(dbName)).toBe(true)
    expect(await ensureOwnerDesignDoc(dbName)).toBe(true)
    // 第一次 409（被当成到位）、第二次缓存命中 → 只写了一次
    expect(mocks.insert).toHaveBeenCalledTimes(1)
  })
})
