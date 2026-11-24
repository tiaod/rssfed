import { Hono, type Context, type Next } from "hono"
import { parseFeedUrl, formatFeedError } from "../rss/parser"
import { parseOpml, type OpmlFeed } from "../rss/opml"
import { createCouchDb, ensureTimelineDatabase } from "../couchdb/client"
import { deriveFeedId } from "../couchdb/subscription-doc"
import { feedDocId } from "../couchdb/doc-ids"
import {
  addSubscriptionIfAbsent,
  ensureFeedSubscribed,
  listSubscriptionsForUser,
  refetchFeed,
  removeSubscription,
  setSubscriptionPaused,
  updateUserSubscription,
  type FeedMeta,
} from "../services/feeds"
import { purgeSubscriptionContent } from "../services/timeline"
import { purgeBotFromUser, syncBotEntriesToUser } from "../services/bot-subscription-sync"
import { auth } from "../auth"
import { mapWithConcurrency } from "../utils/concurrency"

type FeedsVariables = { userId: string }

/** 校验登录态并将 userId 写入 context（未登录 401） */
async function requireAuth(c: Context<{ Variables: FeedsVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
}

export const feedsRouter = new Hono<{ Variables: FeedsVariables }>()

/**
 * 订阅路由。
 *
 * **没有「全局源」这回事了**：旧模型的 `GET /`（管理员看全站源）、`PUT /:feedId`（改源信息）、
 * `DELETE /:feedId`（删源）、`/orphans/*`（零订阅源清扫）全部删除 —— 那些操作的前提是
 * 「一个源被多个人共享、有一个独立的源库」。现在每个用户只抓自己的东西，退订即停止；
 * 源级操作（改名、分组、暂停）全是**订阅级**的，归 `/subscriptions/:feedId` 管。
 */

/**
 * 发现并订阅一个新 RSS 订阅源。
 *
 * **必须登录**：这个端点会让服务端按请求里的 URL 真实发一次 HTTP 请求，等于「替调用方
 * 访问任意地址」。没有会话时它就是一个免鉴权的 SSRF 入口（实测未登录 POST
 * `{"url":"http://127.0.0.1:5984/"}` 能拿到内网 CouchDB 的响应体，只是被当成"不是 feed"
 * 报格式错误）。
 *
 * 注意这只是**第一道**闸门：地址本身的合法性（拒绝私网/环回/链路本地）在 rss/ssrf-guard.ts，
 * 两道都要有 —— 光有鉴权，任何注册用户仍可拿它探内网。
 *
 * 返回的 `url` 会被客户端写进订阅文档，而抓取侧**每次都重新过一遍 SSRF 闸门**
 * （订阅文档是客户端可写的，不能信任里面的地址）。
 */
feedsRouter.post("/discover", requireAuth, async (c) => {
  const userId = c.get("userId")
  const { url } = await c.req.json()
  if (!url || typeof url !== "string") return c.json({ error: "url required" }, 400)

  try {
    // 先解析一次：既校验地址是否真是 feed，也拿到标题给订阅文档用
    const parsed = await parseFeedUrl(url)
    const feedId = deriveFeedId(url)

    return c.json({
      feedId,
      url,
      title: parsed.title,
      siteUrl: parsed.link,
      description: parsed.description,
      image: parsed.image?.url,
      items: parsed.items.length,
    })
  } catch (err) {
    return c.json({ error: `Failed to parse feed: ${formatFeedError(url, err)}` }, 422)
  }
})

/**
 * OPML 导入过程中的进度事件（每行一个 JSON，见下方 import-opml 的响应格式）。
 *
 * 前端据 progress 渲染进度条；done/error 是流的终点，二者必有其一。
 */
type ImportOpmlEvent =
  | { type: "start", total: number }
  | { type: "progress", done: number, total: number, imported: number, skipped: number, failed: number, title: string }
  | { type: "done", total: number, imported: number, skipped: number, failed: { url: string, error: string }[] }
  | { type: "error", message: string }

/**
 * 导入 OPML：按 OPML 分组结构为当前用户创建订阅。
 *
 * 响应体是 **NDJSON 进度流**（每处理完一个源推一行），不是单个 JSON ——
 * 几十上百个源要逐个写订阅文档，单次 JSON 响应期间前端只能转圈、无法给出任何反馈。
 * 解析/去重等开流前的失败仍走普通 JSON 错误（带 HTTP 状态码）；开流之后的意外失败
 * 只能以 `error` 事件送达（此刻状态码已经发出去了），由前端抛成同样的错误。
 *
 * 客户端中途断开（用户取消导入）时停止继续处理未开始的源；已写入的订阅保留。
 */
feedsRouter.post("/import-opml", requireAuth, async (c) => {
  const userId = c.get("userId")
  const { opml } = await c.req.json()
  if (!opml || typeof opml !== "string") {
    return c.json({ error: "opml content required" }, 400)
  }

  // 1. 解析 OPML 为订阅源列表（含分组信息）
  let items: OpmlFeed[]
  try {
    items = parseOpml(opml)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422)
  }
  if (!items.length) {
    return c.json({ error: "OPML 中未发现任何订阅源" }, 422)
  }

  // 2. 按 URL 去重（同一订阅源可能在文件中出现多次）
  const unique = [...new Map(items.map((i) => [i.url, i])).values()]

  // 用户库在开流前准备好：这里失败仍是可读的 JSON 错误，而不是流里的半截进度
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  const failed: { url: string, error: string }[] = []
  let imported = 0
  let skipped = 0
  let done = 0
  /** 客户端是否已断开：断开后不再枚举新的事件，也停止处理剩余的源 */
  let clientGone = false

  // 客户端断开要认 **请求信号**：@hono/node-server 在连接提前关闭时 abort 的是
  // `c.req.raw.signal`，并不会去 cancel 我们返回的 ReadableStream（实测断开后
  // 导入仍会继续跑完），只监听下面的 cancel() 会漏掉真实的中断。
  const requestSignal = c.req.raw.signal
  if (requestSignal.aborted) clientGone = true
  else requestSignal.addEventListener("abort", () => { clientGone = true }, { once: true })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ImportOpmlEvent) => {
        if (clientGone) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // 断开与 enqueue 之间可能有竞态：吞掉即可，请求信号已经标记 clientGone
          clientGone = true
        }
      }

      try {
        send({ type: "start", total: unique.length })

        // 3. 有限并发处理：写订阅文档，单个失败不影响其余
        await mapWithConcurrency(unique, 5, async (item) => {
          if (clientGone) return
          try {
            // 导入不做内联探测：标题用 OPML 的，内容交给抓取（几十上百个源同步下载会很慢，
            // 而且 worker 马上还要再抓一遍）
            const meta: FeedMeta = {
              feedId: deriveFeedId(item.url),
              url: item.url,
              title: item.title || item.url,
            }
            const subscribed = await addSubscriptionIfAbsent(userDb, item, meta)
            if (subscribed) imported++
            else skipped++
          } catch (err) {
            failed.push({ url: item.url, error: formatFeedError(item.url, err) })
          }
          done++
          send({ type: "progress", done, total: unique.length, imported, skipped, failed: failed.length, title: item.title })
        })

        send({ type: "done", total: unique.length, imported, skipped, failed })
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) })
      } finally {
        try {
          controller.close()
        } catch {
          // 已随断开关闭
        }
      }
    },
    cancel() {
      // 补充路径：某些适配器（Bun / Deno 等）会 cancel 流而不是 abort 请求信号。
      // 正在处理的源不会被打断，但接下来不会再取新的源。
      clientGone = true
    },
  })

  return c.body(stream, 200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    // 进度流不能被任何中间层缓存或缓冲（否则前端看到的是一条明显的"卡住然后全出来"）
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  })
})

