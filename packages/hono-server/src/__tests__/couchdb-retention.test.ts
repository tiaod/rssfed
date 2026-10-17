import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCE_RETENTION_ENTRIES,
  trimExcess,
  trimSourceToLatestN,
  type TrimDb,
} from "../couchdb/retention"

/**
 * 源库裁剪（每种源只保留最新 N 条）的边界。
 *
 * 这是保留策略的**唯一权威**（`docs/notes/aggregation/source-side-retention-plan.md`）：
 * 源库删什么，用户库和浏览器就是什么。错误方向不对称 ——
 *   - 多留：库大一点，可恢复；
 *   - 少留/误删：内容永久消失（源库是唯一来源），不可逆。
 * 所以测试重点在"不该删的没删"和"不会无限删"。
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
    async deleteOldest(viewPath, limit) {
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
