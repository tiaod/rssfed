import { describe, expect, it } from "vitest"
import type { DocumentScope } from "nano"
import { pruneOutsideRetention } from "../services/timeline"

/**
 * 剪枝是**唯一会把条目从用户库里删掉**的地方（复制器只会搬、不会删），而"窗口 ∨ 每源保底条数"
 * 这条规则又有个不好测的形状：它必须按源分组数"最新 N 条"。所以这里用一个假 view 把
 * `by_feed_published_at` 的语义（按 `[feedId, publishedAt]` 排序、倒序走、startkey + skip 翻页）
 * 实现出来，把边界钉死：
 *   · 每个源的**前 N 行无论多老都留**（低频源就靠这个不至于整源空白）；
 *   · 第 N 行之后仍然要**在窗口外**才删（窗口内的照旧留）；
 *   · 源里不足 N 条 = 一篇都不删；
 *   · 没开保底条数 = 回到纯时间窗口的老行为。
 */

interface Row { id: string, key: [string | null, string] }

/** 按 `[feedId, publishedAt]` 排序（CouchDB 的数组 key 逐段比较；null 排在最前） */
function compareKeys(a: [string | null, string], b: [string | null, string]): number {
  const fa = a[0] ?? ""
  const fb = b[0] ?? ""
  if (fa !== fb) return fa < fb ? -1 : 1
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
  return 0
}

/**
 * 假 CouchDB：只实现这次用到的三种请求 —— 视图（含 descending / limit / startkey / skip）、
 * `fetch({ keys })` 取 rev、`bulk({ docs })` 批量删除。
 */
function fakeScope(entries: Array<{ id: string, feedId: string | null, publishedAt: string }>, pageSize = 500) {
  const alive = new Map(entries.map(e => [e.id, e]))
  const deleted: string[] = []
  const viewCalls: Array<Record<string, unknown>> = []
  const rev = 1

  const scope = {
    view: async (_ddoc: string, viewName: string, opts: Record<string, unknown> = {}) => {
      viewCalls.push({ viewName, ...opts })
      // 纯时间窗口那条分支用的是按发布时间排的视图（没有保底条数时才走）
      if (viewName === "by_published_at") {
        const endkey = opts.endkey as string | undefined
        const rows = [...alive.values()]
          .map(e => ({ id: e.id, key: e.publishedAt }))
          .filter(r => (endkey === undefined ? true : opts.inclusive_end === false ? r.key < endkey : r.key <= endkey))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return { rows: rows.slice(0, Number(opts.limit ?? pageSize)) }
      }
      if (viewName !== "by_feed_published_at") throw new Error(`unexpected view ${viewName}`)
      let rows: Row[] = [...alive.values()].map(e => ({ id: e.id, key: [e.feedId, e.publishedAt] as [string | null, string] }))
      rows.sort((a, b) => compareKeys(a.key, b.key))
      if (opts.descending) rows.reverse()
      const startkey = opts.startkey as [string | null, string] | undefined
      if (startkey) {
        rows = opts.descending
          ? rows.filter(r => compareKeys(r.key, startkey) <= 0)
          : rows.filter(r => compareKeys(r.key, startkey) >= 0)
        if (opts.skip) rows = rows.slice(Number(opts.skip))
      }
      return { rows: rows.slice(0, Number(opts.limit ?? pageSize)) }
    },
    fetch: async ({ keys }: { keys: string[] }) => ({
      rows: keys
        .filter(id => alive.has(id))
        .map(id => ({ id, key: id, value: { rev: `${rev}-x` } })),
    }),
    bulk: async ({ docs }: { docs: Array<{ _id: string }> }) => {
      for (const doc of docs) {
        alive.delete(doc._id)
        deleted.push(doc._id)
      }
      return docs.map(() => ({ ok: true }))
    },
  }
  return {
    scope: scope as unknown as DocumentScope<unknown>,
    deleted,
    aliveIds: () => [...alive.keys()].sort(),
    viewCalls,
  }
}

const entry = (feedId: string | null, publishedAt: string, id = `${feedId}:${publishedAt}`) => ({ id, feedId, publishedAt })

/** 两条源：A 有 4 条（只有最新一条在窗口内），B 有 2 条（全部在窗口外） */
function fixtures() {
  return [
    entry("A", "2026-01-01T00:00:00.000Z"),
    entry("A", "2026-02-01T00:00:00.000Z"),
    entry("A", "2026-03-01T00:00:00.000Z"),
    entry("A", "2026-04-01T00:00:00.000Z"),
    entry("B", "2026-02-10T00:00:00.000Z"),
    entry("B", "2026-03-10T00:00:00.000Z"),
  ]
}

