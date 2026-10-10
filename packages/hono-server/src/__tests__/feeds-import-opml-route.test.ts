import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * POST /api/feeds/import-opml 的流式契约。
 *
 * 导入要给每个源联网解析一次（慢），所以响应体是逐源推进度的 NDJSON 流，而不是单个 JSON。
 * 这个文件钉住两件事：流里事件的形状与顺序，以及「开流前的失败仍是普通 JSON 错误」——
 * 后者关系到前端能否把 `OPML 中未发现任何订阅源` 之类的原因显示出来。
 */

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  /** url → 期望行为：ok=新订阅，duplicate=已订阅，fail=写入失败 */
  behavior: new Map<string, "ok" | "duplicate" | "fail">(),
  /** 已处理过的 url，用于确认去重后每个源只处理一次 */
  calls: [] as string[],
}))

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: async () => state.session },
    handler: async () => new Response(null, { status: 404 }),
  },
}))

// Redis / PG / CouchDB 都不在单测范围内：这里只验证路由的流式协议
vi.mock("../workers", () => ({ enqueueFetch: async () => {} }))

vi.mock("../couchdb/client", () => ({
  createCouchDb: () => ({ insert: async () => ({}) }),
  ensureTimelineDatabase: async () => "db_user",
  ensureFeedDatabase: async () => "db_feed",
}))

vi.mock("../services/feeds", () => ({
  resolveFeedId: async (url: string) => `id_${url}`,
  ensureFeedRegistered: async (item: { url: string }) => {
    state.calls.push(item.url)
    if (state.behavior.get(item.url) === "fail") throw new Error("boom")
    return { feedId: `id_${item.url}`, title: item.url }
  },
  addSubscriptionIfAbsent: async (_db: unknown, item: { url: string }) =>
    state.behavior.get(item.url) !== "duplicate",
  listSubscriptionsForUser: async () => [],
}))

const { feedsRouter } = await import("../routes/feeds")
const app = new Hono().route("/api/feeds", feedsRouter)

interface ImportEvent {
  type: string
  total?: number
  done?: number
  imported?: number
  skipped?: number
  failed?: number | { url: string, error: string }[]
  title?: string
  message?: string
}

function opmlOf(urls: string[]): string {
  return `<opml version="2.0"><body>${
    urls.map((u) => `<outline type="rss" text="${u}" xmlUrl="${u}"/>`).join("")
  }</body></opml>`
}

async function postImport(opml: string) {
  return app.request("/api/feeds/import-opml", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opml }),
  })
}

/** 把 NDJSON 响应读成事件数组（按行切，忽略空行） */
function readEvents(text: string): ImportEvent[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ImportEvent)
}

beforeEach(() => {
  state.session = { user: { id: "u1" } }
  state.behavior = new Map()
  state.calls = []
})

describe("POST /api/feeds/import-opml（流式）", () => {
  it("以 NDJSON 逐源回报进度，最后给出汇总", async () => {
    state.behavior.set("https://a.test/rss", "ok")
    state.behavior.set("https://b.test/rss", "duplicate")
    state.behavior.set("https://c.test/rss", "fail")
    state.behavior.set("https://d.test/rss", "ok")

    const res = await postImport(opmlOf([
      "https://a.test/rss",
      "https://b.test/rss",
      "https://c.test/rss",
      "https://d.test/rss",
    ]))

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson")
    expect(res.headers.get("Cache-Control")).toBe("no-store")

    const events = readEvents(await res.text())
    expect(events[0]).toEqual({ type: "start", total: 4 })

    const progress = events.filter((e) => e.type === "progress")
    expect(progress).toHaveLength(4)
    // 并发处理：完成顺序不定，但 done 必须是 1..4 各一次
    expect([...progress.map((e) => e.done)].sort()).toEqual([1, 2, 3, 4])
    for (const event of progress) {
      expect(event.total).toBe(4)
      expect(typeof event.title).toBe("string")
    }

    expect(events.at(-1)).toEqual({
      type: "done",
      total: 4,
      imported: 2,
      skipped: 1,
      failed: [{ url: "https://c.test/rss", error: expect.stringContaining("https://c.test/rss") }],
    })
  })

  it("同一 URL 在文件里重复出现时只处理一次", async () => {
    state.behavior.set("https://same.test/rss", "ok")

    const res = await postImport(opmlOf([
      "https://same.test/rss",
      "https://same.test/rss",
    ]))

    expect(readEvents(await res.text())[0]).toEqual({ type: "start", total: 1 })
    expect(state.calls).toEqual(["https://same.test/rss"])
  })

  it("未登录返回 401（不开流）", async () => {
    state.session = null

    const res = await postImport(opmlOf(["https://a.test/rss"]))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  it("缺 opml 字段返回 400 JSON，而不是流", async () => {
    const res = await app.request("/api/feeds/import-opml", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "opml content required" })
  })

  it("OPML 非法 / 无订阅源时返回 422 JSON", async () => {
    const bad = await postImport("<<<not xml at all>>>")
    expect(bad.status).toBe(422)
    expect((await bad.json() as { error?: string }).error).toBeTruthy()

    const empty = await postImport("<opml><body><outline text=\"只有分组\"/></body></opml>")
    expect(empty.status).toBe(422)
    expect(await empty.json()).toEqual({ error: "OPML 中未发现任何订阅源" })
  })
})
