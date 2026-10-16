import { describe, expect, it } from "vitest"
import {
  buildPurgeBody,
  chunk,
  collectPurgeEntries,
  DEFAULT_PURGE_BATCH,
  deleteExpired,
  isExpiredDoc,
  purgeExpired,
  purgeTombstones,
  retentionBoundIso,
  selectPurgeableTombstones,
  summarizePurge,
  type RetentionDb,
  type RetentionRow,
} from "../couchdb/retention"

/**
 * 时间窗口清理的边界。
 *
 * 这一层的错误**不可逆**（源库是内容的唯一来源），所以测试重点全在"不该删的没删"：
 *   - `publishedAt` 缺失/非字符串 → 必须留着（探针实测源库里确实有这种条目）
 *   - 冲突叶子必须一起 purge（只 purge winner 的话 loser 顶上、文档还在）
 *   - "一条都没清掉"必须停下，不能拿同一页无限循环
 *
 * 实测依据：`docs/notes/aggregation/storage-refactor-plan.md` §5 / §13.A。
 */

const BOUND = "2026-01-01T00:00:00.000Z"

/** 记录所有调用、按页返回数据的假实现（不 mock nano，只实现 RetentionDb 的四个方法） */
function fakeDb(pages: RetentionRow[][], purgeResult: (body: Record<string, string[]>) => Record<string, string[]> = (body) => body) {
  const calls = {
    rows: [] as Array<{ viewPath: string, boundIso: string, limit: number }>,
    purges: [] as Array<Record<string, string[]>>,
    bulk: [] as Array<Array<{ _id: string, _rev: string, _deleted: true }>>,
    compacted: 0,
  }
  let page = 0
  const db: RetentionDb = {
    async rowsBefore(viewPath, boundIso, limit) {
      calls.rows.push({ viewPath, boundIso, limit })
      return pages[page++] ?? []
    },
    async purge(body) {
      calls.purges.push(body)
      return purgeResult(body)
    },
    async bulkDelete(docs) {
      calls.bulk.push(docs)
    },
    async compact() {
      calls.compacted += 1
    },
  }
  return { db, calls }
}

const row = (id: string, rev: string, publishedAt: unknown = "2025-12-01T00:00:00.000Z", conflicts: string[] = []): RetentionRow =>
  ({ id, doc: { _rev: rev, _conflicts: conflicts, publishedAt } })
/** 显式构造"没有 publishedAt"的行：不能走 row()，它的默认参数会把 undefined 变成有效日期 */
const rowWithoutDate = (id: string, rev: string): RetentionRow => ({ id, doc: { _rev: rev } })

describe("retentionBoundIso / isExpiredDoc", () => {
  it("下界 = now 减 N 天（ISO 8601 UTC）", () => {
    expect(retentionBoundIso(new Date("2026-02-01T00:00:00.000Z"), 30)).toBe("2026-01-02T00:00:00.000Z")
    expect(retentionBoundIso(new Date("2026-02-01T00:00:00.000Z"), 0)).toBe("2026-02-01T00:00:00.000Z")
  })

  it("严格早于下界才算过期（等于下界留着）", () => {
    expect(isExpiredDoc("2025-12-31T23:59:59.000Z", BOUND)).toBe(true)
    expect(isExpiredDoc(BOUND, BOUND)).toBe(false)
    expect(isExpiredDoc("2026-01-01T00:00:00.001Z", BOUND)).toBe(false)
  })

  it("日期缺失/非字符串一律不过期（宁可库大一点，也不做不可逆的误删）", () => {
    for (const bad of [undefined, null, "", 0, 1_700_000_000, {}, []]) {
      expect(isExpiredDoc(bad, BOUND)).toBe(false)
    }
  })
})

describe("collectPurgeEntries / buildPurgeBody", () => {
  it("缺 rev 的行跳过；同一 id 的多个分支合并并去重", () => {
    const entries = collectPurgeEntries([
      row("a", "1-a"),
      { id: "b", doc: null },
      { id: "c", doc: { _rev: "" } },
      { id: "d", doc: { publishedAt: "2025-01-01T00:00:00.000Z" } },
      row("a", "1-a2"),
    ])
    expect(entries).toEqual([{ id: "a", revs: ["1-a", "1-a2"] }])
  })

  it("冲突叶子必须一起带上（只 purge winner 的话文档还在 —— 探针 A 实测）", () => {
    const entries = collectPurgeEntries([row("a", "1-winner", "2025-12-01T00:00:00.000Z", ["1-loser"])])
    expect(entries).toEqual([{ id: "a", revs: ["1-winner", "1-loser"] }])
    expect(buildPurgeBody(entries)).toEqual({ a: ["1-winner", "1-loser"] })
  })
})

describe("summarizePurge", () => {
  it("空数组算「没清掉」（探针 A：已被清过、或 rev 已非叶子时就是空数组，不是错误）", () => {
    expect(summarizePurge({ a: ["1-a", "1-b"], b: [], c: [] })).toEqual({ docs: 1, revs: 2, empty: 2 })
    expect(summarizePurge(undefined)).toEqual({ docs: 0, revs: 0, empty: 0 })
  })
})

