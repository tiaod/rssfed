import { describe, expect, it, vi } from "vitest"

/**
 * `createTrimDb` 在模块加载时就会调用 `createCouchDb`，所以必须在 import 之前把 client 换掉。
 * 只替换两个入口（`createCouchDb` / `nanoServer`），纯函数一律用真实实现。
 */
const couchMock = vi.hoisted(() => ({
  view: null as null | ((design: string, view: string, opts: Record<string, unknown>) => Promise<unknown>),
  request: null as null | ((opts: { path?: string, body?: unknown }) => Promise<unknown>),
}))

vi.mock("../couchdb/client", () => ({
  createCouchDb: () => ({
    view: (design: string, view: string, opts: Record<string, unknown>) => couchMock.view!(design, view, opts),
    compact: async () => {},
  }),
  nanoServer: {
    request: (opts: { path?: string, body?: unknown }) => couchMock.request!(opts),
  },
  /** retention.ts 只 import 了 createCouchDb，其余导出给别的模块用（这里不需要） */
  authenticatedDbUrl: (db: string) => db,
}))
import {
  buildPurgeBody,
  countPurged,
  DEFAULT_SOURCE_RETENTION_ENTRIES,
  DEFAULT_TRIM_BATCH,
  DEFAULT_TRIM_MAX_BATCHES,
  trimExcess,
  trimSourceToLatestN,
  USER_TIMELINE_TRIM_VIEW,
  type TrimDb,
} from "../couchdb/retention"

/**
 * 库裁剪（每种源只保留最新 N 条）的边界。
 *
 * 这是保留策略的**唯一实现**：源库（整库裁）和汇聚库（逐源裁）都调它，只是参数不同。
 * 错误方向不对称 ——
 *   - 多留：库大一点，可恢复；
 *   - 少留/误删：内容永久消失，不可逆。
 * 所以测试重点在"不该删的没删"和"不会无限删"。
 *
 * 清理方式从标准 delete 改成了 `_purge`（见 `couchdb/retention.ts` 文件头）：
 * 新方案接受墓碑静默丢失，两侧各自裁、都不留墓碑。`_purge` 的两个易错点（请求体格式、
 * 「rev 已不存在」的幂等语义）由 `buildPurgeBody` / `countPurged` 的用例钉住。
 */

/** 记录调用、按批次返回删除条数的假实现 */
function fakeDb(total: number, deleteCounts: number[] = []) {
  const calls = {
    counts: [] as string[],
    deletes: [] as Array<{ viewPath: string, limit: number }>,
    compacted: 0,
  }
  let batch = 0
  const db: TrimDb = {
    async countEntries(viewPath) {
      calls.counts.push(viewPath)
      return total
    },
    async purgeOldest(viewPath, limit) {
      calls.deletes.push({ viewPath, limit })
      return deleteCounts[batch++] ?? 0
    },
    async compact() {
      calls.compacted += 1
    },
  }
  return { db, calls }
}

describe("trimExcess（total - N）", () => {
  it("不超过 N：一条都不删", () => {
    expect(trimExcess(0, 50)).toBe(0)
    expect(trimExcess(50, 50)).toBe(0)
    expect(trimExcess(10, 50)).toBe(0)
  })

  it("超出多少就删多少", () => {
    expect(trimExcess(120, 50)).toBe(70)
    expect(trimExcess(51, 50)).toBe(1)
  })

  it("并列时间戳不再影响结果（按行序删，不按时间下界）", () => {
    // 300 条同一个 publishedAt 也要裁到 50 —— 旧的下界方案在这是 0
    expect(trimExcess(300, 50)).toBe(250)
  })

  it("N 非正整数直接抛错（避免静默变成「全删」或「不删」）", () => {
    expect(() => trimExcess(10, 0)).toThrow()
    expect(() => trimExcess(10, -1)).toThrow()
    expect(() => trimExcess(10, 1.5)).toThrow()
  })
})

