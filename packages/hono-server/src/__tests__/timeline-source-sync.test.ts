import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 按需同步的水位线：**"这个源这次要不要搬"** 的判定与单个源的同步过程。
 *
 * 这是聚合链路的核心：以前每个 (用户 × 源) 一条**常驻**复制，机器被 600+ 条任务压死；
 * 现在只在"源那边上次同步之后有过新内容"时才跑一次**一次性**复制。判定错了的两个方向
 * 代价不对称：
 *   - 多判一次：一条空转复制（实测 ~1.3s），可接受；
 *   - 少判一次：那条内容**永远不会**进聚合库（除非该源以后再出新条目），不可接受。
 * 所以规则一律偏保守，其中最阴的一条是 `syncedAt` 必须取"同步**开始**时刻"（见下）。
 *
 * 复制**不带任何参数**（保留策略的唯一权威是源库裁剪），所以"换窗口 / 换保底条数"这类
 * 判据已经不存在了：同一个源的复制过滤器哈希恒定，checkpoint 自然续跑。
 */
const mocks = vi.hoisted(() => ({
  /** `subscription:<sourceId>` 文档（null = 已退订，get 抛 404） */
  subscription: { kind: "feed" } as { kind?: string } | null,
  /** 已有水位行 */
  watermarks: [] as Array<Record<string, unknown>>,
  /** runSourceReplication 的调用参数 */
  replicationCalls: [] as Array<Record<string, unknown>>,
  replicationResult: { docsWritten: 5, sourceLastSeq: "12-abc", elapsedMs: 42 },
  replicationError: null as Error | null,
  /** 写库记录 */
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock("../db", () => {
  const table = (name: string, extra: Record<string, unknown> = {}) => ({ __name: name, ...extra })
  return {
    db: {
      select: () => ({
        from: (t: { __name?: string }) => {
          // 单测里只有 timelineSourceSync 会被读（读水位行）
          const rows = t?.__name === "timelineSourceSync" ? mocks.watermarks : []
          const chain = {
            where: () => chain,
            limit: async () => rows,
          }
          return chain
        },
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: async (conflict: { set?: Record<string, unknown> }) => {
            mocks.inserts.push({ ...values, ...(conflict?.set ?? {}) })
            return []
          },
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            mocks.updates.push(values)
            return []
          },
        }),
      }),
      delete: () => ({ where: async () => [] }),
      query: { user: { findFirst: async () => ({ timelineDbName: "user-timeline_u1" }) } },
    },
    user: table("user"),
    userTimelineSettings: table("userTimelineSettings"),
    timelineSourceSync: table("timelineSourceSync", {
      userId: "user_id",
      sourceId: "source_id",
      syncedAt: "synced_at",
      status: "status",
      sourceSeq: "source_seq",
      lastError: "last_error",
    }),
    feeds: table("feeds"),
    bots: table("bots"),
  }
})

vi.mock("../couchdb/client", () => ({
  ensureTimelineDatabase: async () => "user-timeline_u1",
  ensureFeedDatabase: async (feedId: string) => `feed_${feedId}`,
  ensureBotDatabase: async (botId: string) => `bot_${botId}`,
  createTimelineDatabase: async () => "user-timeline_u1",
  nanoServer: { db: { destroy: async () => {} }, request: async () => ({}) },
  createCouchDb: () => ({
    get: async (id: string) => {
      // syncSubscriptionSource 只读 `subscription:<sourceId>`：读不到 = 这期间被退订
      if (!mocks.subscription) throw Object.assign(new Error("not_found"), { statusCode: 404 })
      return { _id: id, ...mocks.subscription }
    },
  }),
}))

vi.mock("../couchdb/replicator", () => ({
  purgeLegacyReplications: async () => 0,
  runSourceReplication: async (spec: Record<string, unknown>) => {
    mocks.replicationCalls.push(spec)
    if (mocks.replicationError) throw mocks.replicationError
    return mocks.replicationResult
  },
}))

const { sourceNeedsSync, syncSubscriptionSource } = await import("../services/timeline")

const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms)

beforeEach(() => {
  mocks.subscription = { kind: "feed" }
  mocks.watermarks = []
  mocks.replicationCalls = []
  mocks.replicationResult = { docsWritten: 5, sourceLastSeq: "12-abc", elapsedMs: 42 }
  mocks.replicationError = null
  mocks.inserts = []
  mocks.updates = []
})