/** 获取当前用户的订阅列表（feed + bot），状态来自该用户的抓取调度状态 */
feedsRouter.get("/subscriptions", requireAuth, async (c) => {
  const userId = c.get("userId")
  const subs = await listSubscriptionsForUser(userId)
  return c.json(subs)
})

/**
 * 订阅一个源（等价于 discover + 写订阅）。
 *
 * 与 `POST /discover` 分开是因为两者语义不同：discover 只校验、不写；
 * 这个接口会真的写订阅文档并触发首抓（OPML / MCP 之外的「确认订阅」入口）。
 */
feedsRouter.post("/subscriptions", requireAuth, async (c) => {
  const userId = c.get("userId")
  const body = await c.req.json().catch(() => null) as { url?: unknown, category?: unknown } | null
  const url = typeof body?.url === "string" ? body.url.trim() : ""
  if (!url) return c.json({ error: "url required" }, 400)
  const category = typeof body?.category === "string" ? body.category : undefined

  try {
    const { meta, added } = await ensureFeedSubscribed(userId, { url, title: url, category })
    return c.json({
      feedId: meta.feedId,
      url: meta.url,
      title: meta.title,
      added,
    }, added ? 201 : 200)
  } catch (err) {
    return c.json({ error: `Failed to subscribe: ${formatFeedError(url, err)}` }, 422)
  }
})

