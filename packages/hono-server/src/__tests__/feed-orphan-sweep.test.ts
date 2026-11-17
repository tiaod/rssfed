import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 孤儿源自动清理（三级状态机）。
 *
 * ```
 * 有人订阅 → orphanSince=now（只标记）
 *   → 持续 ≥ PAUSE_AFTER  → 暂停
 *   → 持续 ≥ DELETE_AFTER → 删除（删除前再复核一次零订阅）
 * ```
 *
 * 这个文件钉住三条最容易出事的不变量：
 *  1. **刚变孤儿不会立刻暂停**（冷静期未满）；
 *  2. **重新有人订阅立刻清标记**（不会因为历史标记被暂停/删除）；
 *  3. **管理员手动暂停的源永远不进入删除候选**（pausedBySystem 非 true）。
 */

const DAY = 86_400_000

const state = vi.hoisted(() => ({
  users: [] as Array<{ id: string, dbName: string | null }>,
  subscriptions: new Map<string, string[]>(),
  failingDbs: new Set<string>(),
  botRefs: [] as string[],
  feeds: [] as Array<{
    id: string
    status: string
    pausedBySystem: boolean | null
    orphanSince: Date | null
  }>,
  /** 记录每次 update().set() */
  updates: [] as Array<{ set: Record<string, unknown>, ids: string[] }>,
  deleted: [] as string[],
}))

vi.mock("../db", () => {
  const feeds = { id: "id", status: "status", pausedBySystem: "paused_by_system", orphanSince: "orphan_since", url: "url" }
  const user = { id: "id", timelineDbName: "timeline_db_name" }
  const botFeeds = { feedId: "feed_id" }

  // 从 SQL 条件里"反推"要更新哪些行：这里用简化的方式 —— 测试里每个用例只关心
  // 传入的 id 集合与 set 内容，所以直接记录参数并返回对应的行
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === user) return Promise.resolve(state.users)
          const chain = {
            where: () => Promise.resolve(state.feeds),
            then: (res: (v: unknown) => unknown) => Promise.resolve(state.feeds).then(res),
          }
          return chain as unknown as Promise<typeof state.feeds>
        },
      }),
      selectDistinct: () => ({
        from: () => Promise.resolve(state.botRefs.map((feedId) => ({ feedId }))),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            // 从 drizzle 的 SQL 对象里拿不到 id 列表，测试里用"当前全部行"近似，
            // 具体哪些会命中由用例里的 feeds 状态决定（见各用例断言）
            state.updates.push({ set: values, ids: cond as unknown as string[] })
            const affected = state.feeds.filter((f) => {
              if ("status" in values && values.status === "paused" && f.status !== "active") return false
              if ("orphanSince" in values && values.orphanSince === null) return f.orphanSince !== null
              if ("orphanSince" in values) return f.orphanSince === null
              return true
            })
            return { returning: async () => affected.map((f) => ({ id: f.id, url: `https://x/${f.id}` })) }
          },
        }),
      }),
    },
    feeds,
    user,
    botFeeds,
  }
})

vi.mock("../couchdb/client", () => ({
  createCouchDb: (dbName: string) => ({
    list: async () => {
      if (state.failingDbs.has(dbName)) throw new Error("db down")
      const ids = state.subscriptions.get(dbName) ?? []
      return { rows: ids.map((feedId) => ({ id: `subscription:${feedId}`, doc: { feedId } })) }
    },
  }),
}))

vi.mock("../services/feed-deletion", () => ({
  deleteFeed: async (feedId: string) => {
    state.deleted.push(feedId)
    return { feedId, purgedUsers: 0, failures: [] }
  },
}))

vi.mock("../env", () => ({
  envInt: (_k: string, def: number) => def,
}))

const { sweepOrphanFeeds, orphanPolicy } = await import("../services/feed-orphan-sweep")

function feed(
  id: string,
  opts: Partial<{ status: string, pausedBySystem: boolean | null, orphanSince: Date | null }> = {},
) {
  return {
    id,
    status: opts.status ?? "active",
    pausedBySystem: opts.pausedBySystem ?? null,
    orphanSince: opts.orphanSince ?? null,
  }
}

