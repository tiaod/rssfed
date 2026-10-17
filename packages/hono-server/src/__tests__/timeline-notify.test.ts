import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「有源变了」的唤醒策略：只叫醒订阅者 + 窗口内攒源。
 *
 * 实测背景：第一版是给**所有用户**广播，一个没有任何订阅的账号 4 小时也被叫醒 332 次。
 * 现在反查时会连"水位是否已追平"一起判掉，所以只有**确实有内容要搬**的用户会被叫醒；
 * 再加上每用户 5 分钟的汇聚冷却（窗口内排到冷却结束，不丢弃）。
 */

const mocks = vi.hoisted(() => ({
  /** 反查时被问到的源 id 批次（一次窗口一批） */
  queried: [] as string[][],
  /** 这些源里"确实有内容要搬"的用户 */
  subscribers: [] as string[],
  /** 入队的 job（含 delay，用于验证冷却） */
  added: [] as Array<{ name: string, userId: string, delay: number }>,
  /** 上一轮聚合结束时刻（心跳）；null = 没有过任何一轮 */
  heartbeatAt: null as Date | null,
}))

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob() {
      return undefined
    }

    async add(name: string, data: { userId: string }, opts: { delay?: number } = {}) {
      mocks.added.push({ name, userId: data.userId, delay: opts.delay ?? 0 })
      return {}
    }
  },
  Worker: class {
    async close() {}
  },
}))

vi.mock("../workers/connection", () => ({
  connection: {},
  createWorkerConnection: () => ({}),
}))

vi.mock("../workers/timeline-sync", () => ({
  enqueueSourceSyncs: async () => [],
  shutdownSourceSyncWorker: async () => {},
}))

vi.mock("../services/timeline", () => ({
  listUserIds: async () => [],
  rebuildUserTimeline: async () => ({}),
  reconcileUserTimeline: async () => ({}),
  listDirtySubscribers: async (sourceIds: string[]) => {
    mocks.queried.push(sourceIds)
    return mocks.subscribers
  },
}))

vi.mock("../services/timeline-events", () => ({
  readReconcileHeartbeat: async () => (mocks.heartbeatAt ? { at: mocks.heartbeatAt, quietRounds: 0 } : null),
}))

const { enqueueTimelineReconcile, notifyTimelineStale } = await import("../workers/timeline")

beforeEach(() => {
  mocks.queried = []
  mocks.subscribers = []
  mocks.added = []
  mocks.heartbeatAt = null
})

describe("notifyTimelineStale", () => {
  it("只叫醒订阅了该源的用户（不再给所有用户广播）", async () => {
    mocks.subscribers = ["u1"]
    await notifyTimelineStale("feedA", 1_000_000)
    expect(mocks.queried).toEqual([["feedA"]])
    expect(mocks.added).toEqual([{ name: "reconcile", userId: "u1", delay: 0 }])
  })

  it("没有订阅者就什么都不做", async () => {
    mocks.subscribers = []
    await notifyTimelineStale("feedWithNobody", 2_000_000)
    expect(mocks.queried).toEqual([["feedWithNobody"]])
    expect(mocks.added).toEqual([])
  })

  it("节流窗口内的源先攒着，窗口一开合并成一次反查", async () => {
    mocks.subscribers = ["u1"]
    // 窗口已开（now 远大于上次）
    await notifyTimelineStale("feedA", 3_000_000)
    // 30 秒内：只攒不查
    await notifyTimelineStale("feedB", 3_010_000)
    await notifyTimelineStale("feedC", 3_020_000)
    expect(mocks.queried).toEqual([["feedA"]])
    // 窗口到了：把攒下的 B/C 一起查
    await notifyTimelineStale("feedD", 3_040_000)
    expect(mocks.queried).toEqual([["feedA"], ["feedB", "feedC", "feedD"]])
  })
})

describe("enqueueTimelineReconcile 的冷却", () => {
  it("上一轮刚跑完：排到冷却结束（5 分钟窗口），而不是丢弃", async () => {
    // 1 分钟前跑完一轮 → 还要等 4 分钟左右
    mocks.heartbeatAt = new Date(Date.now() - 60_000)
    await enqueueTimelineReconcile("u1")
    const job = mocks.added[0]!
    expect(job.delay).toBeGreaterThan(3 * 60_000)
    expect(job.delay).toBeLessThanOrEqual(5 * 60_000)
  })

  it("冷却已过：立刻入队", async () => {
    mocks.heartbeatAt = new Date(Date.now() - 6 * 60_000)
    await enqueueTimelineReconcile("u1")
    expect(mocks.added[0]!.delay).toBe(0)
  })

  it("从没跑过聚合：立刻入队", async () => {
    mocks.heartbeatAt = null
    await enqueueTimelineReconcile("u1")
    expect(mocks.added[0]!.delay).toBe(0)
  })

  it("force（手动同步/强刷）绕过冷却", async () => {
    mocks.heartbeatAt = new Date(Date.now() - 10_000)
    await enqueueTimelineReconcile("u1", { force: true })
    expect(mocks.added[0]!.delay).toBe(0)
  })
})