/**
 * 删除一条订阅（退订）。
 *
 * 顺序见 `purgeSubscriptionContent`：先删订阅文档（退订的权威信号），再按前缀清条目，
 * 最后清调度状态。用户已抓到的内容随条目一起删掉 —— 这是"退订"应有的语义，
 * 保留内容才是意外的（会让用户以为还在订阅）。
 */
feedsRouter.delete("/subscriptions/:feedId", requireAuth, async (c) => {
  const userId = c.get("userId")
  const feedId = c.req.param("feedId")!
  // Bot 订阅（`bot:{botId}`）不是 RSS 源：没有抓取产物，但有**已经搬过来的条目**要清。
  // 不清的话侧边栏没这个 Bot 了、时间线里还能翻到它的帖子。
  if (feedId.startsWith("bot:")) {
    const botId = feedId.slice("bot:".length)
    const removed = await removeSubscription(userId, feedId)
    const purged = await purgeBotFromUser(botId, userId)
    if (!removed && purged === 0) return c.json({ error: "not found" }, 404)
    return c.json({ ok: true, removedEntries: purged })
  }
  const removed = await removeSubscription(userId, feedId)
  const cleanup = await purgeSubscriptionContent(userId, feedId)
  if (!removed && cleanup.removedEntries === 0) return c.json({ error: "not found" }, 404)
  return c.json({ ok: true, removedEntries: cleanup.removedEntries })
})

/**
 * 订阅一个 Bot：把该 Bot 已有的产出立刻搬进用户库。
 *
 * 客户端写订阅文档是纯本地操作（离线也能做），所以**服务端要补这一手** ——
 * 否则用户订阅完要等下一个 Bot 产出周期才看到东西（可能几小时）。
 *
 * 幂等：已搬过的条目按 `_id` 判存在跳过，重复调用只多一次库查询。
 */
feedsRouter.post("/bot-subscriptions/:botId/sync", requireAuth, async (c) => {
  const userId = c.get("userId")
  const botId = c.req.param("botId")!
  const result = await syncBotEntriesToUser(botId, userId)
  return c.json({ ok: true, ...result })
})

/** 修改一条订阅（仅显示名与分组；换源请重新订阅） */
feedsRouter.patch("/subscriptions/:feedId", requireAuth, async (c) => {
  const userId = c.get("userId")
  const feedId = c.req.param("feedId")!
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const patch: { title?: string, category?: string } = {}
  if (typeof body.title === "string") patch.title = body.title
  if (typeof body.category === "string") patch.category = body.category
  if (Object.keys(patch).length === 0) return c.json({ error: "no fields to update" }, 400)

  const ok = await updateUserSubscription(userId, feedId, patch)
  return ok ? c.json({ ok: true }) : c.json({ error: "not subscribed" }, 404)
})

/**
 * 暂停/恢复一条订阅的抓取。
 *
 * 写订阅文档的 `paused` 字段（客户端可写文档，走读改写 + 409 重试），
 * 同时镜像进 `_local/schedule` 供调度器快速判断。
 */
feedsRouter.post("/subscriptions/:feedId/pause", requireAuth, async (c) => {
  const ok = await setSubscriptionPaused(c.get("userId"), c.req.param("feedId")!, true)
  return ok ? c.json({ ok: true, paused: true }) : c.json({ error: "not subscribed" }, 404)
})

feedsRouter.post("/subscriptions/:feedId/resume", requireAuth, async (c) => {
  const ok = await setSubscriptionPaused(c.get("userId"), c.req.param("feedId")!, false)
  return ok ? c.json({ ok: true, paused: false }) : c.json({ error: "not subscribed" }, 404)
})

/** 立即重新抓取一条订阅（清空失败计数并绕开缓存） */
feedsRouter.post("/subscriptions/:feedId/refetch", requireAuth, async (c) => {
  const ok = await refetchFeed(c.get("userId"), c.req.param("feedId")!)
  return ok ? c.json({ ok: true, queued: true }) : c.json({ error: "not subscribed" }, 404)
})

/** 获取单个源的元信息（该用户自己库里的 FeedDoc 副本） */
feedsRouter.get("/:feedId", requireAuth, async (c) => {
  const userId = c.get("userId")
  const feedId = c.req.param("feedId")!
  const userDb = createCouchDb(await ensureTimelineDatabase(userId))
  try {
    const feed = await userDb.get(feedDocId(feedId))
    return c.json(feed)
  } catch {
    return c.json({ error: "feed not found" }, 404)
  }
})
