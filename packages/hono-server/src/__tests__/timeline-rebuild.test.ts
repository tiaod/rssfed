import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 重建（改图片参数 / 显式 rebuild）必须**只**重算服务端独占写的内容。
 *
 * 合并成单库之后，用户库里的文档分两类：
 *   - 服务端写：`feed:{id}`、`entry:{...}`（重算得出来，重建时整体删掉再回填）
 *   - 客户端写：`subscription:`、`entry-state:`、`group-pref:`（用户意图，丢不得）
 *
 * 这条不变量很脆：改成「删库重建」时，用户订阅会被一起抹掉 —— 表现是「改一次图片设置，
 * 订阅全没了」，而且客户端还在同步那个已被销毁的库名。所以这里把「删哪些范围」钉死。
 */
const mocks = vi.hoisted(() => ({
  /** _all_docs 的分页响应：按 (startkey, endkey) 记录，返回预置的行 */
  listCalls: [] as Array<{ startkey: string, endkey: string, limit?: number }>,
  bulkCalls: [] as Array<Array<Record<string, unknown>>>,
  /** 每个前缀范围第一页要返回的行（第二页返回空，让分页循环退出） */
  rowsByRange: {} as Record<string, Array<{ id: string, value: { rev: string } }>>,
  destroy: vi.fn(),
  update: vi.fn(),
  ensureDb: vi.fn(async () => "user-timeline_test"),
  reconcile: vi.fn(async () => ({ userId: "u1", sources: 0 })),
}))

vi.mock("nano", () => ({
  default: () => ({
    db: { get: async () => ({ db_name: "x" }), create: async () => {}, destroy: mocks.destroy },
    use: () => ({}),
    request: async () => ({}),
  }),
}))

vi.mock("../db", () => ({
  db: {
    query: { user: { findFirst: mocks.ensureDb } },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "u1" }] }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  user: { id: "user.id", timelineDbName: "user.timeline_db_name" },
  userTimelineSettings: {},
}))

// 整体替换 CouchDB 客户端：本用例只关心「重建时删了哪些文档」，不需要真的连库
vi.mock("../couchdb/client", () => ({
    ensureTimelineDatabase: async () => "user-timeline_test",
    ensureBotDatabase: async () => "bot_test",
    ensureFeedDatabase: async () => "feed_test",
    nanoServer: { request: async () => ({}) },
    createCouchDb: () => ({
      list: async (opts: { startkey: string, endkey: string, limit?: number }) => {
        mocks.listCalls.push(opts)
        // 第一页给该范围预置的行，第二页给空（让 deleteByPrefix 的分页循环退出）
        const page = mocks.listCalls.filter(c => c.startkey === opts.startkey).length
        return { rows: page === 1 ? (mocks.rowsByRange[opts.startkey] ?? []) : [] }
      },
      bulk: async ({ docs }: { docs: Array<Record<string, unknown>> }) => {
        mocks.bulkCalls.push(docs)
        return docs.map(() => ({ ok: true }))
      },
    }),
}))

const { rebuildUserTimeline } = await import("../services/timeline")

beforeEach(() => {
  mocks.listCalls.length = 0
  mocks.bulkCalls.length = 0
  mocks.destroy.mockClear()
  mocks.rowsByRange = {
    "entry:": [
      { id: "entry:feed1:001", value: { rev: "1-a" } },
      { id: "entry:feed1:002", value: { rev: "1-b" } },
    ],
    "feed:": [{ id: "feed:feed1", value: { rev: "2-c" } }],
  }
})

describe("rebuildUserTimeline：就地删服务端内容", () => {
  it("不销毁库（用户状态文档与客户端同步都靠它活着）", async () => {
    await rebuildUserTimeline("u1")
    expect(mocks.destroy).not.toHaveBeenCalled()
  })

  it("只删 entry: 与 feed: 两个范围，且用 _deleted 标记而不是物理删", async () => {
    await rebuildUserTimeline("u1")

    const ranges = mocks.listCalls.map(c => `${c.startkey}..${c.endkey}`)
    expect(ranges).toContain("entry:..entry:\uffff")
    expect(ranges).toContain("feed:..feed:\uffff")

    // 删的只能是服务端写的那两条（状态文档不在范围里，所以压根不会出现在 bulk 里）
    const deletedIds = mocks.bulkCalls.flat().map(d => d._id)
    expect(deletedIds).toEqual(["entry:feed1:001", "entry:feed1:002", "feed:feed1"])
    expect(mocks.bulkCalls.flat().every(d => d._deleted === true && typeof d._rev === "string")).toBe(true)
  })

  it("状态文档不会落进删除范围（entry-state: 与 entry: 共享前缀，靠字典序分开）", () => {
    // entry-state:xxx 与 entry:xxx 只差第 5 个字符：'-' (0x2d) < ':' (0x3a)，所以它在范围之前
    expect("entry-state:abc" < "entry:").toBe(true)
    // 订阅与分组偏好根本不带 entry:/feed: 前缀，前缀范围天然碰不到
    expect("subscription:feed1".startsWith("entry:") || "subscription:feed1".startsWith("feed:")).toBe(false)
    expect("group-pref:g1".startsWith("entry:") || "group-pref:g1".startsWith("feed:")).toBe(false)
    expect("entry:feed1:001" >= "entry:" && "entry:feed1:001" <= "entry:\uffff").toBe(true)
  })
})
