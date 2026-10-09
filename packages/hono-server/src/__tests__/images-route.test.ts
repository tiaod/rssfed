import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 登录态可切换（默认已登录），用于覆盖 401 分支
const state = vi.hoisted(() => ({
  session: { user: { id: "test-user" } } as { user: { id: string } } | null,
  calls: [] as Array<{ url: string, maxWidth?: number, quality?: number }>,
  allowPrivate: undefined as boolean | undefined,
  result: { ok: true as const, key: "image-cache/v1/x.avif", buffer: Buffer.from("avif"), contentType: "image/avif" as const, width: 10, height: 20, sourceUrl: "u", hit: true },
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

// 真正下载/压缩的行为在 image-cache.test.ts 里覆盖；这里只验证路由的参数校验与响应形状
vi.mock("../images/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../images/cache")>()
  return {
    ...actual,
    getCompressedImage: async (
      req: { url: string, maxWidth?: number, quality?: number },
      opts: { allowPrivateHosts?: boolean } = {},
    ) => {
      state.calls.push({ url: req.url, maxWidth: req.maxWidth, quality: req.quality })
      state.allowPrivate = opts.allowPrivateHosts
      return state.result
    },
  }
})

const { app } = await import("../app")

beforeEach(() => {
  state.session = { user: { id: "test-user" } }
  state.calls = []
  state.allowPrivate = undefined
  state.result = {
    ok: true,
    key: "image-cache/v1/x.avif",
    buffer: Buffer.from("avif"),
    contentType: "image/avif",
    width: 10,
    height: 20,
    sourceUrl: "https://cdn.test/a.png",
    hit: true,
  }
  delete process.env.IMAGE_CACHE_ALLOW_PRIVATE_HOSTS
})

afterEach(() => {
  delete process.env.IMAGE_CACHE_ALLOW_PRIVATE_HOSTS
})

const TARGET = "https://cdn.test/a.png"

describe("GET /api/images/cached", () => {
  it("未登录返回 401", async () => {
    state.session = null
    const res = await app.request(`/api/images/cached?url=${encodeURIComponent(TARGET)}`)
    expect(res.status).toBe(401)
    expect(state.calls).toHaveLength(0)
  })

  it("缺 url 返回 400", async () => {
    const res = await app.request("/api/images/cached")
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "missing_url" })
  })

  it("越界/非法的 w 与 q 返回 400（不静默改用默认值）", async () => {
    for (const query of ["w=0", "w=99999", "w=abc", "q=0", "q=101", "q=1.5"]) {
      const res = await app.request(`/api/images/cached?url=${encodeURIComponent(TARGET)}&${query}`)
      expect(res.status, query).toBe(400)
    }
    expect(state.calls).toHaveLength(0)
  })

  it("合法请求返回 AVIF 与长缓存头，参数透传给缓存层", async () => {
    const res = await app.request(`/api/images/cached?url=${encodeURIComponent(TARGET)}&w=400&q=60`)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/avif")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
    expect(res.headers.get("X-Image-Cache")).toBe("hit")
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("avif")
    expect(state.calls).toEqual([{ url: TARGET, maxWidth: 400, quality: 60 }])
  })

  it("不传 w/q 时交给缓存层用全局默认", async () => {
    const res = await app.request(`/api/images/cached?url=${encodeURIComponent(TARGET)}`)
    expect(res.status).toBe(200)
    expect(state.calls).toEqual([{ url: TARGET, maxWidth: undefined, quality: undefined }])
  })

  it("取图失败返回 502 且带上原因", async () => {
    state.result = { ok: false, reason: "http-status" } as never
    const res = await app.request(`/api/images/cached?url=${encodeURIComponent(TARGET)}`)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: "image_unavailable", reason: "http-status" })
  })

  it("默认拒绝内网地址；IMAGE_CACHE_ALLOW_PRIVATE_HOSTS=true 才放开", async () => {
    await app.request(`/api/images/cached?url=${encodeURIComponent("http://127.0.0.1/a.png")}`)
    expect(state.allowPrivate).toBe(false)

    process.env.IMAGE_CACHE_ALLOW_PRIVATE_HOSTS = "true"
    await app.request(`/api/images/cached?url=${encodeURIComponent("http://127.0.0.1/a.png")}`)
    expect(state.allowPrivate).toBe(true)
  })
})
