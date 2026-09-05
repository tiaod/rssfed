import { Hono } from "hono"
import { z } from "zod"
import { createMcpHandler, McpServer, type McpRequestContext } from "@modelcontextprotocol/server"
import { resolveTokenUser } from "../services/api-token"
import {
  listSubscriptionsForUser,
  addSubscriptionByUrl,
  removeSubscription,
  setSubscriptionStatus,
  updateSubscriptionMeta,
  refetchFeed,
  resolveFeedId,
  formatFeedError,
} from "../services/feeds"
import { parseFeedUrl } from "../rss/parser"
import {
  listBotsForUser,
  createBot,
  updateBot,
  deleteBot,
  addBotFeed,
  removeBotFeed,
  listBotFeeds,
  organizeBots,
} from "../services/bots"
import { getFeed, listEntries, searchEntries } from "../services/entries"

/**
 * 订阅管理 MCP server。
 *
 * 采用官方 `@modelcontextprotocol/server` 的 `createMcpHandler`，按「每请求一个
 * McpServer 实例」的多租户模式运行：每个请求从其 `Authorization: Bearer <token>`
 * 解析出 userId，然后为该用户构建一套只读写其订阅数据的工具。
 *
 * 认证：token 无效 / 吊销 / 过期时拒绝（401）。
 * 授权：所有工具都以 userId 为边界，绝不提供 admin 级全局操作。
 */

/** 工具返回的文本 content 辅助函数 */
function textContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

/** 工具返回的错误文本（保持可读） */
function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

/**
 * 认证失败时抛出，交由 createMcpHandler 转为 401。
 * 这里用一个带 status 的 Error 让上层能区分。
 */
class AuthError extends Error {
  status = 401
  constructor() {
    super("unauthorized: invalid or missing API token")
  }
}

/** 解析请求头 Bearer token 并校验，返回 userId；无效返回 null */
async function authenticate(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
  if (!token) return null
  return resolveTokenUser(token)
}

/**
 * 构建一个带用户上下文的 McpServer 实例。
 * 由 createMcpHandler 在每次请求时调用。userId 由 Hono 入口层解析并写入
 * x-rssfed-user-id 内部头（仅服务端内部可见，来自可信的入口认证），
 * 这里据此构建「只读写该用户订阅数据」的工具集。
 */