describe("sourceNeedsSync：脏源判定", () => {
  it("没有水位行（新订阅 / 第一次同步）→ 要搬", () => {
    expect(sourceNeedsSync({ watermark: undefined, sourceUpdatedAt: null })).toBe(true)
  })

  it("上次同步没成功（syncedAt 为空，失败时我们就是这么写的）→ 要搬", () => {
    expect(sourceNeedsSync({
      watermark: { syncedAt: null },
      sourceUpdatedAt: null,
    })).toBe(true)
  })

  it("源在上次同步开始之后有新内容 → 要搬", () => {
    expect(sourceNeedsSync({
      watermark: { syncedAt: ago(2 * HOUR) },
      sourceUpdatedAt: ago(HOUR),
    })).toBe(true)
  })

  it("源那边没动静（或从没记过新内容时间）→ 不搬，连一次复制请求都不发", () => {
    const watermark = { syncedAt: ago(2 * HOUR) }
    expect(sourceNeedsSync({ watermark, sourceUpdatedAt: ago(3 * HOUR) })).toBe(false)
    expect(sourceNeedsSync({ watermark, sourceUpdatedAt: null })).toBe(false)
    // 恰好相等（同一毫秒落库）也不搬：复制已经把那一刻之前的变更读过了
    expect(sourceNeedsSync({ watermark, sourceUpdatedAt: watermark.syncedAt })).toBe(false)
  })

  /**
   * 最阴的一条：抓取 worker 在复制**进行中**写入的条目，它的 lastChangedAt 晚于复制的
   * 开始时刻、但早于复制的结束时刻。若 syncedAt 记"完成时刻"，这条就会被判成"已同步过"
   * 而永久漏掉（源以后不再出新条目的话）。记"开始时刻"则它一定还脏，下一轮补上。
   */
  it("复制进行中写入的条目不会被误判成已同步（syncedAt 必须是开始时刻）", () => {
    const replicationStart = ago(HOUR)
    const entryWrittenDuringReplication = ago(HOUR - 1000) // 比开始时刻晚、比结束时刻早
    expect(sourceNeedsSync({
      watermark: { syncedAt: replicationStart },
      sourceUpdatedAt: entryWrittenDuringReplication,
    })).toBe(true)
  })
})

describe("syncSubscriptionSource：单个源的按需同步", () => {
  it("首次同步：先写 syncing 水位，搬完落 idle + 源库序号（rebound）", async () => {
    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls).toHaveLength(1)
    // 复制只带源库与目标库：没有任何 query_params / 下界
    expect(mocks.replicationCalls[0]).toEqual({
      sourceDb: "feed_feed1",
      targetDb: "user-timeline_u1",
    })
    // 先写"正在同步"（syncedAt = 开始时刻），再在成功后落 idle
    expect(mocks.inserts[0]).toMatchObject({
      userId: "u1", sourceId: "feed1", status: "syncing",
    })
    expect(mocks.updates).toEqual([expect.objectContaining({ status: "idle", sourceSeq: "12-abc", lastError: null })])
    // 水位记的是开始时刻，不是完成时刻
    expect(mocks.updates[0]!.syncedAt).toBe(mocks.inserts[0]!.syncedAt)

    expect(result).toMatchObject({ sourceId: "feed1", docsWritten: 5, rebound: true })
  })

  it("已有水位再同步：照常搬一次，但不再是首搬（rebound=false）", async () => {
    mocks.watermarks = [{
      sourceId: "feed1",
      syncedAt: ago(2 * HOUR), status: "idle", sourceSeq: "10-a", lastError: null,
    }]

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls[0]).toEqual({
      sourceDb: "feed_feed1",
      targetDb: "user-timeline_u1",
    })
    expect(result.rebound).toBe(false)
  })

  it("bot 源走 bot 产出库（`bot:` 前缀只是源 id 的一部分）", async () => {
    mocks.subscription = { kind: "bot" }

    await syncSubscriptionSource({ userId: "u1", sourceId: "bot:b9" })

    expect(mocks.replicationCalls[0]).toMatchObject({
      sourceDb: "bot_b9",
      targetDb: "user-timeline_u1",
    })
  })

  it("排队期间被退订：跳过，既不复制也不动水位（否则会把刚清理掉的内容搬回来）", async () => {
    mocks.subscription = null

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(result.skipped).toBe("unsubscribed")
    expect(mocks.replicationCalls).toEqual([])
    expect(mocks.inserts).toEqual([])
    expect(mocks.updates).toEqual([])
  })

  it("复制失败：水位清空 + 记 lastError 并抛出去（下一轮一定还是脏源，队列也会重试）", async () => {
    mocks.replicationError = new Error("CouchDB 忙")

    await expect(syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })).rejects.toThrow("CouchDB 忙")

    expect(mocks.updates).toEqual([expect.objectContaining({ syncedAt: null, status: "error" })])
    expect(String(mocks.updates[0]!.lastError)).toContain("CouchDB 忙")
  })
})
