import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 图片并发闸门（见 `images/concurrency.ts`）。
 *
 * 只测我们自己这部分：默认并发怎么按核数收敛、`IMAGE_CONCURRENCY` 是否生效、
 * 以及 `withImageSlot` 确实把同时执行数压在上限内（p-limit 自身的实现不重复测）。
 */

/** 让出若干个宏任务，等排队中的任务真正开始 */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** 用指定并发上限重新加载模块（模块在 import 时读环境变量，必须 resetModules） */
async function importLimiter(envValue: string) {
  process.env.IMAGE_CONCURRENCY = envValue
  vi.resetModules()
  return await import("../images/concurrency")
}

beforeEach(() => { delete process.env.IMAGE_CONCURRENCY })
afterEach(() => { delete process.env.IMAGE_CONCURRENCY })

describe("defaultImageConcurrency", () => {
  it("按核数收敛到 [1, 4]：2 核 1、4 核 2、8 核以上 4", async () => {
    const { defaultImageConcurrency } = await importLimiter("1")
    expect(defaultImageConcurrency(1)).toBe(1)
    expect(defaultImageConcurrency(2)).toBe(1)
    expect(defaultImageConcurrency(4)).toBe(2)
    expect(defaultImageConcurrency(8)).toBe(4)
    expect(defaultImageConcurrency(64)).toBe(4)
  })
})

describe("withImageSlot", () => {
  it("同时执行数不超过 IMAGE_CONCURRENCY，排队任务按调用顺序开始", async () => {
    const { withImageSlot, IMAGE_CONCURRENCY } = await importLimiter("2")
    expect(IMAGE_CONCURRENCY).toBe(2)

    const gate = deferred()
    const started: number[] = []
    let running = 0
    let peak = 0
    const run = (i: number) => withImageSlot(async () => {
      started.push(i)
      running++
      peak = Math.max(peak, running)
      await gate.promise
      running--
      return i
    })

    const all = [0, 1, 2, 3].map(run)
    await tick()
    // 前两个占住名额，后两个在排队
    expect(started).toEqual([0, 1])

    gate.resolve()
    await Promise.all(all)
    expect(peak).toBe(2)
    expect(started).toEqual([0, 1, 2, 3])
  })

  it("任务抛错时名额照样放行，后续任务不会被永久卡住", async () => {
    const { withImageSlot } = await importLimiter("1")
    await expect(withImageSlot(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(withImageSlot(async () => 42)).resolves.toBe(42)
  })

  it("IMAGE_CONCURRENCY 非法（空串 / 非整数）时回退到按核数的默认值", async () => {
    const { IMAGE_CONCURRENCY, defaultImageConcurrency } = await importLimiter("abc")
    expect(IMAGE_CONCURRENCY).toBe(defaultImageConcurrency())
  })
})