async function buildServer(ctx: McpRequestContext): Promise<McpServer> {
  const userId = ctx.requestInfo?.headers.get("x-rssfed-user-id")
  if (!userId) throw new AuthError()

  const server = new McpServer({ name: "rssfed-subscriptions", version: "0.1.0" })

  // ── 订阅管理 ──

  server.registerTool(
    "list_subscriptions",
    {
      title: "列出我的订阅",
      description: "列出当前用户的全部订阅（RSS 源 + Bot），含抓取状态（active/paused/error）。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const subs = await listSubscriptionsForUser(userId)
        return textContent(subs)
      } catch (err) {
        return errorContent(`list failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.registerTool(
    "discover_feed",
    {
      title: "校验一个订阅源 URL",
      description: "给定一个 RSS/Atom/JSON Feed URL，解析并校验它是否是有效订阅源，返回标题、站点链接与条目数。该操作只校验，不订阅。",
      inputSchema: z.object({
        url: z.string().url(),
      }),
    },
    async ({ url }) => {
      try {
        const parsed = await parseFeedUrl(url)
        const feedId = await resolveFeedId(url)
        return textContent({
          feedId,
          title: parsed.title,
          siteUrl: parsed.link,
          description: parsed.description,
          itemCount: parsed.items.length,
          valid: true,
        })
      } catch (err) {
        return errorContent(formatFeedError(url, err))
      }
    },
  )

  server.registerTool(
    "add_subscription",
    {
      title: "添加订阅",
      description: "给定一个 URL，解析并注册 feed，同时为当前用户写入订阅（已订阅过则跳过）。这是实际执行订阅的操作。",
      inputSchema: z.object({
        url: z.string().url(),
        category: z.string().optional().describe("可选分组名"),
      }),
    },
    async ({ url, category }) => {
      try {
        const result = await addSubscriptionByUrl(userId, url, category)
        return textContent({ ...result, message: result.added ? "subscribed" : "already subscribed" })
      } catch (err) {
        return errorContent(`add failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.registerTool(
    "remove_subscription",
    {
      title: "取消订阅",
      description: "删除当前用户对某个订阅源/ Bot 的订阅。feedId 来自 list_subscriptions 返回的 feedId 字段。",
      inputSchema: z.object({
        feedId: z.string().describe("要取消订阅的 feedId / bot 订阅 id"),
      }),
    },
    async ({ feedId }) => {
      const ok = await removeSubscription(userId, feedId)
      if (!ok) return errorContent(`subscription not found: ${feedId}`)
      return textContent({ feedId, removed: true })
    },
  )

  server.registerTool(
    "pause_subscription",
    {
      title: "暂停抓取",
      description: "暂停某个已订阅源的抓取（仅限当前用户订阅的源）。",
      inputSchema: z.object({ feedId: z.string() }),
    },
    async ({ feedId }) => {
      const ok = await setSubscriptionStatus(userId, feedId, "paused")
      if (!ok) return errorContent(`cannot pause: feed not subscribed or not found: ${feedId}`)
      return textContent({ feedId, status: "paused" })
    },
  )

  server.registerTool(
    "resume_subscription",
    {
      title: "恢复抓取",
      description: "恢复某个已订阅源的抓取（仅限当前用户订阅的源）。",
      inputSchema: z.object({ feedId: z.string() }),
    },
    async ({ feedId }) => {
      const ok = await setSubscriptionStatus(userId, feedId, "active")
      if (!ok) return errorContent(`cannot resume: feed not subscribed or not found: ${feedId}`)
      return textContent({ feedId, status: "active" })
    },
  )

  server.registerTool(
    "update_subscription",
    {
      title: "修改订阅信息",
      description: "修改某个已订阅源的元信息（title/url/description/siteUrl/image），仅限当前用户订阅的源。",
      inputSchema: z.object({
        feedId: z.string(),
        title: z.string().optional(),
        url: z.string().url().optional(),
        description: z.string().optional(),
        siteUrl: z.string().url().optional(),
        image: z.string().url().optional(),
      }),
    },
    async ({ feedId, ...patch }) => {
      const ok = await updateSubscriptionMeta(userId, feedId, patch)
      if (!ok) return errorContent(`cannot update: feed not subscribed or not found: ${feedId}`)
      return textContent({ feedId, updated: true })
    },
  )

  server.registerTool(
    "refetch_feed",
    {
      title: "立即重新抓取",
      description: "立即重新抓取某个已订阅源（清空错误并加入抓取队列）。",
      inputSchema: z.object({ feedId: z.string() }),
    },
    async ({ feedId }) => {
      const ok = await refetchFeed(userId, feedId)
      if (!ok) return errorContent(`cannot refetch: feed not subscribed or not found: ${feedId}`)
      return textContent({ feedId, queued: true })
    },
  )

  // ── Bot / 分组管理 ──

  server.registerTool(
    "list_bots",
    {
      title: "列出我的 Bot",
      description: "列出当前用户的全部 Bot（ActivityPub 机器人，用于把订阅分组为阅读清单）。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const bots = await listBotsForUser(userId)
        return textContent(bots.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          preferredUsername: b.preferredUsername,
          avatarUrl: b.avatarUrl,
          isActive: b.isActive,
          lastNewEntryAt: b.lastNewEntryAt?.toISOString() ?? null,
          createdAt: b.createdAt.toISOString(),
        })))
      } catch (err) {
        return errorContent(`list bots failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.registerTool(
    "create_bot",
    {
      title: "创建 Bot",
      description: "创建一个新的 Bot（用于把若干订阅源归为一个分组 / ActivityPub 机器人）。",
      inputSchema: z.object({
        name: z.string().describe("Bot 显示名"),
        preferredUsername: z.string().describe("ActivityPub 用户名（唯一，不含 @domain）"),
        description: z.string().optional(),
        avatarUrl: z.string().url().optional(),
      }),
    },
    async ({ name, preferredUsername, description, avatarUrl }) => {
      try {
        const bot = await createBot(userId, { name, preferredUsername, description, avatarUrl })
        return textContent({ id: bot.id, name: bot.name, preferredUsername: bot.preferredUsername })
      } catch (err) {
        return errorContent(`create bot failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.registerTool(
    "update_bot",
    {
      title: "修改 Bot",
      description: "修改当前用户某个 Bot 的元信息。",
      inputSchema: z.object({
        botId: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        preferredUsername: z.string().optional(),
        avatarUrl: z.string().url().optional(),
        isActive: z.boolean().optional(),
      }),
    },
    async ({ botId, ...patch }) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      if (!Object.keys(clean).length) return errorContent("no fields to update")
      const ok = await updateBot(userId, botId, clean)
      if (!ok) return errorContent(`bot not found or not owned: ${botId}`)
      return textContent({ botId, updated: true })
    },
  )

  server.registerTool(
    "delete_bot",
    {
      title: "删除 Bot",
      description: "删除当前用户的某个 Bot（连同其关联的订阅源关联与产出库）。",
      inputSchema: z.object({ botId: z.string() }),
    },
    async ({ botId }) => {
      const ok = await deleteBot(userId, botId)
      if (!ok) return errorContent(`bot not found or not owned: ${botId}`)
      return textContent({ botId, deleted: true })
    },
  )

  server.registerTool(
    "add_bot_feed",
    {
      title: "给 Bot 关联订阅源",
      description: "把一个已订阅的源关联到某个 Bot。feedId 必须来自用户已订阅的源。",
      inputSchema: z.object({ botId: z.string(), feedId: z.string() }),
    },
    async ({ botId, feedId }) => {
      const result = await addBotFeed(userId, botId, feedId)
      if (result === "bot-not-owner") return errorContent(`bot not found or not owned: ${botId}`)
      if (result === "feed-not-subscribed") return errorContent(`feed not in your subscriptions: ${feedId}`)
      return textContent({ botId, feedId, linked: true })
    },
  )

  server.registerTool(
    "remove_bot_feed",
    {
      title: "解除 Bot 与源的关联",
      description: "把某个源从一个 Bot 的关联中移除。",
      inputSchema: z.object({ botId: z.string(), feedId: z.string() }),
    },
    async ({ botId, feedId }) => {
      const ok = await removeBotFeed(userId, botId, feedId)
      if (!ok) return errorContent(`bot not found or not owned: ${botId}`)
      return textContent({ botId, feedId, unlinked: true })
    },
  )

  server.registerTool(
    "list_bot_feeds",
    {
      title: "查看 Bot 关联的源",
      description: "列出某个 Bot 当前关联的全部订阅源（含标题与 URL）。",
      inputSchema: z.object({ botId: z.string() }),
    },
    async ({ botId }) => {
      const rows = await listBotFeeds(userId, botId)
      if (!rows) return errorContent(`bot not found or not owned: ${botId}`)
      return textContent(rows)
    },
  )

  server.registerTool(
    "organize_bots",
    {
      title: "自动分组",
      description: "根据当前用户订阅的分类（category），自动把订阅整理为若干按分类命名的 Bot。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await organizeBots(userId)
        return textContent(result)
      } catch (err) {
        return errorContent(`organize failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  // ── 读取内容/条目 ──

  server.registerTool(
    "get_feed",
    {
      title: "读取订阅源信息",
      description: "读取某个已订阅源的元数据（标题、站点地址、描述等）。",
      inputSchema: z.object({ feedId: z.string() }),
    },
    async ({ feedId }) => {
      const feed = await getFeed(userId, feedId)
      if (!feed) return errorContent(`feed not found or not subscribed: ${feedId}`)
      return textContent(feed)
    },
  )

  server.registerTool(
    "list_entries",
    {
      title: "列出条目",
      description: "列出某个已订阅源的最新条目（默认 20 条，倒序）。只返回标题/摘要/URL，不含完整正文。",
      inputSchema: z.object({
        feedId: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async ({ feedId, limit, offset }) => {
      const items = await listEntries(userId, feedId, limit, offset)
      if (!items) return errorContent(`feed not found or not subscribed: ${feedId}`)
      return textContent(items)
    },
  )

  server.registerTool(
    "search_entries",
    {
      title: "搜索条目",
      description: "在某个已订阅源的条目中按关键词搜索标题/摘要。",
      inputSchema: z.object({
        feedId: z.string(),
        keyword: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ feedId, keyword, limit }) => {
      const items = await searchEntries(userId, feedId, keyword, limit)
      if (!items) return errorContent(`feed not found or not subscribed: ${feedId}`)
      return textContent(items)
    },
  )

  return server
}

/** MCP HTTP handler（每请求构建 server，多租户 + 授权） */
export const mcpHandler = createMcpHandler(buildServer)

/**
 * Hono 路由：/mcp 交给 MCP handler 处理。
 * 认证在入口层完成：校验 Bearer token → 解析 userId → 写入内部头再转给 handler；
 * token 无效直接返回 HTTP 401，绝不创建有权限的 server 实例。
 */
export const mcpRouter = new Hono()
mcpRouter.all("/", async (c) => {
  const userId = await authenticate(c.req.raw)
  if (!userId) return c.json({ error: "unauthorized: invalid or missing API token" }, 401)

  // 构造带内部头的新请求供 buildServer 读取（headers 不可直接就地修改）
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-rssfed-user-id", userId)
  const requestWithUser = new Request(c.req.raw, { headers })
  return mcpHandler.fetch(requestWithUser)
})
