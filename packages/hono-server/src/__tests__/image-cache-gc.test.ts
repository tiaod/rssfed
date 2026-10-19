import { describe, expect, it } from "vitest"
import { gcImageCache } from "../images/cache-gc"
import type { Storage } from "../storage"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-10-18T00:00:00Z")

/**
 * 内存 Storage：GC 单测只关心「列出来什么、删了哪些」。
 * 故意允许把不相关 key 也塞进来，用来验证 GC 自己的前缀过滤（不依赖 Storage 实现）。
 */
function memoryStorage(
  initial: Array<{ key: string, ageDays: number }>,
  options: { failKeys?: string[], listIgnoresPrefix?: boolean } = {},
) {
  const objects = new Map(initial.map(o => [o.key, { lastModified: new Date(NOW - o.ageDays * DAY) }]))
  const deleteCalls: string[] = []
  const failKeys = new Set(options.failKeys ?? [])
  const api: Storage & {
    objects: typeof objects
    deleteCalls: string[]
    listPrefixes: string[]
  } = {
    objects,
    deleteCalls,
    listPrefixes: [],
    write: async () => "",
    read: async () => Buffer.alloc(0),
    readWithMeta: async () => ({ content: Buffer.alloc(0), contentType: "image/avif" }),
    delete: async (key: string) => {
      if (failKeys.has(key)) throw new Error("delete failed")
      objects.delete(key)
      deleteCalls.push(key)
    },
    exists: async (key: string) => objects.has(key),
    async *listBatches(prefix: string, batchSize = 1000) {
      api.listPrefixes.push(prefix)
      const rows = [...objects.entries()]
        .filter(([key]) => options.listIgnoresPrefix || key.startsWith(prefix))
        .map(([key, object]) => ({ key, lastModified: object.lastModified, size: 1 }))
      const size = Math.max(1, Math.trunc(batchSize))
      for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size)
    },
    getPublicUrl: () => undefined,
  }
  return api
}

describe("gcImageCache：按时间清理图片缓存", () => {
  it("删过期 AVIF；历史 sidecar 不管年龄都删；未到期 AVIF 保留", async () => {
    const storage = memoryStorage([
      { key: "image-cache/v1/old.avif", ageDays: 40 },
      { key: "image-cache/v1/new.avif", ageDays: 1 },
      { key: "image-cache/v1/old.json", ageDays: 40 },
      { key: "image-cache/v1/new.json", ageDays: 1 },
    ])
    const result = await gcImageCache({ storage, ttlDays: 30, now: NOW })

    expect(result).toEqual({
      scanned: 4,
      scannedBytes: 4,
      oldestAgeDays: 40,
      deleted: 3,
      deletedBytes: 3,
      deletedLegacyMeta: 2, // sidecar 已无读者，不看年龄
      deletedExpired: 1, // old.avif
      failed: 0,
      kept: 1, // new.avif
      capped: false,
    })
    expect([...storage.objects.keys()]).toEqual(["image-cache/v1/new.avif"])
  })

  it("流式扫描：按批处理、边扫边删，跨批的删除上限与统计都正确", async () => {
    const storage = memoryStorage([
      { key: "image-cache/v1/a.avif", ageDays: 40 },
      { key: "image-cache/v1/b.avif", ageDays: 41 },
      { key: "image-cache/v1/c.avif", ageDays: 42 },
      { key: "image-cache/v1/d.avif", ageDays: 1 },
      { key: "image-cache/v1/e.json", ageDays: 1 },
    ])
    // batchSize=1：每个对象一批，验证「达上限跨批收手」与跨批统计
    const first = await gcImageCache({ storage, ttlDays: 30, now: NOW, maxDeletes: 2, batchSize: 1 })
    expect(first.scanned).toBe(5)
    expect(first.scannedBytes).toBe(5)
    expect(first.deleted).toBe(2)
    expect(first.capped).toBe(true)
    expect(first.oldestAgeDays).toBe(42)
    expect([...storage.objects.keys()]).toEqual([
      "image-cache/v1/c.avif",
      "image-cache/v1/d.avif",
      "image-cache/v1/e.json",
    ])

    const second = await gcImageCache({ storage, ttlDays: 30, now: NOW, maxDeletes: 2, batchSize: 2 })
    expect(second.deleted).toBe(2) // c.avif 过期 + e.json sidecar
    expect(second.capped).toBe(false)
    expect([...storage.objects.keys()]).toEqual(["image-cache/v1/d.avif"])
  })

  it("边界：恰好到期不算过期（必须严格大于 TTL）", async () => {
    const storage = memoryStorage([{ key: "image-cache/v1/edge.avif", ageDays: 30 }])
    const result = await gcImageCache({ storage, ttlDays: 30, now: NOW })
    expect(result.deleted).toBe(0)
    expect(result.kept).toBe(1)
  })

  it("单轮删除上限：删到上限就收手，下一轮继续", async () => {
    const storage = memoryStorage([
      { key: "image-cache/v1/a.avif", ageDays: 40 },
      { key: "image-cache/v1/b.avif", ageDays: 40 },
      { key: "image-cache/v1/c.avif", ageDays: 40 },
    ])
    const first = await gcImageCache({ storage, ttlDays: 30, now: NOW, maxDeletes: 2 })
    expect(first.deleted).toBe(2)
    expect(first.capped).toBe(true)
    expect(first.kept).toBe(1)

    const second = await gcImageCache({ storage, ttlDays: 30, now: NOW, maxDeletes: 2 })
    expect(second.deleted).toBe(1)
    expect(second.capped).toBe(false)
    expect(storage.objects.size).toBe(0)
  })

  it("ttlDays <= 0 表示关闭清理：一个都不删", async () => {
    const storage = memoryStorage([{ key: "image-cache/v1/a.avif", ageDays: 999 }])
    const result = await gcImageCache({ storage, ttlDays: 0, now: NOW })
    expect(result.scanned).toBe(0)
    expect(result.deleted).toBe(0)
    expect(storage.deleteCalls).toEqual([])
  })

  it("删除失败只计数不抛错，其余对象照删", async () => {
    const storage = memoryStorage(
      [
        { key: "image-cache/v1/a.avif", ageDays: 40 },
        { key: "image-cache/v1/b.avif", ageDays: 40 },
      ],
      { failKeys: ["image-cache/v1/a.avif"] },
    )
    const result = await gcImageCache({ storage, ttlDays: 30, now: NOW })
    expect(result.deleted).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.kept).toBe(1) // 失败的那个还在
  })

  it("前缀外的对象不删（Storage 实现返回多余 key 时的防御）", async () => {
    const storage = memoryStorage(
      [
        { key: "image-cache/v1/a.avif", ageDays: 40 },
        { key: "user-uploads/avatar.png", ageDays: 999 },
      ],
      { listIgnoresPrefix: true },
    )
    const result = await gcImageCache({ storage, ttlDays: 30, now: NOW })
    expect(result.scanned).toBe(1)
    expect(storage.deleteCalls).toEqual(["image-cache/v1/a.avif"])
    expect(storage.objects.has("user-uploads/avatar.png")).toBe(true)
  })

  it("按 ImageCache 前缀列对象（不误扫上传类附件）", async () => {
    const storage = memoryStorage([])
    await gcImageCache({ storage, ttlDays: 30, now: NOW })
    expect(storage.listPrefixes).toEqual(["image-cache/"])
  })
})
