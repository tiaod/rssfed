import { describe, expect, it, vi } from "vitest"

/**
 * `trimOwnerFeedToLatestN` 直接调 `createCouchDb`，所以必须在 import 之前把 client 换掉。
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
}))
import {
  buildPurgeBody,
  countPurged,
  trimOwnerFeedToLatestN,
  USER_TIMELINE_TRIM_VIEW,
} from "../couchdb/retention"

/**
 * 库裁剪（每条源只保留最新 N 条）的边界。
 *
 * 新模型下只有一个入口 `trimOwnerFeedToLatestN`：用户库一个库里装着几百个源，裁剪必须
 * **按源分组**各留 N 条。错误方向不对称 ——
 *   - 多留：库大一点，可恢复；
 *   - 少留/误删：内容永久消失，不可逆。
 * 所以测试重点在"不该删的没删"和"不会无限删"。
 *
 * 清理方式从标准 delete 改成了 `_purge`（见 `couchdb/retention.ts` 文件头）：接受墓碑静默
 * 丢失。`_purge` 的两个易错点（请求体格式、「rev 已不存在」的幂等语义）由
 * `buildPurgeBody` / `countPurged` 的用例钉住。
 */

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

/**
 * `trimOwnerFeedToLatestN` 的推进逻辑（用假 nano 验，不起真库）。
 *
 * 这里钉住的是一个**曾经写错两次**的地方：按页边分组会在「某个源被切在两页之间」时
 * 只看得到半截数据 —— 按半截裁会误删，跳过又永远轮不到它（实测 25 条裁到 5 条时，
 * 跳过写法每轮清 0 条、永不收敛）。现在的实现是**逐源整组读**。
 */
describe("trimOwnerFeedToLatestN（逐源整组读）", () => {
  /** 假 CouchDB：视图按 `[feedId, publishedAt]` 全序存，支持范围读与 `_purge` */
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

  /** 把假 CouchDB 接到 mock 上，并返回一个跑一轮裁剪的函数 */
  function setup(rows: Array<{ feedId: string, at: string, rev: string }>) {
    const couch = fakeCouch(rows)
    couchMock.view = couch.view as never
    couchMock.request = (async (opts: { path?: string, body?: unknown }) => {
      if (opts?.path?.endsWith("/_purge")) {
        return { purged: await couch.purge("db", opts.body as Record<string, string[]>) }
      }
      return {}
    }) as never
    return couch
  }

  it("多源各自保留最新 N 条：一轮到位，且保留的是各源最新的那些", async () => {
    const couch = setup([
      // A：5 条（略超 N=3）
      ...["01", "02", "03", "04", "05"].map(at => ({ feedId: "A", at: `2026-01-${at}`, rev: `1-${at}` })),
      // B：2 条（不足 N，一条都不该动）
      ...["01", "02"].map(at => ({ feedId: "B", at: `2026-02-${at}`, rev: `1-${at}` })),
      // C：4 条
      ...["01", "02", "03", "04"].map(at => ({ feedId: "C", at: `2026-03-${at}`, rev: `1-${at}` })),
    ])

    // 只裁 A：同库里 B/C 不该被碰（这是「按源逐个裁」与「整库裁」的关键区别）
    const deleted = await trimOwnerFeedToLatestN("db", "A", 3, { maxBatches: 10 })

    expect(deleted).toBe(2)
    expect(couch.counts()).toEqual({ A: 3, B: 2, C: 4 })
    // A 保留 03/04/05（最新 N 条），说明是"留尾部"而不是"留头部"
    expect(couch.purged.sort()).toEqual(["entry:A:2026-01-01", "entry:A:2026-01-02"])
  })

  it("源不足 N 条：一条都不删", async () => {
    const couch = setup(["01", "02"].map(at => ({ feedId: "A", at: `2026-01-${at}`, rev: `1-${at}` })))

    expect(await trimOwnerFeedToLatestN("db", "A", 50)).toBe(0)
    expect(couch.purged).toEqual([])
  })

  it("正好 N 条：也不动", async () => {
    const couch = setup(["01", "02", "03"].map(at => ({ feedId: "A", at: `2026-01-${at}`, rev: `1-${at}` })))

    expect(await trimOwnerFeedToLatestN("db", "A", 3)).toBe(0)
    expect(couch.purged).toEqual([])
  })

  it("超出部分多批清完，每批不超过 batchSize", async () => {
    // 10 条裁到 2 条 = 删 8；batchSize=3 → 3+3+2，共 3 批
    const couch = setup(Array.from({ length: 10 }, (_, i) => (
      { feedId: "A", at: `2026-01-${String(i + 1).padStart(2, "0")}`, rev: `1-${i}` }
    )))

    const deleted = await trimOwnerFeedToLatestN("db", "A", 2, { batchSize: 3, maxBatches: 10 })

    expect(deleted).toBe(8)
    expect(couch.counts()).toEqual({ A: 2 })
  })

  it("maxBatches 限速：剩下的留给下一轮，不会一次删光", async () => {
    const couch = setup(Array.from({ length: 10 }, (_, i) => (
      { feedId: "A", at: `2026-01-${String(i + 1).padStart(2, "0")}`, rev: `1-${i}` }
    )))

    const deleted = await trimOwnerFeedToLatestN("db", "A", 2, { batchSize: 2, maxBatches: 2 })

    expect(deleted).toBe(4)
    expect(couch.counts()).toEqual({ A: 6 })
  })

  it("一批一条都没清掉就停（并发 conflict 时不能拿同一页无限重试）", async () => {
    const couch = setup(Array.from({ length: 10 }, (_, i) => (
      { feedId: "A", at: `2026-01-${String(i + 1).padStart(2, "0")}`, rev: `1-${i}` }
    )))
    // rev 全部对不上：_purge 返回空
    couchMock.request = (async () => ({ purged: {} })) as never

    expect(await trimOwnerFeedToLatestN("db", "A", 2, { batchSize: 2, maxBatches: 10 })).toBe(0)
    expect(couch.counts()).toEqual({ A: 10 })
  })

  it("默认用 owner 库那个视图（main/by-feed-date）", async () => {
    const seen: Array<[string, string]> = []
    const couch = setup(["01", "02"].map(at => ({ feedId: "A", at: `2026-01-${at}`, rev: `1-${at}` })))
    const inner = couch.view
    couchMock.view = (async (design: string, view: string, opts: Record<string, unknown>) => {
      seen.push([design, view])
      return inner(design, view, opts as never)
    }) as never

    await trimOwnerFeedToLatestN("db", "A", 1)

    const [design, view] = USER_TIMELINE_TRIM_VIEW.split("/") as [string, string]
    expect(seen.every(([d, v]) => d === design && v === view)).toBe(true)
  })
})