beforeEach(() => {
  state.users = [{ id: "u1", dbName: "db_u1" }]
  state.subscriptions = new Map()
  state.failingDbs = new Set()
  state.botRefs = []
  state.feeds = []
  state.updates = []
  state.deleted = []
})

describe("sweepOrphanFeeds：标记阶段", () => {
  it("首次发现零订阅只打标记，不暂停", async () => {
    state.feeds = [feed("f1")]

    const r = await sweepOrphanFeeds()

    expect(r.marked).toBe(1)
    expect(r.paused).toBe(0)
    expect(r.deleted).toBe(0)
    expect(state.updates.some((u) => "orphanSince" in u.set)).toBe(true)
  })

  it("有人订阅的源不会被打标记", async () => {
    state.subscriptions = new Map([["db_u1", ["f1"]]])
    state.feeds = [feed("f1")]

    const r = await sweepOrphanFeeds()

    expect(r.marked).toBe(0)
  })

  it("Bot 引用的源不算孤儿", async () => {
    state.botRefs = ["f1"]
    state.feeds = [feed("f1")]

    const r = await sweepOrphanFeeds()

    expect(r.marked).toBe(0)
  })

  it("重新出现订阅者时清掉 orphanSince", async () => {
    state.subscriptions = new Map([["db_u1", ["f1"]]])
    state.feeds = [feed("f1", { orphanSince: new Date(Date.now() - 100 * DAY) })]

    const r = await sweepOrphanFeeds()

    expect(r.cleared).toBe(1)
    expect(state.updates.some((u) => u.set.orphanSince === null)).toBe(true)
  })
})

describe("sweepOrphanFeeds：冷静期", () => {
  it("孤儿未满 7 天不暂停", async () => {
    state.feeds = [feed("f1", { orphanSince: new Date(Date.now() - 3 * DAY) })]

    const r = await sweepOrphanFeeds()

    expect(r.paused).toBe(0)
  })

  it("孤儿满 7 天（仍在抓）会被暂停", async () => {
    state.feeds = [feed("f1", { orphanSince: new Date(Date.now() - 8 * DAY) })]

    const r = await sweepOrphanFeeds()

    expect(r.paused).toBe(1)
    expect(state.updates.some((u) => u.set.status === "paused" && u.set.pausedBySystem === true)).toBe(true)
  })
})

describe("sweepOrphanFeeds：删除阶段", () => {
  it("自动暂停满 30 天仍零订阅 → 删除", async () => {
    state.feeds = [feed("f1", {
      status: "paused",
      pausedBySystem: true,
      orphanSince: new Date(Date.now() - 31 * DAY),
    })]

    const r = await sweepOrphanFeeds()

    expect(r.deleted).toBe(1)
    expect(state.deleted).toEqual(["f1"])
  })

  it("暂停未满 30 天不删除", async () => {
    state.feeds = [feed("f1", {
      status: "paused",
      pausedBySystem: true,
      orphanSince: new Date(Date.now() - 10 * DAY),
    })]

    const r = await sweepOrphanFeeds()

    expect(r.deleted).toBe(0)
  })

  it("管理员手动暂停的源**永远不**进入删除候选", async () => {
    // pausedBySystem 不是 true（手动暂停时被清成 null）
    state.feeds = [feed("f1", {
      status: "paused",
      pausedBySystem: null,
      orphanSince: new Date(Date.now() - 365 * DAY),
    })]

    const r = await sweepOrphanFeeds()

    expect(r.deleted).toBe(0)
    expect(state.deleted).toEqual([])
  })
})

describe("sweepOrphanFeeds：安全护栏", () => {
  it("订阅库读取失败时整体跳过本轮", async () => {
    state.failingDbs = new Set(["db_u1"])
    state.feeds = [feed("f1", { orphanSince: new Date(Date.now() - 40 * DAY), status: "paused", pausedBySystem: true })]

    const r = await sweepOrphanFeeds()

    expect(r.aborted).toBe(true)
    expect(r.deleted).toBe(0)
    expect(state.updates).toEqual([])
  })
})

describe("orphanPolicy", () => {
  it("回传两级天数供前端展示", () => {
    const p = orphanPolicy()
    expect(p).toMatchObject({ pauseAfterDays: 7, deleteAfterDays: 30, enabled: true })
  })
})