describe("trimSourceToLatestN", () => {
  it("源库不足 N 条：完全不调用删除", async () => {
    const { db, calls } = fakeDb(10)
    const result = await trimSourceToLatestN(db, { n: 50 })
    expect(result).toEqual({ total: 10, deleted: 0, batches: 0 })
    expect(calls.deletes).toHaveLength(0)
    expect(calls.compacted).toBe(0)
  })

  it("正好 N 条：也不动", async () => {
    const { db, calls } = fakeDb(50)
    expect(await trimSourceToLatestN(db, { n: 50 })).toEqual({ total: 50, deleted: 0, batches: 0 })
    expect(calls.deletes).toHaveLength(0)
  })

  it("超限：一次删掉全部超出部分，批大小够用时只跑一批", async () => {
    const { db, calls } = fakeDb(120, [70])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200 })
    expect(result).toEqual({ total: 120, deleted: 70, batches: 1 })
    expect(calls.deletes).toEqual([{ viewPath: "main/entries-by-date", limit: 70 }])
  })

  it("多批：每批不超过 batchSize，最后一批用剩余量", async () => {
    // total 450，N=50 → 删 400：200 + 200
    const { db, calls } = fakeDb(450, [200, 200])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200 })
    expect(result.deleted).toBe(400)
    expect(result.batches).toBe(2)
    expect(calls.deletes).toEqual([
      { viewPath: "main/entries-by-date", limit: 200 },
      { viewPath: "main/entries-by-date", limit: 200 },
    ])
  })

  it("最后一批按剩余量收窄（不会多删）", async () => {
    // 删 70：批大小 200 → 一批就够，limit 应该是 70 而不是 200
    const { db, calls } = fakeDb(120, [70])
    await trimSourceToLatestN(db, { n: 50, batchSize: 200 })
    expect(calls.deletes[0]!.limit).toBe(70)
  })

  it("一批一条都没删掉就停（并发 conflict 时不能拿同一页无限重试）", async () => {
    const { db, calls } = fakeDb(1000, [0])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200 })
    expect(result.batches).toBe(1)
    expect(result.deleted).toBe(0)
    expect(calls.deletes).toHaveLength(1)
  })

  it("maxBatches 限速：首次上线的删除风暴分批来，剩下的下次再删", async () => {
    const { db, calls } = fakeDb(100_000, [200, 200, 200])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200, maxBatches: 3 })
    expect(result.batches).toBe(3)
    expect(result.deleted).toBe(600)
    expect(calls.deletes).toHaveLength(3)
  })

  it("compact 只在真删了东西时调", async () => {
    const { db: dbTrim, calls: callsTrim } = fakeDb(100, [50])
    await trimSourceToLatestN(dbTrim, { n: 50, compact: true })
    expect(callsTrim.compacted).toBe(1)

    const { db: dbNoTrim, calls: callsNoTrim } = fakeDb(100, [0])
    await trimSourceToLatestN(dbNoTrim, { n: 50, compact: true })
    expect(callsNoTrim.compacted).toBe(0)
  })

  it("默认 N 是 50（= 旧 minFeedEntries，顺便给低频源兜底）", async () => {
    expect(DEFAULT_SOURCE_RETENTION_ENTRIES).toBe(50)
    const { db, calls } = fakeDb(60, [10])
    const result = await trimSourceToLatestN(db)
    expect(calls.counts[0]).toBe("main/entries-by-date")
    expect(result.deleted).toBe(10)
  })
})

describe("_purge 请求体与响应计数（纯函数）", () => {
  it("同 id 的多个 rev 合并进同一个键", () => {
    expect(buildPurgeBody([
      { _id: "entry:a", _rev: "1-x" },
      { _id: "entry:a", _rev: "2-y" },
      { _id: "entry:b", _rev: "1-z" },
    ])).toEqual({ "entry:a": ["1-x", "2-y"], "entry:b": ["1-z"] })
  })

  it("只数真正清掉的 rev：响应里 rev 已不存在（返回空数组）不算", () => {
    const body = buildPurgeBody([
      { _id: "entry:a", _rev: "1-x" },
      { _id: "entry:b", _rev: "1-z" },
    ])
    // entry:b 在别处已经被清掉了 → CouchDB 对它返回空数组（幂等，不当失败）
    expect(countPurged({ "entry:a": ["1-x"], "entry:b": [] }, body)).toBe(1)
  })

  it("响应缺这个 id（并发 purge / 该 id 从未存在）按 0 算，不抛", () => {
    const body = buildPurgeBody([{ _id: "entry:a", _rev: "1-x" }])
    expect(countPurged({}, body)).toBe(0)
    expect(countPurged(undefined, body)).toBe(0)
  })
})