describe("purgeExpired", () => {
  it("取一页 → purge（带上冲突叶子）→ 页不满就结束", async () => {
    const { db, calls } = fakeDb([[row("a", "1-a", "2025-12-01T00:00:00.000Z", ["1-a-conflict"]), row("b", "1-b")]])
    const run = await purgeExpired(db, { boundIso: BOUND, viewPath: "main/entries-by-date", batchSize: 50 })
    expect(run).toEqual({ pages: 1, docs: 2, revs: 3, skipped: 0 })
    expect(calls.purges).toEqual([{ a: ["1-a", "1-a-conflict"], b: ["1-b"] }])
    expect(calls.rows[0]).toMatchObject({ boundIso: BOUND, limit: 50 })
  })

  it("窗口外的没在窗口内的：`publishedAt` 缺失的条目**不进** purge 请求", async () => {
    const { db, calls } = fakeDb([[rowWithoutDate("keep", "1-keep"), row("old", "1-old")]])
    const run = await purgeExpired(db, { boundIso: BOUND, batchSize: 50 })
    expect(calls.purges).toEqual([{ old: ["1-old"] }])
    expect(run.docs).toBe(1)
  })

  it("一条都没真清掉就停（不能拿同一页无限循环）", async () => {
    const { db, calls } = fakeDb([[row("a", "1-a")]], () => ({ a: [] }))
    const run = await purgeExpired(db, { boundIso: BOUND, batchSize: 1 })
    expect(run).toEqual({ pages: 1, docs: 0, revs: 0, skipped: 1 })
    expect(calls.purges).toHaveLength(1)
    expect(calls.rows).toHaveLength(1)
  })

  it("多页继续：满页说明可能还有，清到空页为止", async () => {
    const full = Array.from({ length: 2 }, (_, i) => row(`p1-${i}`, `1-${i}`))
    const last = [row("p2-0", "1-x")]
    const { db, calls } = fakeDb([full, last, []])
    const run = await purgeExpired(db, { boundIso: BOUND, batchSize: 2 })
    expect(run.pages).toBe(2)
    expect(run.docs).toBe(3)
    // 第二页不满一页 → 结束，不会再去取第三页
    expect(calls.rows).toHaveLength(2)
  })

  it("maxBatches 限速：超出的留给下一轮", async () => {
    const page = [row("a", "1-a"), row("b", "1-b")]
    const { db, calls } = fakeDb([page, page, page, page])
    const run = await purgeExpired(db, { boundIso: BOUND, batchSize: 2, maxBatches: 2 })
    expect(run.pages).toBe(2)
    expect(calls.purges).toHaveLength(2)
  })

  it("默认批量是 1000", async () => {
    const { db, calls } = fakeDb([[]])
    await purgeExpired(db, { boundIso: BOUND })
    expect(calls.rows[0]!.limit).toBe(DEFAULT_PURGE_BATCH)
  })
})

describe("deleteExpired（汇聚库：故意留墓碑）", () => {
  it("走 bulk delete（_deleted:true）而不是 purge —— 墓碑要复制给客户端", async () => {
    const { db, calls } = fakeDb([[row("a", "1-a"), row("b", "1-b", "2025-12-02T00:00:00.000Z", ["1-b2"])]])
    const run = await deleteExpired(db, { boundIso: BOUND, batchSize: 50 })
    expect(calls.purges).toHaveLength(0)
    expect(calls.bulk).toEqual([[{ _id: "a", _rev: "1-a", _deleted: true }, { _id: "b", _rev: "1-b", _deleted: true }]])
    expect(run.docs).toBe(2)
    expect(run.skipped).toBe(1) // b 的冲突叶子这一轮不删（由 LWW 裁决处理）
  })

  it("`publishedAt` 缺失的条目不会被删掉", async () => {
    const { db, calls } = fakeDb([[rowWithoutDate("keep", "1-keep"), row("old", "1-old")]])
    await deleteExpired(db, { boundIso: BOUND, batchSize: 50 })
    expect(calls.bulk).toEqual([[{ _id: "old", _rev: "1-old", _deleted: true }]])
  })
})

describe("墓碑账本（宽限期）", () => {
  const now = new Date("2026-02-10T00:00:00.000Z")
  const rows = [
    { id: "old", rev: "2-old", deletedAt: "2026-02-01T00:00:00.000Z" }, // 9 天前 → 过 7 天宽限
    { id: "mid", rev: "2-mid", deletedAt: "2026-02-05T00:00:00.000Z" }, // 5 天前 → 未过
    { id: "empty", rev: "2-empty", deletedAt: "" },
    { id: "missing", rev: "2-missing", deletedAt: undefined as unknown as string },
  ]

  it("只挑删除时刻早于 now - grace 的", () => {
    // 空字符串/缺失的删除时刻**不算到点**：排在最前面，一旦漏判就会过早清墓碑
    expect(selectPurgeableTombstones(rows, now, 7).map((r) => r.id)).toEqual(["old"])
    expect(selectPurgeableTombstones(rows, now, 4).map((r) => r.id)).toEqual(["old", "mid"])
  })

  it("到点的批量 purge，有清掉就 compact", async () => {
    const { db, calls } = fakeDb([[]])
    const run = await purgeTombstones(db, rows, { now, graceDays: 7, batchSize: 100, compact: true })
    expect(calls.purges).toEqual([{ old: ["2-old"] }])
    expect(run).toMatchObject({ docs: 1, revs: 1 })
    expect(calls.compacted).toBe(1)
  })

  it("一条都没清掉时不 compact", async () => {
    const { db, calls } = fakeDb([[]], () => ({ old: [] }))
    await purgeTombstones(db, rows, { now, graceDays: 7, compact: true })
    expect(calls.compacted).toBe(0)
  })
})

describe("chunk", () => {
  it("按大小切分（含边界）", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
    expect(chunk([1, 2], 2)).toEqual([[1, 2]])
  })

  it("size 非正数直接抛错（避免静默死循环）", () => {
    expect(() => chunk([1], 0)).toThrow()
    expect(() => chunk([1], -1)).toThrow()
  })
})
