import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「有源变了」的唤醒策略：只叫醒订阅者 + 窗口内攒源。
 *
 * 实测背景：第一版是给**所有用户**广播，一个没有任何订阅的账号 4 小时也被叫醒 332 次，
 * 每次都跑一轮只有心跳、没有流水的空转。广播改成按订阅者反查之后，这个账号一次都不该被叫醒。
 */

const mocks = vi.hoisted(() => ({
  /** 反查时被问到的源 id 批次（一次窗口一批） */
  queried: [] as string[][],
  /** 这些源对应的订阅者 */
  subscribers: [] as string[],
  /** 入队的 job（同一用户可能重复，jobId 去重由 BullMQ 负责） */
  added: [] as Array<{ name: string, userId: string }>,
}))

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob() {
      return undefined
    }

    async add(name: string, data: { userId: string }) {
      mocks.added.push({ name, userId: data.userId })
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
  listSubscriberUserIds: async (sourceIds: string[]) => {
    mocks.queried.push(sourceIds)
    return mocks.subscribers
  },
}))

const { notifyTimelineStale } = await import("../workers/timeline")

beforeEach(() => {
  mocks.queried = []
  mocks.subscribers = []
  mocks.added = []
})

describe("notifyTimelineStale", () => {
  it("只叫醒订阅了该源的用户（不再给所有用户广播）", async () => {
    mocks.subscribers = ["u1"]
    await notifyTimelineStale("feedA", 1_000_000)
    expect(mocks.queried).toEqual([["feedA"]])
    expect(mocks.added).toEqual([{ name: "reconcile", userId: "u1" }])
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