describe("trimSourceToLatestN：groupByFeed（汇聚库逐源保留）", () => {
  /** 假的「按源分组裁剪」：记录调用参数，按给定结果返回 */
  function fakeGroupDb(result: { total: number, deleted: number, batches: number }) {
    const calls: Array<{ viewPath: string, n: number, batchSize: number, maxBatches: number }> = []
    const db: TrimDb = {
      async countEntries() {
        throw new Error("groupByFeed 不该走整库计数")
      },
      async purgeOldest() {
        throw new Error("groupByFeed 不该走整库清理")
      },
      async compact() {},
      async purgeExcessPerGroup(viewPath, n, batchSize, maxBatches) {
        calls.push({ viewPath, n, batchSize, maxBatches })
        return result
      },
    }
    return { db, calls }
  }

  it("走逐源裁剪，用汇聚库那个视图，结果原样透出", async () => {
    const { db, calls } = fakeGroupDb({ total: 400, deleted: 120, batches: 2 })
    const result = await trimSourceToLatestN(db, {
      n: 50,
      viewPath: USER_TIMELINE_TRIM_VIEW,
      groupByFeed: true,
    })
    expect(result).toEqual({ total: 400, deleted: 120, batches: 2 })
    expect(calls).toEqual([{
      viewPath: "timeline-maintain/by-feed-date",
      n: 50,
      batchSize: DEFAULT_TRIM_BATCH,
      maxBatches: DEFAULT_TRIM_MAX_BATCHES,
    }])
  })

  it("groupByFeed 但实现没提供逐源能力时直接抛错（不能静默退化成整库裁剪）", async () => {
    const db: TrimDb = {
      async countEntries() { return 0 },
      async purgeOldest() { return 0 },
      async compact() {},
    }
    await expect(trimSourceToLatestN(db, { groupByFeed: true })).rejects.toThrow(/purgeExcessPerGroup/)
  })

  it("没清掉任何东西时不 compact", async () => {
    const { db, calls } = fakeGroupDb({ total: 100, deleted: 0, batches: 0 })
    const compacted: number[] = []
    db.compact = async () => { compacted.push(1) }
    await trimSourceToLatestN(db, { n: 50, groupByFeed: true, compact: true })
    expect(compacted).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
})

/**
 * `createTrimDb().purgeExcessPerGroup` 的推进逻辑（用假 nano 验，不起真库）。
 *
 * 这里钉住的是一个**曾经写错两次**的地方：汇聚库要"逐源各留 N 条"，而按页边分组会在
 * 「某个源被切在两页之间」时只看得到半截数据 —— 按半截裁会误删，跳过又永远轮不到它
 * （实测 25 条裁到 5 条时，跳过写法每轮清 0 条、永不收敛）。现在的实现是逐源整组读。
 */
describe("createTrimDb().purgeExcessPerGroup（逐源整组读）", () => {
  /** 假 CouchDB：视图按 `[feedId, publishedAt]` 全序存，支持 head 查询与整组范围读 */
  function fakeCouch(rows: Array<{ feedId: string, at: string, rev: string }>) {
    const purged: string[] = []
    const sorted = () => [...rows].sort((a, b) =>
      a.feedId === b.feedId ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) : (a.feedId < b.feedId ? -1 : 1))

    return {
      purged,
      /** 剩余每源的条数 */
      counts(): Record<string, number> {
        const out: Record<string, number> = {}
        for (const row of rows) out[row.feedId] = (out[row.feedId] ?? 0) + 1
        return out
      },
      view: async (_design: string, _view: string, opts: {
        startkey?: unknown[], endkey?: unknown[], limit?: number
      }) => {
        const all = sorted()
        let picked = all
        if (Array.isArray(opts.startkey)) {
          const [feed, at] = opts.startkey as [string, string]
          picked = picked.filter(row => row.feedId > feed || (row.feedId === feed && row.at >= at))
        }
        if (Array.isArray(opts.endkey)) {
          const [feed, at] = opts.endkey as [string, string | object]
          picked = picked.filter(row => row.feedId < feed
            || (row.feedId === feed && (typeof at === "object" || row.at <= at)))
        }
        const limited = opts.limit ? picked.slice(0, opts.limit) : picked
        return {
          total_rows: all.length,
          rows: limited.map(row => ({
            id: `entry:${row.feedId}:${row.at}`,
            key: [row.feedId, row.at],
            value: { _id: `entry:${row.feedId}:${row.at}` },
            doc: { _id: `entry:${row.feedId}:${row.at}`, _rev: row.rev, feedId: row.feedId },
          })),
        }
      },
      async purge(_dbName: string, body: Record<string, string[]>) {
        const removed: Record<string, string[]> = {}
        for (const [id, revs] of Object.entries(body)) {
          const idx = rows.findIndex(row => `entry:${row.feedId}:${row.at}` === id)
          if (idx >= 0) { rows.splice(idx, 1); removed[id] = revs; purged.push(id) }
        }
        return removed
      },
    }
  }

  it("多源各自保留最新 N 条：一轮到位，且保留的是各源最新的那些", async () => {
    const couch = fakeCouch([
      // A：5 条（略超 N=3）
      ...["01", "02", "03", "04", "05"].map(at => ({ feedId: "A", at: `2026-01-${at}`, rev: `1-${at}` })),
      // B：2 条（不足 N，一条都不该动）
      ...["01", "02"].map(at => ({ feedId: "B", at: `2026-02-${at}`, rev: `1-${at}` })),
      // C：4 条
      ...["01", "02", "03", "04"].map(at => ({ feedId: "C", at: `2026-03-${at}`, rev: `1-${at}` })),
    ])

    couchMock.view = couch.view as never
    couchMock.request = (async (opts: { path?: string, body?: unknown }) => {
      if (opts?.path?.endsWith("/_purge")) {
        return { purged: await couch.purge("db", opts.body as Record<string, string[]>) }
      }
      return {}
    }) as never

    const { createTrimDb } = await import("../couchdb/retention")
    const result = await createTrimDb("db").purgeExcessPerGroup!(USER_TIMELINE_TRIM_VIEW, 3, 200, 10)

    expect(couch.counts()).toEqual({ A: 3, B: 2, C: 3 })
    // A 保留 03/04/05、C 保留 02/03/04（最新 N 条），说明是"留尾部"而不是"留头部"
    expect(couch.purged.sort()).toEqual([
      "entry:A:2026-01-01", "entry:A:2026-01-02",
      "entry:C:2026-03-01",
    ])
    expect(result.deleted).toBe(3)
  })

  it("每个源只处理一次：源数量多于一批时也按 id 顺序推进，不重复不清漏", async () => {
    const rows = ["A", "B", "C", "D"].flatMap(feed => ["01", "02", "03", "04"].map(at => (
      { feedId: feed, at: `2026-01-${at}`, rev: `1-${feed}${at}` }
    )))
    const couch = fakeCouch(rows)

    couchMock.view = couch.view as never
    couchMock.request = (async (opts: { path?: string, body?: unknown }) => {
      if (opts?.path?.endsWith("/_purge")) {
        return { purged: await couch.purge("db", opts.body as Record<string, string[]>) }
      }
      return {}
    }) as never

    const { createTrimDb } = await import("../couchdb/retention")
    await createTrimDb("db").purgeExcessPerGroup!(USER_TIMELINE_TRIM_VIEW, 2, 200, 100)
    // 4 个源各留 2 条 = 8 条；每个源只被处理一次
    expect(couch.counts()).toEqual({ A: 2, B: 2, C: 2, D: 2 })
    expect(couch.purged).toHaveLength(8)
    expect(new Set(couch.purged).size).toBe(8) // 没有任何一条被重复清
  })
})