const WINDOW_START = "2026-03-15T00:00:00.000Z"

describe("pruneOutsideRetention", () => {
  it("窗口不限时间：一条都不删（保底条数不额外要求什么）", async () => {
    const fake = fakeScope(fixtures())
    expect(await pruneOutsideRetention(fake.scope, { windowStart: null, minEntries: 50 })).toBe(0)
    expect(fake.deleted).toEqual([])
    // 连视图都不查
    expect(fake.viewCalls).toEqual([])
  })

  it("保底条数关闭：回到纯时间窗口的老行为（窗口外的全删）", async () => {
    const fake = fakeScope(fixtures())
    const pruned = await pruneOutsideRetention(fake.scope, { windowStart: WINDOW_START, minEntries: 0 })

    expect(pruned).toBe(5) // A 的 01/02/03 + B 的两条（B 都在窗口外）
    expect(fake.aliveIds()).toEqual(["A:2026-04-01T00:00:00.000Z"])
  })

  it("每个源保留最新 N 条：窗口外的低频源内容被保住，超出 N 的才删", async () => {
    const fake = fakeScope(fixtures())
    const pruned = await pruneOutsideRetention(fake.scope, { windowStart: WINDOW_START, minEntries: 2 })

    // A 的前 2 新（03-01、04-01）留着，01-01 与 02-01 删；B 只有 2 条、不足 N → 一条都不删
    expect(fake.deleted.sort()).toEqual(["A:2026-01-01T00:00:00.000Z", "A:2026-02-01T00:00:00.000Z"])
    expect(pruned).toBe(2)
    expect(fake.aliveIds()).toEqual([
      "A:2026-03-01T00:00:00.000Z",
      "A:2026-04-01T00:00:00.000Z",
      "B:2026-02-10T00:00:00.000Z",
      "B:2026-03-10T00:00:00.000Z",
    ])
  })

  it("源里不足 N 条 = 一篇都不删（低频源正是这种情况）", async () => {
    const fake = fakeScope(fixtures())
    expect(await pruneOutsideRetention(fake.scope, { windowStart: WINDOW_START, minEntries: 10 })).toBe(0)
    expect(fake.deleted).toEqual([])
  })

  it("分页翻页时不会重复删除、也不会漏（每页 2 行）", async () => {
    const fake = fakeScope(fixtures(), 2)
    const pruned = await pruneOutsideRetention(fake.scope, { windowStart: WINDOW_START, minEntries: 1 })

    // 每源只留最新 1 条：A 删 01/02/03，B 删 02-10
    expect(fake.deleted.sort()).toEqual([
      "A:2026-01-01T00:00:00.000Z",
      "A:2026-02-01T00:00:00.000Z",
      "A:2026-03-01T00:00:00.000Z",
      "B:2026-02-10T00:00:00.000Z",
    ])
    expect(pruned).toBe(4)
    expect(fake.aliveIds()).toEqual(["A:2026-04-01T00:00:00.000Z", "B:2026-03-10T00:00:00.000Z"])
  })

  it("同一时间戳多条不会因为 startkey+skip 翻页而漏删", async () => {
    const fake = fakeScope([
      // 同一个 key 上挂 3 条：翻页时 skip:1 只跳过一行，剩下的必须继续被处理
      entry("A", "2026-01-01T00:00:00.000Z", "A:x1"),
      entry("A", "2026-01-01T00:00:00.000Z", "A:x2"),
      entry("A", "2026-01-01T00:00:00.000Z", "A:x3"),
      entry("A", "2026-05-01T00:00:00.000Z", "A:new"),
    ], 2)

    const pruned = await pruneOutsideRetention(fake.scope, { windowStart: WINDOW_START, minEntries: 1 })

    expect(pruned).toBe(3)
    expect(fake.aliveIds()).toEqual(["A:new"])
  })

  it("没有 feedId 的异常条目归到 null 组，仍然受窗口裁剪（不会永远留着）", async () => {
    const fake = fakeScope([
      entry(null, "2026-01-01T00:00:00.000Z", "orphan"),
      entry(null, "2026-05-01T00:00:00.000Z", "orphan-new"),
    ])

    expect(await pruneOutsideRetention(fake.scope, { windowStart: WINDOW_START, minEntries: 1 })).toBe(1)
    expect(fake.aliveIds()).toEqual(["orphan-new"])
  })
})
