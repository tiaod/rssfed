import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Storage } from "../storage"
import type { FeedFetchResult } from "../rss/parser"
import type { FetchCacheMeta } from "../rss/fetch-cache"

/**
 * 抓取缓存：**按 URL** 缓存正文与条件请求验证器。
 *
 * 这是新模型里唯一的跨 owner 共享 —— 同一个源被 N 个用户订阅时，
 * 能不能只出一次网全看这里。判错的两个方向代价不对称：
 *   - 该命中没命中：多一次网络请求（可接受，只是慢/费带宽）；
 *   - 该重抓没重抓：内容陈旧，用户看到"这个源不更新了"（且没有任何报错）。
 * 所以 TTL 的边界与"304 但正文没了"这条分支必须钉住。
 */
const {
  getFeedContent,
  readFetchCacheMeta,
  invalidateFetchCache,
  fetchCacheKey,
  resetFetchCacheInflight,
  FETCH_CACHE_VERSION,
} = await import("../rss/fetch-cache")

/** 内存版 Storage（只实现缓存用到的四个方法） */
function memoryStorage(): Storage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()
  return {
    objects,
    write: async (content: Buffer, key: string) => {
      objects.set(key, content)
      return key
    },
    read: async (key: string) => {
      const value = objects.get(key)
      if (!value) throw Object.assign(new Error("not found"), { statusCode: 404 })
      return value
    },
    readWithMeta: async (key: string) => {
      const content = objects.get(key)
      if (!content) throw new Error("not found")
      return { content, contentType: "application/octet-stream" }
    },
    delete: async (key: string) => {
      objects.delete(key)
    },
    exists: async (key: string) => objects.has(key),
    listBatches: async function* () {},
    getPublicUrl: () => undefined,
  }
}

