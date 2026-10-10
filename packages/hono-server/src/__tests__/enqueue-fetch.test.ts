import { describe, expect, it, vi } from "vitest"
import type { Queue } from "bullmq"
import { enqueueFetchJob } from "../workers/enqueue"

/**
 * 钉住 enqueueFetch 的「先清后入队」语义。
 *
 * BullMQ 同 jobId 的 `add` 是静默无效的（保留旧 payload），所以入队前必须处理掉旧 job：
 * 漏了这一步，改完订阅 URL 再点「立即抓取」就不会生效，队列里跑的还是旧地址。
 */

function fakeJob(state: string) {
  return {
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => {}),
    updateData: vi.fn(async () => {}),
  }
}

function fakeQueue(job?: ReturnType<typeof fakeJob>) {
  const add = vi.fn(async () => ({}))
  return { queue: { getJob: vi.fn(async () => job), add } as unknown as Queue, add }
}

describe("enqueueFetchJob", () => {
  it("没有旧 job 时直接入队（name/data/jobId 约定）", async () => {
    const { queue, add } = fakeQueue()
    await enqueueFetchJob(queue, "f1", "https://rsshub.app/feed")

    expect(add).toHaveBeenCalledTimes(1)
    const [name, data, opts] = add.mock.calls[0] as unknown as [string, unknown, { jobId: string }]
    expect(name).toBe("fetch:f1")
    expect(data).toEqual({ feedId: "f1", url: "https://rsshub.app/feed" })
    expect(opts.jobId).toBe("f1")
  })

  it("旧 job 还在排队（waiting）时先删掉再入队 —— 否则新 URL 会被 jobId 去重静默吞掉", async () => {
    const job = fakeJob("waiting")
    const { queue, add } = fakeQueue(job)
    await enqueueFetchJob(queue, "f1", "https://rsshub.app/new")

    expect(job.remove).toHaveBeenCalledTimes(1)
    expect(job.updateData).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledTimes(1)
  })

  it("旧 job 已结束（completed/failed）时同样先删再入队", async () => {
    for (const state of ["completed", "failed"]) {
      const job = fakeJob(state)
      const { queue, add } = fakeQueue(job)
      await enqueueFetchJob(queue, "f1", "u")
      expect(job.remove, state).toHaveBeenCalledTimes(1)
      expect(add, state).toHaveBeenCalledTimes(1)
    }
  })

  it("旧 job 正在执行（active）时删不掉，改为把 payload 换成新 URL", async () => {
    const job = fakeJob("active")
    const { queue, add } = fakeQueue(job)
    await enqueueFetchJob(queue, "f1", "https://rsshub.app/new")

    expect(job.remove).not.toHaveBeenCalled()
    expect(job.updateData).toHaveBeenCalledWith({ feedId: "f1", url: "https://rsshub.app/new" })
    expect(add).toHaveBeenCalledTimes(1)
  })

  it("active job 的 updateData 被拒绝时不影响后续入队", async () => {
    const job = fakeJob("active")
    job.updateData.mockRejectedValueOnce(new Error("job is active"))
    const { queue, add } = fakeQueue(job)
    await expect(enqueueFetchJob(queue, "f1", "u")).resolves.toBeUndefined()
    expect(add).toHaveBeenCalledTimes(1)
  })
})
