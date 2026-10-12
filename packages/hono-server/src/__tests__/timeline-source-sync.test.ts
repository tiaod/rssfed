import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 按需同步的水位线：**"这个源这次要不要搬"** 的判定与单个源的同步过程。
 *
 * 这是本次改造的核心：以前每个 (用户 × 源) 一条**常驻**复制，机器被 600+ 条任务压死；
 * 现在只在"源那边上次同步之后有过新内容"时才跑一次**一次性**复制。判定错了的两个方向
 * 代价不对称：
 *   - 多判一次：一条空转复制（实测 ~1.3s），可接受；
 *   - 少判一次：那条内容**永远不会**进聚合库（除非该源以后再出新条目），不可接受。
 * 所以规则一律偏保守，其中最阴的一条是 `syncedAt` 必须取"同步**开始**时刻"（见下）。
 */
const mocks = vi.hoisted(() => ({
  settingsWindowDays: 3,
  settingsMinEntries: 0,
  /** `subscription:<sourceId>` 文档（null = 已退订，get 抛 404） */
  subscription: { kind: "feed" } as { kind?: string } | null,
  /** 已有水位行 */
  watermarks: [] as Array<Record<string, unknown>>,
  /** 源库 `entries-by-date` 倒序取 N 行时返回的行（决定下界 + 必须留住的条目清单） */
  sourceViewRows: [] as Array<{ id: string, key: unknown }>,
  /** 源库里这些条目的文档（恢复被剪掉的条目时按 id 取回来，附件一并带上） */
  sourceDocs: {} as Record<string, Record<string, unknown>>,
  /** 用户库里这些 id 的状态：deleted = true 就是被剪掉的 tombstone */
  userDocs: {} as Record<string, { rev: string, deleted?: boolean }>,
  /** target.bulk 收到的写请求（恢复用） */
  bulkCalls: [] as Array<Array<Record<string, unknown>>>,
  /** 让 bulk 抛错（验证恢复失败不影响整次同步） */
  bulkError: null as Error | null,
  /** bulk(new_edits:false) 的响应：只放"失败"的那些 */
  bulkFailures: [] as Array<{ id: string, error?: string, reason?: string }>,
  /** bulk 是不是以 new_edits:false 发的（缺了它复活 tombstone 会被 CouchDB 拒） */
  bulkNewEdits: [] as Array<boolean | undefined>,
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
          const rows = t?.__name === "userTimelineSettings"
            ? [{ windowDays: mocks.settingsWindowDays, minFeedEntries: mocks.settingsMinEntries, aiSummaryEnabled: false }]
            : t?.__name === "timelineSourceSync" ? mocks.watermarks : []
          const chain = {
            where: () => chain,
            limit: async () => rows,
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
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
      userId: "user_id", sourceId: "source_id", windowDays: "window_days", minEntries: "min_entries",
      boundIso: "bound_iso",
      syncedAt: "synced_at", status: "status", sourceSeq: "source_seq", lastError: "last_error",
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
      // 条目文档（恢复路径）与订阅文档走同一个 scope，用前缀区分
      if (id.startsWith("entry:")) {
        const doc = mocks.sourceDocs[id]
        if (!doc) throw Object.assign(new Error("not_found"), { statusCode: 404 })
        return { _id: id, ...doc }
      }
      if (!mocks.subscription) throw Object.assign(new Error("not_found"), { statusCode: 404 })
      return { _id: id, ...mocks.subscription }
    },
    info: async () => ({ update_seq: 0 }),
    // 源库 entries-by-date 视图（倒序取 N 行 → 下界 + 必须留住的清单）
    view: async () => ({ rows: mocks.sourceViewRows }),
    // 用户库 `_all_docs?keys=`：活着 / tombstone / 从来没有过
    fetch: async ({ keys }: { keys: string[] }) => ({
      rows: keys.map(key => mocks.userDocs[key]
        ? { id: key, key, value: mocks.userDocs[key] }
        : { id: key, key, error: "not_found" }),
    }),
    bulk: async (
      { docs, new_edits }: { docs: Array<Record<string, unknown>>, new_edits?: boolean },
    ) => {
      if (mocks.bulkError) throw mocks.bulkError
      mocks.bulkCalls.push(docs)
      mocks.bulkNewEdits.push(new_edits)
      // 真机行为一：**只有 new_edits:false 才能把 tombstone 写成活文档**。缺了它 CouchDB
      // 会拒（3.x 不允许"复活"已删除文档），这里照实模拟，避免哪天被悄悄改回去。
      if (new_edits !== false) {
        return docs.map(doc => ({ id: String(doc._id), error: "conflict", reason: "Document update conflict." }))
      }
      for (const doc of docs) mocks.userDocs[String(doc._id)] = { rev: String(doc._rev) }
      // 真机行为二：`new_edits: false` 的响应**只报失败**，全成功时是空数组
      return mocks.bulkFailures
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
  mocks.settingsWindowDays = 3
  mocks.settingsMinEntries = 0
  mocks.subscription = { kind: "feed" }
  mocks.watermarks = []
  mocks.sourceViewRows = []
  mocks.sourceDocs = {}
  mocks.userDocs = {}
  mocks.bulkCalls = []
  mocks.bulkError = null
  mocks.bulkFailures = []
  mocks.bulkNewEdits = []
  mocks.replicationCalls = []
  mocks.replicationResult = { docsWritten: 5, sourceLastSeq: "12-abc", elapsedMs: 42 }
  mocks.replicationError = null
  mocks.inserts = []
  mocks.updates = []
})

describe("sourceNeedsSync：脏源判定", () => {
  it("没有水位行（新订阅 / 第一次同步）→ 要搬", () => {
    expect(sourceNeedsSync({ watermark: undefined, windowDays: 3, minEntries: 0, sourceUpdatedAt: null })).toBe(true)
  })

  it("上次同步没成功（syncedAt 为空，失败时我们就是这么写的）→ 要搬", () => {
    expect(sourceNeedsSync({
      watermark: { windowDays: 3, minEntries: 0, syncedAt: null },
      windowDays: 3,
      minEntries: 0,
      sourceUpdatedAt: null,
    })).toBe(true)
  })

  it("水位记的窗口与当前设置不一致（换窗口）→ 要搬（要重算下界 = 换哈希 = 重扫回填）", () => {
    expect(sourceNeedsSync({
      watermark: { windowDays: 3, minEntries: 0, syncedAt: ago(2 * HOUR) },
      windowDays: 7,
      minEntries: 0,
      sourceUpdatedAt: null,
    })).toBe(true)
  })

  it("水位记的保底条数与当前设置不一致（改「每源至少 N 条」）→ 要搬（否则低频源永远不回填）", () => {
    expect(sourceNeedsSync({
      watermark: { windowDays: 3, minEntries: 0, syncedAt: ago(2 * HOUR) },
      windowDays: 3,
      minEntries: 50,
      sourceUpdatedAt: null,
    })).toBe(true)
    expect(sourceNeedsSync({
      watermark: { windowDays: 3, minEntries: 50, syncedAt: ago(2 * HOUR) },
      windowDays: 3,
      minEntries: 0,
      sourceUpdatedAt: null,
    })).toBe(true)
  })

  it("源在上次同步开始之后有新内容 → 要搬", () => {
    expect(sourceNeedsSync({
      watermark: { windowDays: 3, minEntries: 0, syncedAt: ago(2 * HOUR) },
      windowDays: 3,
      minEntries: 0,
      sourceUpdatedAt: ago(HOUR),
    })).toBe(true)
  })

  it("源那边没动静（或从没记过新内容时间）→ 不搬，连一次复制请求都不发", () => {
    const watermark = { windowDays: 3, minEntries: 50, syncedAt: ago(2 * HOUR) }
    expect(sourceNeedsSync({ watermark, windowDays: 3, minEntries: 50, sourceUpdatedAt: ago(3 * HOUR) })).toBe(false)
    expect(sourceNeedsSync({ watermark, windowDays: 3, minEntries: 50, sourceUpdatedAt: null })).toBe(false)
    // 恰好相等（同一毫秒落库）也不搬：复制已经把那一刻之前的变更读过了
    expect(sourceNeedsSync({ watermark, windowDays: 3, minEntries: 50, sourceUpdatedAt: watermark.syncedAt })).toBe(false)
  })

  /**
   * 最阴的一条：抓取 worker 在复制**进行中**写入的条目，它的 lastNewEntryAt 晚于复制的
   * 开始时刻、但早于复制的结束时刻。若 syncedAt 记"完成时刻"，这条就会被判成"已同步过"
   * 而永久漏掉（源以后不再出新条目的话）。记"开始时刻"则它一定还脏，下一轮补上。
   */
  it("复制进行中写入的条目不会被误判成已同步（syncedAt 必须是开始时刻）", () => {
    const replicationStart = ago(HOUR)
    const entryWrittenDuringReplication = ago(HOUR - 1000) // 比开始时刻晚、比结束时刻早
    expect(sourceNeedsSync({
      watermark: { windowDays: 3, minEntries: 0, syncedAt: replicationStart },
      windowDays: 3,
      minEntries: 0,
      sourceUpdatedAt: entryWrittenDuringReplication,
    })).toBe(true)
  })
})

describe("syncSubscriptionSource：单个源的按需同步", () => {
  it("首次同步：先写 syncing 水位，搬完落 idle + 源库序号；窗口下界按当前设置新算（rebound）", async () => {
    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls).toHaveLength(1)
    expect(mocks.replicationCalls[0]).toMatchObject({
      sourceDb: "feed_feed1",
      targetDb: "user-timeline_u1",
    })
    // 没开保底条数 → 下界就是窗口下界（一个 ISO 字符串）
    expect(typeof mocks.replicationCalls[0]!.boundIso).toBe("string")
    // 先写"正在同步"（syncedAt = 开始时刻），再在成功后落 idle
    expect(mocks.inserts[0]).toMatchObject({
      userId: "u1", sourceId: "feed1", windowDays: 3, minEntries: 0, status: "syncing",
    })
    expect(mocks.updates).toEqual([expect.objectContaining({ status: "idle", sourceSeq: "12-abc", lastError: null })])
    // 水位记的是开始时刻，不是完成时刻
    expect(mocks.updates[0]!.syncedAt).toBe(mocks.inserts[0]!.syncedAt)

    expect(result).toMatchObject({ sourceId: "feed1", docsWritten: 5, rebound: true })
  })

  it("同窗口再同步：沿用已存的下界（下界一变就是新哈希 = 每次同步都全量重扫）", async () => {
    mocks.watermarks = [{
      sourceId: "feed1", windowDays: 3, minEntries: 0, boundIso: "2025-01-07T00:00:00.000Z",
      syncedAt: ago(2 * HOUR), status: "idle", sourceSeq: "10-a", lastError: null,
    }]

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls[0]).toMatchObject({ boundIso: "2025-01-07T00:00:00.000Z" })
    expect(result.rebound).toBe(false)
  })

  it("换窗口：重算下界（下界变松靠它从 0 重扫回填历史）", async () => {
    mocks.settingsWindowDays = 7
    mocks.watermarks = [{
      sourceId: "feed1", windowDays: 3, minEntries: 0, boundIso: "2025-01-07T00:00:00.000Z",
      syncedAt: ago(2 * HOUR), status: "idle", sourceSeq: "10-a", lastError: null,
    }]

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(result.rebound).toBe(true)
    expect(mocks.replicationCalls[0]!.boundIso).not.toBe("2025-01-07T00:00:00.000Z")
  })

  /**
   * 保底条数的主场景：低频源最新的一条也在窗口之外 → 下界要取「该源第 N 新的那条的发布时间」，
   * 而不是窗口下界。这正是"这个订阅没有内容"那个 bug 的修法。
   */
  it("开了保底条数：下界取该源第 N 新的发布时间（比窗口更松 → 从 0 重扫回填）", async () => {
    mocks.settingsMinEntries = 3
    mocks.sourceViewRows = [
      { id: "entry:f1:c", key: "2026-09-27T16:00:00.000Z" },
      { id: "entry:f1:b", key: "2026-09-22T16:00:00.000Z" },
      { id: "entry:f1:a", key: "2026-09-13T16:00:00.000Z" },
    ]

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls[0]).toMatchObject({ boundIso: "2026-09-13T16:00:00.000Z" })
    expect(mocks.inserts[0]).toMatchObject({ minEntries: 3, boundIso: "2026-09-13T16:00:00.000Z" })
    expect(result.rebound).toBe(true)
  })

  it("开了保底条数但源里不足 N 条：下界为 null = 整个源都留（一篇都不许丢）", async () => {
    mocks.settingsMinEntries = 50
    mocks.sourceViewRows = [
      { id: "entry:f1:b", key: "2026-09-27T16:00:00.000Z" },
      { id: "entry:f1:a", key: "2026-05-26T16:00:00.000Z" },
    ]

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls[0]!.boundIso).toBeNull()
    expect(result.rebound).toBe(true)
  })

  it("窗口不限时间：下界为 null，且不必去问源库要第 N 新", async () => {
    mocks.settingsWindowDays = 0
    mocks.settingsMinEntries = 50
    mocks.sourceViewRows = [{ id: "entry:f1:a", key: "2026-05-26T16:00:00.000Z" }]

    await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls[0]!.boundIso).toBeNull()
  })

  /**
   * 稳态「只放不收」：保底条数会随新条目把折算下界往前推（下界变紧）。下界变紧对"内容已经在
   * 库里"没有任何好处，却会换哈希、丢 checkpoint，让整个源库每来一条新内容就重扫一遍 ——
   * 所以已存的下界更松时必须原样保留。
   */
  it("稳态只放不收：候选下界变紧时沿用已存的（否则每来一条新内容就全量重扫）", async () => {
    mocks.settingsMinEntries = 3
    mocks.watermarks = [{
      sourceId: "feed1", windowDays: 3, minEntries: 3, boundIso: "2020-01-01T00:00:00.000Z",
      syncedAt: ago(2 * HOUR), status: "idle", sourceSeq: "10-a", lastError: null,
    }]
    mocks.sourceViewRows = [
      { id: "entry:f1:c", key: "2026-09-27T16:00:00.000Z" },
      { id: "entry:f1:b", key: "2026-09-22T16:00:00.000Z" },
      { id: "entry:f1:a", key: "2026-09-13T16:00:00.000Z" },
    ]

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.replicationCalls[0]).toMatchObject({ boundIso: "2020-01-01T00:00:00.000Z" })
    expect(result.rebound).toBe(false)
  })

  it("改保底条数（0 → 50）：下界重算并重扫（回填低频源的历史）", async () => {
    mocks.settingsMinEntries = 50
    mocks.watermarks = [{
      sourceId: "feed1", windowDays: 3, minEntries: 0, boundIso: "2025-01-07T00:00:00.000Z",
      syncedAt: ago(2 * HOUR), status: "idle", sourceSeq: "10-a", lastError: null,
    }]
    mocks.sourceViewRows = Array.from({ length: 50 }, (_, index) => ({
      id: `entry:f1:${index}`,
      // 倒序取 N 行的最后一行 = 第 N 新（这里第 50 新）
      key: index === 49 ? "2026-05-01T00:00:00.000Z" : "2026-09-30T00:00:00.000Z",
    }))

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(result.rebound).toBe(true)
    expect(mocks.replicationCalls[0]!.boundIso).toBe("2026-05-01T00:00:00.000Z")
  })

  it("bot 源走 bot 产出库（`bot:` 前缀只是源 id 的一部分），保底条数同样生效", async () => {
    mocks.subscription = { kind: "bot" }
    mocks.settingsMinEntries = 3
    // bot 库与 feed 库装的是同一份设计文档（`entries-by-date` + 复制过滤器），视图名一致
    mocks.sourceViewRows = [
      { id: "entry:bot:b9:c", key: "2026-09-27T16:00:00.000Z" },
      { id: "entry:bot:b9:b", key: "2026-09-22T16:00:00.000Z" },
      { id: "entry:bot:b9:a", key: "2026-09-13T16:00:00.000Z" },
    ]

    await syncSubscriptionSource({ userId: "u1", sourceId: "bot:b9" })

    expect(mocks.replicationCalls[0]).toMatchObject({
      sourceDb: "bot_b9",
      boundIso: "2026-09-13T16:00:00.000Z",
    })
  })

  it("排队期间被退订：跳过，既不复制品也不动水位（否则会把刚清理掉的内容搬回来）", async () => {
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

/**
 * 复制是**变更投递**而不是投影：目标端删过的 rev 还在它的修订树里，`_revs_diff` 会说"我有"，
 * 复制器于是永远不再送。放宽窗口 / 调高保底条数时，源库里早就被剪掉的那些条目正好卡在这个死角
 * —— 不自己补一遍，用户看到的就是"设置调了还是没内容"（实测：源里 10 篇，用户库 3 篇
 * + 7 个 tombstone）。所以保底清单里凡是用户库里是 tombstone 的，都按 tombstone 的 rev 写回。
 */
describe("恢复被剪掉的保底条目", () => {
  const floorRows = [
    { id: "entry:f1:c", key: "2026-09-27T16:00:00.000Z" },
    { id: "entry:f1:b", key: "2026-09-22T16:00:00.000Z" },
    { id: "entry:f1:a", key: "2026-09-13T16:00:00.000Z" },
  ]

  it("tombstone 的条目按它的 rev 写回去，附件（base64 内联）一并带上", async () => {
    mocks.settingsMinEntries = 3
    mocks.sourceViewRows = floorRows
    mocks.userDocs = {
      "entry:f1:c": { rev: "1-ccc" }, // 活着 → 不碰
      "entry:f1:b": { rev: "2-dead", deleted: true }, // 被剪掉的 → 救回来
      // entry:f1:a 从来没有过 → 交给复制器的重扫，不自己搬
    }
    mocks.sourceDocs = {
      "entry:f1:b": {
        publishedAt: "2026-09-22T16:00:00.000Z",
        title: "被剪掉的那篇",
        _attachments: { "img-0.avif": { content_type: "image/avif", data: "AAAA" } },
      },
    }

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.bulkCalls).toHaveLength(1)
    const written = mocks.bulkCalls[0]![0]!
    expect(written).toMatchObject({
      _id: "entry:f1:b",
      title: "被剪掉的那篇",
      _attachments: { "img-0.avif": { content_type: "image/avif", data: "AAAA" } },
      // 新修订的代次 = tombstone 的代次 + 1，谱系接在 tombstone 上（CouchDB 3.x 不接受
      // 拿 tombstone 的 rev 直接 PUT 复活，只能用 new_edits:false 声明谱系）
      _revisions: { start: 3, ids: [expect.stringMatching(/^[0-9a-f]{32}$/), "dead"] },
    })
    expect(String(written._rev)).toMatch(/^3-[0-9a-f]{32}$/)
    // 必须用 new_edits:false：否则 CouchDB 3.x 直接 409（本文件上方的注释与 mock 都照实模拟）
    expect(mocks.bulkNewEdits).toEqual([false])
    expect(result.restoredEntries).toBe(1)
  })

  it("没有 tombstone 时一个写请求都不发（绝大多数同步都是这种）", async () => {
    mocks.settingsMinEntries = 3
    mocks.sourceViewRows = floorRows
    mocks.userDocs = {
      "entry:f1:c": { rev: "1-c" },
      "entry:f1:b": { rev: "1-b" },
      // a 没有 → not_found（"从来没有过"），也不该自己搬
    }
    mocks.sourceDocs = { "entry:f1:a": { publishedAt: "2026-09-13T16:00:00.000Z" } }

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.bulkCalls).toEqual([])
    expect(result.restoredEntries).toBe(0)
  })

  it("保底条数关闭时不查「必须留住」的清单（没有这个要求）", async () => {
    mocks.settingsMinEntries = 0
    mocks.sourceViewRows = floorRows
    mocks.userDocs = { "entry:f1:b": { rev: "2-dead", deleted: true } }

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(mocks.bulkCalls).toEqual([])
    expect(result.restoredEntries).toBe(0)
  })

  it("恢复失败不让整次同步算失败（内容已由复制搬过，水位照常推进、下轮再试）", async () => {
    mocks.settingsMinEntries = 3
    mocks.sourceViewRows = floorRows
    mocks.userDocs = { "entry:f1:b": { rev: "2-dead", deleted: true } }
    mocks.sourceDocs = { "entry:f1:b": { publishedAt: "2026-09-22T16:00:00.000Z" } }
    mocks.bulkError = new Error("CouchDB 忙")

    const result = await syncSubscriptionSource({ userId: "u1", sourceId: "feed1" })

    expect(result.restoredEntries).toBe(0)
    expect(result.docsWritten).toBe(5)
    expect(mocks.updates).toEqual([expect.objectContaining({ status: "idle" })])
  })
})