const URL = "https://example.com/feed.xml"
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>示例</title></channel></rss>`

const okFetch = (content = RSS, etag?: string) => vi.fn(async (): Promise<FeedFetchResult> => ({
  notModified: false,
  content,
  etag,
  validatorUrl: URL,
}))

let storage: ReturnType<typeof memoryStorage>

beforeEach(() => {
  storage = memoryStorage()
  resetFetchCacheInflight()
})

describe("getFeedContent：缓存命中", () => {
  it("首次抓取：发请求、写正文与 meta，fromCache=false", async () => {
    const doFetch = okFetch(RSS, '"v1"')
    const now = () => 1_000_000
    const result = await getFeedContent(URL, { storage, fetch: doFetch, now, ttlMs: 60_000 })

    expect(doFetch).toHaveBeenCalledTimes(1)
    expect(result.fromCache).toBe(false)
    expect(result.content).toBe(RSS)
    expect(result.meta).toMatchObject({
      version: FETCH_CACHE_VERSION,
      url: URL,
      etag: '"v1"',
      hasValidators: true,
    })
    // 正文与 meta 都落了盘
    expect(storage.objects.size).toBe(2)
  })

  it("TTL 内的第二次：**一个网络请求都不发**（这是多 owner 订阅同源省下 egress 的主路径）", async () => {
    const doFetch = okFetch()
    let clock = 1_000_000
    await getFeedContent(URL, { storage, fetch: doFetch, now: () => clock, ttlMs: 60_000 })

    clock += 30_000 // 还没过期
    const second = await getFeedContent(URL, { storage, fetch: doFetch, now: () => clock, ttlMs: 60_000 })

    expect(doFetch).toHaveBeenCalledTimes(1)
    expect(second.fromCache).toBe(true)
    expect(second.content).toBe(RSS)
  })

  it("过了 TTL：带验证器重抓；服务端 304 时复用缓存正文，且不发第二次请求", async () => {
    const full = okFetch(RSS, '"v1"')
    let clock = 1_000_000
    await getFeedContent(URL, { storage, fetch: full, now: () => clock, ttlMs: 60_000 })

    clock += 120_000 // 过期
    const conditional = vi.fn(async (_url: string, _validators?: unknown): Promise<FeedFetchResult> => ({
      notModified: true, etag: '"v1"', validatorUrl: URL,
    }))
    const result = await getFeedContent(URL, { storage, fetch: conditional, now: () => clock, ttlMs: 60_000 })

    expect(conditional).toHaveBeenCalledTimes(1)
    // 条件请求带上了缓存里的验证器
    expect(conditional.mock.calls[0]![1]).toMatchObject({ etag: '"v1"', url: URL })
    expect(result.fromCache).toBe(true)
    expect(result.content).toBe(RSS)
    // 304 之后 meta 的时间被刷新：下一个 TTL 窗口重新计时
    const meta = await readFetchCacheMeta(URL, { storage })
    expect(meta?.fetchedAt).toBe(new Date(clock).toISOString())
  })
})

describe("getFeedContent：必须重抓的分支", () => {
  it("304 但正文已被 GC 删掉：补一次**不带验证器**的全量请求（否则会陷入永远 304）", async () => {
    const full = okFetch(RSS, '"v1"')
    let clock = 1_000_000
    await getFeedContent(URL, { storage, fetch: full, now: () => clock, ttlMs: 60_000 })

    // 模拟 GC：只删正文，meta 还在
    for (const key of [...storage.objects.keys()]) {
      if (key.endsWith("/body.gz")) storage.objects.delete(key)
    }

    clock += 120_000
    const calls: Array<unknown> = []
    const mixed = vi.fn(async (_url: string, validators?: unknown): Promise<FeedFetchResult> => {
      calls.push(validators)
      // 第一次带验证器 → 304；第二次不带 → 必须给内容
      return validators ? { notModified: true, etag: '"v1"', validatorUrl: URL } : { notModified: false, content: RSS, etag: '"v1"', validatorUrl: URL }
    })
    const result = await getFeedContent(URL, { storage, fetch: mixed, now: () => clock, ttlMs: 60_000 })

    expect(mixed).toHaveBeenCalledTimes(2)
    expect(calls[0]).toBeTruthy()
    expect(calls[1]).toBeUndefined()
    expect(result.content).toBe(RSS)
    expect(result.fromCache).toBe(false)
  })

  it("不带验证器仍然 304：按失败处理（服务端行为异常，不能假装成功）", async () => {
    await expect(getFeedContent(URL, {
      storage,
      fetch: vi.fn(async (): Promise<FeedFetchResult> => ({ notModified: true, validatorUrl: URL })),
      now: () => 1_000_000,
      ttlMs: 60_000,
    })).rejects.toThrow(/304/)
  })

  it("网络错误原样抛出（调用方要据此记 errorStreak，不能被吞成「没内容」）", async () => {
    const boom = vi.fn(async (): Promise<FeedFetchResult> => {
      throw new Error("ETIMEDOUT")
    })
    await expect(getFeedContent(URL, { storage, fetch: boom, now: () => 1_000_000 }))
      .rejects.toThrow("ETIMEDOUT")
  })

  it("meta 损坏按「没有缓存」处理：重抓而不是让这个源永久失败", async () => {
    const doFetch = okFetch()
    await getFeedContent(URL, { storage, fetch: doFetch, now: () => 1_000_000, ttlMs: 60_000 })
    // 把 meta 写坏
    for (const [key] of storage.objects) {
      if (key.endsWith("/meta.json")) storage.objects.set(key, Buffer.from("{not json"))
    }
    const second = await getFeedContent(URL, { storage, fetch: doFetch, now: () => 1_000_000, ttlMs: 60_000 })
    expect(doFetch).toHaveBeenCalledTimes(2)
    expect(second.content).toBe(RSS)
  })

  it("写缓存失败不影响本轮：调用方仍拿到内存里的正文", async () => {
    const brokenStorage = { ...memoryStorage(), write: async () => { throw new Error("bucket down") } } as unknown as Storage
    const doFetch = okFetch()
    const result = await getFeedContent(URL, { storage: brokenStorage, fetch: doFetch, now: () => 1_000_000 })
    expect(result.content).toBe(RSS)
    expect(result.fromCache).toBe(false)
  })
})

/**
 * 等到 `fetch` 真的被调用（`runFetch` 要先读 meta 才发请求，中间有若干个 microtask）。
 * 直接 `await Promise.resolve()` 一两次是不够的 —— 那样 resolve 回调还没被赋值，
 * 用例会挂到超时（这是测过的真实坑，不是猜的）。
 */
async function waitForCall(fn: { mock: { calls: unknown[] } }, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (fn.mock.calls.length === 0) {
    if (Date.now() > deadline) throw new Error("fetch 一直没被调用")
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

describe("单飞（同一 URL 并发只出一次网）", () => {
  it("N 个并发调用合并成 1 次请求，其余拿到同一份内容", async () => {
    let resolveFetch: (value: FeedFetchResult) => void = () => {}
    const slow = vi.fn(() => new Promise<FeedFetchResult>((resolve) => {
      resolveFetch = resolve
    }))

    const calls = Array.from({ length: 5 }, () =>
      getFeedContent(URL, { storage, fetch: slow, now: () => 1_000_000, ttlMs: 60_000 }))

    // 等真正的请求发出（此时其余 4 个调用已经搭在同一份 inflight 上）
    await waitForCall(slow)
    resolveFetch({ notModified: false, content: RSS, etag: '"v1"', validatorUrl: URL })

    const results = await Promise.all(calls)
    expect(slow).toHaveBeenCalledTimes(1)
    expect(results.every((r) => r.content === RSS)).toBe(true)
  })

  it("单飞合并出来的调用方也标 fromCache（对它而言确实没发请求）", async () => {
    let resolveFetch: (value: FeedFetchResult) => void = () => {}
    const slow = vi.fn(() => new Promise<FeedFetchResult>((resolve) => {
      resolveFetch = resolve
    }))
    const first = getFeedContent(URL, { storage, fetch: slow, now: () => 1_000_000 })
    const second = getFeedContent(URL, { storage, fetch: slow, now: () => 1_000_000 })
    await waitForCall(slow)
    resolveFetch({ notModified: false, content: RSS, validatorUrl: URL })

    const [a, b] = await Promise.all([first, second])
    expect(a.fromCache).toBe(false)
    expect(b.fromCache).toBe(true)
  })

  it("单飞里的失败会传播给所有等待者，且不会留在表里（下次能重试）", async () => {
    const failing = vi.fn(async (): Promise<FeedFetchResult> => {
      throw new Error("boom")
    })
    // 两个 promise 都要**立刻**挂上 rejection handler：等 waitForCall 之后再 allSettled
    // 会让 node 在这段间隙里报 unhandled rejection（vitest 会把它算成额外错误）
    const settled = Promise.allSettled([
      getFeedContent(URL, { storage, fetch: failing, now: () => 1_000_000 }),
      getFeedContent(URL, { storage, fetch: failing, now: () => 1_000_000 }),
    ])
    await waitForCall(failing)
    const results = await settled
    expect(results.every((r) => r.status === "rejected")).toBe(true)
    expect(failing).toHaveBeenCalledTimes(1)

    // 表已清空：下一次能重新发起
    const ok = okFetch()
    await getFeedContent(URL, { storage, fetch: ok, now: () => 1_000_000, ttlMs: 60_000 })
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe("invalidateFetchCache", () => {
  it("删掉后下一次会重新抓（「立即抓取」按钮的语义）", async () => {
    const doFetch = okFetch()
    await getFeedContent(URL, { storage, fetch: doFetch, now: () => 1_000_000, ttlMs: 60_000 })
    expect(storage.objects.size).toBe(2)

    await invalidateFetchCache(URL, { storage })
    expect(storage.objects.size).toBe(0)

    await getFeedContent(URL, { storage, fetch: doFetch, now: () => 1_000_000, ttlMs: 60_000 })
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  it("删不存在的 key 不报错（缓存本来就可丢）", async () => {
    await expect(invalidateFetchCache("https://never.test/feed", { storage })).resolves.toBeUndefined()
  })
})

describe("缓存 key", () => {
  it("同一个 URL 恒定；不同 URL 分开", () => {
    expect(fetchCacheKey(URL)).toBe(fetchCacheKey(URL))
    expect(fetchCacheKey(URL)).not.toBe(fetchCacheKey("https://other.test/feed"))
    expect(fetchCacheKey(URL)).toContain("fetch-cache")
  })
})

describe("readFetchCacheMeta", () => {
  it("没有缓存时返回 null（抓取 worker 据此按「有验证器」保守处理）", async () => {
    expect(await readFetchCacheMeta(URL, { storage })).toBeNull()
  })

  it("命中时返回完整 meta（含 hasValidators）", async () => {
    await getFeedContent(URL, {
      storage,
      fetch: vi.fn(async (): Promise<FeedFetchResult> => ({
        notModified: false, content: RSS, validatorUrl: URL,
      })),
      now: () => 1_000_000,
    })
    const meta = await readFetchCacheMeta(URL, { storage })
    expect(meta).toMatchObject<Partial<FetchCacheMeta>>({ url: URL, hasValidators: false })
  })
})
