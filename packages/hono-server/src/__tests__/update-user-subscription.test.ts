import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `updateUserSubscription` 的契约 —— 用户级（个人）订阅字段修改。
 *
 * 这里钉住三件事，因为这三件都曾经在 MCP 侧被搞错：
 *  1. 写的是**用户库里的 `subscription:` 文档**（前端读的就是它），而不是 PG 的 `feeds` 注册表；
 *  2. 只动传入的字段，undefined 表示「不改」（前端 updateSubscription 的语义）；
 *  3. 没订阅过的人返回 false —— 不能"顺手创建"一条订阅文档。
 *
 * 背景：MCP 的 `update_subscription` 原先调用 `updateSubscriptionMeta`，改的是全局注册表，
 * 于是「用 MCP 改了标题，界面毫无变化」；同时它还是个越权口子（普通 token 能改别人的源地址）。
 */

const state = vi.hoisted(() => ({
  /** 用户库里已有的 subscription 文档；null = 该 feed 没被订阅（get 抛 404） */
  doc: null as Record<string, any> | null,
  /** 记录 insert 收到的文档 */
  inserts: [] as Array<Record<string, any>>,
}))

vi.mock("../couchdb/client", () => ({
  createCouchDb: () => ({
    get: async (id: string) => {
      if (!state.doc) {
        const err = new Error("missing") as Error & { statusCode: number }
        err.statusCode = 404
        throw err
      }
      return JSON.parse(JSON.stringify(state.doc))
    },
    insert: async (doc: Record<string, any>) => {
      state.inserts.push(JSON.parse(JSON.stringify(doc)))
      return { ok: true }
    },
  }),
  ensureTimelineDatabase: async () => "user-timeline_test",
}))

vi.mock("../db", () => {
  // 这个测试不该碰 PostgreSQL：任何 db 访问都应该失败并暴露出来
  const boom = () => {
    throw new Error("updateUserSubscription 不应访问 PostgreSQL")
  }
  return {
    db: { update: boom, select: boom, insert: boom, query: {} },
    bots: { id: "id" },
  }
})

vi.mock("../workers", () => ({ enqueueOwnerFetch: async () => {} }))

const { updateUserSubscription } = await import("../services/feeds")

beforeEach(() => {
  state.doc = null
  state.inserts = []
})

describe("updateUserSubscription", () => {
  it("改显示名：写回用户库的 subscription 文档", async () => {
    state.doc = { _id: "subscription:f1", _rev: "1-a", feedId: "f1", type: "subscription", title: "旧名", category: "科技·AI" }

    const ok = await updateUserSubscription("u1", "f1", { title: "Dan Luu" })

    expect(ok).toBe(true)
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0]).toMatchObject({
      _id: "subscription:f1",
      title: "Dan Luu",
      category: "科技·AI", // 没传的字段保持原样
    })
  })

  it("undefined 表示「不动这个字段」，不能被写成 undefined 抹掉", async () => {
    state.doc = { _id: "subscription:f1", feedId: "f1", title: "旧名", category: "科技·AI" }

    await updateUserSubscription("u1", "f1", { category: "技术·深度博客" })

    expect(state.inserts[0]?.title).toBe("旧名")
    expect(state.inserts[0]?.category).toBe("技术·深度博客")
  })

  it("没订阅过 → false，且不写入任何文档（不能顺手造一条订阅）", async () => {
    state.doc = null

    const ok = await updateUserSubscription("u1", "not-mine", { title: "x" })

    expect(ok).toBe(false)
    expect(state.inserts).toHaveLength(0)
  })

  it("两个字段都没传 → false，不产生无意义修订", async () => {
    state.doc = { _id: "subscription:f1", feedId: "f1", title: "旧名" }

    const ok = await updateUserSubscription("u1", "f1", {})

    expect(ok).toBe(false)
    expect(state.inserts).toHaveLength(0)
  })

  it("保留订阅文档上的其它字段（view / createdAt / _rev 等）", async () => {
    state.doc = {
      _id: "subscription:f1",
      _rev: "3-c",
      feedId: "f1",
      title: "旧名",
      category: "科技·AI",
      view: "magazine",
      createdAt: "2026-10-24T15:09:37.104Z",
    }

    await updateUserSubscription("u1", "f1", { title: "新名" })

    expect(state.inserts[0]).toMatchObject({
      _rev: "3-c",
      view: "magazine",
      createdAt: "2026-10-24T15:09:37.104Z",
      title: "新名",
    })
  })
})
