import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCE_RETENTION_ENTRIES,
  trimBound,
  trimSourceToLatestN,
  type TrimDb,
} from "../couchdb/retention"

/**
 * 源库裁剪（保留最新 N 条）的边界。
 *
 * 这是保留策略的**唯一权威**（`docs/notes/aggregation/source-side-retention-plan.md`）：
 * 源库删什么，用户库和浏览器就是什么。所以错误方向不对称：
 *   - 多留：库大一点，可恢复；
 *   - 少留/误删：内容永久消失（源库是唯一来源），不可逆。
 * 测试重点全在"不该删的没删"和"不会无限删"。
 */

/** 记录调用、按批次返回删除条数的假实现 */
function fakeDb(descendingKeys: unknown[], deleteCounts: number[] = []) {
  const calls = {
    keys: [] as Array<{ viewPath: string, limit: number }>,
    deletes: [] as Array<{ viewPath: string, bound: string, batchSize: number }>,
    compacted: 0,
  }
  let batch = 0
  const db: TrimDb = {
    async descendingKeys(viewPath, limit) {
      calls.keys.push({ viewPath, limit })
      return descendingKeys.slice(0, limit)
    },
    async deleteBelow(viewPath, bound, batchSize) {
      calls.deletes.push({ viewPath, bound, batchSize })
      return deleteCounts[batch++] ?? 0
    },
    async compact() {
      calls.compacted += 1
    },
  }
  return { db, calls }
}

/** 生成降序的发布时间（最新的在前） */
const descending = (n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + (n - i) * 1000).toISOString())

describe("trimBound（从降序 key 算下界）", () => {
  it("条数 ≤ N：不裁", () => {
    expect(trimBound([], 50)).toBeUndefined()
    expect(trimBound(descending(50), 50)).toBeUndefined()
  })

  it("第 N+1 行的 key 就是下界（下标 N）", () => {
    const keys = descending(51)
    expect(trimBound(keys, 50)).toBe(keys[50])
    expect(trimBound(keys, 1)).toBe(keys[1])
  })

  it("下界不是字符串：不裁（拿不到边界时宁可多留，不做不可逆的误删）", () => {
    expect(trimBound([null, null], 1)).toBeUndefined()
    expect(trimBound([1, 2], 1)).toBeUndefined()
    expect(trimBound(descending(3).map(() => ""), 1)).toBeUndefined()
  })

  it("N 非正整数直接抛错（避免静默变成「全删」或「不删」）", () => {
    expect(() => trimBound(descending(3), 0)).toThrow()
    expect(() => trimBound(descending(3), -1)).toThrow()
    expect(() => trimBound(descending(3), 1.5)).toThrow()
  })

  it("并列时间戳：下界取第 N+1 个，调用方按严格小于删除 → 至少留 N 条", () => {
    // 全并列：下界 = 同一时刻 → `publishedAt < 下界` 一条都不匹配 → 全部保留
    const same = Array.from({ length: 5 }, () => "2026-01-01T00:00:00.000Z")
    expect(trimBound(same, 3)).toBe("2026-01-01T00:00:00.000Z")
  })
})

describe("trimSourceToLatestN", () => {
  it("源库不足 N 条：完全不调用删除", async () => {
    const { db, calls } = fakeDb(descending(10))
    const result = await trimSourceToLatestN(db, { n: 50 })
    expect(result).toEqual({ trimmed: false, deleted: 0, batches: 0 })
    expect(calls.deletes).toHaveLength(0)
    expect(calls.compacted).toBe(0)
  })

  it("只多取一行：降序 limit = N+1", async () => {
    const { db, calls } = fakeDb(descending(10))
    await trimSourceToLatestN(db, { n: 50 })
    expect(calls.keys).toEqual([{ viewPath: "main/entries-by-date", limit: 51 }])
  })

  it("需要裁剪：按第 N+1 行的下界删，删完就停", async () => {
    const keys = descending(120)
    // 源库有 70 条要删：一批删 70 条（不满一批 → 结束）
    const { db, calls } = fakeDb(keys, [70])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 100 })
    expect(result.trimmed).toBe(true)
    expect(result.bound).toBe(keys[50])
    expect(result.deleted).toBe(70)
    expect(calls.deletes).toEqual([{ viewPath: "main/entries-by-date", bound: keys[50] as string, batchSize: 100 }])
  })

  it("多批：满批说明可能还有，继续；不满批就停", async () => {
    const { db, calls } = fakeDb(descending(1000), [200, 200, 50])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200 })
    expect(result.batches).toBe(3)
    expect(result.deleted).toBe(450)
    expect(calls.deletes).toHaveLength(3)
  })

  it("一批一条都没删掉就停（并发 conflict 时不能拿同一页无限重试）", async () => {
    const { db, calls } = fakeDb(descending(1000), [0])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200 })
    expect(result.batches).toBe(1)
    expect(result.deleted).toBe(0)
    expect(calls.deletes).toHaveLength(1)
  })

  it("maxBatches 限速：首次上线的删除风暴分批来，剩下的下次再删", async () => {
    const { db, calls } = fakeDb(descending(100_000), [200, 200, 200, 200, 200])
    const result = await trimSourceToLatestN(db, { n: 50, batchSize: 200, maxBatches: 3 })
    expect(result.batches).toBe(3)
    expect(result.deleted).toBe(600)
    expect(calls.deletes).toHaveLength(3)
  })

  it("compact 只在真删了东西时调", async () => {
    const { db: dbTrim, calls: callsTrim } = fakeDb(descending(100), [10])
    await trimSourceToLatestN(dbTrim, { n: 50, compact: true })
    expect(callsTrim.compacted).toBe(1)

    const { db: dbNoTrim, calls: callsNoTrim } = fakeDb(descending(100), [0])
    await trimSourceToLatestN(dbNoTrim, { n: 50, compact: true })
    expect(callsNoTrim.compacted).toBe(0)
  })

  it("默认 N 是 50（= 旧 minFeedEntries，顺便给低频源兜底）", async () => {
    expect(DEFAULT_SOURCE_RETENTION_ENTRIES).toBe(50)
    const keys = descending(60)
    const { db, calls } = fakeDb(keys, [10])
    const result = await trimSourceToLatestN(db)
    expect(calls.keys[0]).toEqual({ viewPath: "main/entries-by-date", limit: 51 })
    expect(result.bound).toBe(keys[50])
  })
})
