/**
 * 订阅管理 MCP 工具端到端验证脚本。
 *
 * 直接用 app.fetch 在内存中调用 /mcp 端点（不启动完整 dev server）。
 * 该 MCP server 采用「每请求重建 server 实例」的无状态模式
 * （mcp-session-id 为 null），因此每个 JSON-RPC 请求可独立发送。
 *
 * 验证：
 *  - 认证：无 token / 无效 token → 401
 *  - initialize / tools/list
 *  - 各工具实际调用（list_subscriptions / discover / add / remove / pause /
 *    resume / refetch / list_bots / get_feed / list_entries 等）
 *
 * 运行：pnpm tsx scripts/verify-mcp.ts
 */
import "dotenv/config"
import http from "node:http"
import { app } from "../src/app"
import { createToken } from "../src/services/api-token"
import { db, apiToken, feeds, bots } from "../src/db"
import { eq, inArray } from "drizzle-orm"

const USER_ID = process.env.MCP_TEST_USER_ID ?? "RtbOjQ0dXGbyepZTBizq8z4nYYUmE7nQ" // user10@test.com

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.error(`  ❌ ${name}`, extra ?? "") }
}

/** 解析 MCP 响应体：SSE（event: message\ndata: {...}）或纯 JSON */
async function parseBody(res: Response): Promise<{ raw: string; json?: any }> {
  const raw = await res.text()
  let json: any
  try {
    // SSE 格式：可能有多段 event: message + data: {...}
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
    if (dataLines.length) {
      json = JSON.parse(dataLines[dataLines.length - 1])
    } else {
      json = JSON.parse(raw)
    }
  } catch {
    json = null
  }
  return { raw, json }
}

/** 发送一个 MCP JSON-RPC 请求 */
async function rpc(method: string, params: any, token: string, id = 1) {
  const res = await app.fetch(new Request("http://localhost:3001/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }))
  return { res, ...(await parseBody(res)) }
}

/** 调用一个工具并返回其 text 内容 */
async function callTool(token: string, name: string, args: any) {
  const { res, json } = await rpc("tools/call", { name, arguments: args }, token)
  let text = ""
  let isError = false
  if (json?.result?.content) {
    text = json.result.content.map((c: any) => c.text ?? "").join("\n")
    isError = !!json.result.isError
  }
  return { status: res.status, json, text, isError }
}

async function main() {
  // ── 0a. 启动本地 RSS 测试服务（同生命周期，验证 discover_feed 正向路径） ──
  const localRssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed Alpha</title><link>https://example.com</link>
  <description>用于 MCP 工具验证的测试订阅源</description>
  <item><title>第一条测试新闻</title><link>https://example.com/1</link><guid>https://example.com/1</guid>
    <description>第一篇文章摘要</description><pubDate>Wed, 10 Sep 2026 10:00:00 GMT</pubDate></item>
  <item><title>第二条测试新闻</title><link>https://example.com/2</link><guid>https://example.com/2</guid>
    <description>第二篇文章摘要</description><pubDate>Wed, 10 Sep 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`
  const localRssServer = http.createServer((req, res) => {
    if (req.url?.startsWith("/feed")) {
      res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" })
      res.end(localRssXml)
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("local rss test server")
    }
  })
  await new Promise<void>((resolve) => localRssServer.listen(8099, "127.0.0.1", resolve))
  const localFeedUrl = "http://127.0.0.1:8099/feed"

  // 记录测试期间可能被修改的全局 feed，用于清理时复原
  let testFeedId: string | null = null

  // 记录测试前 USER_ID 已有的 bot，测试结束后删除期间新增的（含 organize_bots 建的）
  const preExistingBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, USER_ID))
  const preExistingBotIds = new Set(preExistingBots.map((b) => b.id))

  // ── 0. 准备测试 token ──
  const { token, record } = await createToken(USER_ID, "mcp-verify")
  console.log(`[setup] created test token (id=${record.id.slice(0, 8)}…)`)

  try {
    // ── 1. 认证 ──
    console.log("\n=== 认证 ===")
    const noAuth = await rpc("initialize", {}, "", 1)
    check("无 token → 401", noAuth.res.status === 401, `status=${noAuth.res.status}`)

    const badAuth = await rpc("initialize", {}, "rssfed_invalid_token", 1)
    check("无效 token → 401", badAuth.res.status === 401, `status=${badAuth.res.status}`)

    // ── 2. initialize / tools/list ──
    console.log("\n=== initialize / tools/list ===")
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1.0" },
    }, token)
    check("initialize 返回 200", init.res.status === 200, `status=${init.res.status}`)
    check("initialize serverInfo.rssfed-subscriptions", init.json?.result?.serverInfo?.name === "rssfed-subscriptions", init.json)

    const tools = await rpc("tools/list", {}, token)
    const names: string[] = (tools.json?.result?.tools ?? []).map((t: any) => t.name)
    check("tools/list 返回 200", tools.res.status === 200, `status=${tools.res.status}`)
    check(`tools/list 返回 ${names.length} 个工具`, names.length >= 19, names)
    console.log(`  工具清单: ${names.join(", ")}`)

    // ── 3. 工具实际调用 ──
    console.log("\n=== 工具实际调用 ===")

    // list_subscriptions
    const list = await callTool(token, "list_subscriptions", {})
    check("list_subscriptions 成功", list.status === 200 && !list.isError && list.text.includes("feedId"), list.text.slice(0, 300))

    // 提取一个已订阅 feedId（用于后续读取）
    try {
      const parsed = JSON.parse(list.text)
      if (Array.isArray(parsed) && parsed.length) testFeedId = parsed[0].feedId
    } catch { /* ignore */ }
    check("已有订阅数据可读", !!testFeedId, list.text.slice(0, 200))

    // discover_feed：校验一个本地可达的有效 feed URL（不依赖外网）
    const discover = await callTool(token, "discover_feed", { url: localFeedUrl })
    check("discover_feed 校验有效源", discover.status === 200 && !discover.isError && discover.text.includes("Test Feed Alpha"), discover.text.slice(0, 300))
    check("discover_feed 返回条目数与 valid", discover.text.includes('"valid": true') && discover.text.includes('"itemCount": 2'), discover.text.slice(0, 300))

    // add_subscription：真实添加一次（用本地源，成功路径）
    const add = await callTool(token, "add_subscription", { url: localFeedUrl, category: "verify" })
    check("add_subscription 添加成功", add.status === 200 && !add.isError && add.text.includes("subscribed"), add.text.slice(0, 300))

    // add_subscription：重复添加同一源 → 应提示已订阅
    const addAgain = await callTool(token, "add_subscription", { url: localFeedUrl })
    check("add_subscription 重复添加 → 已订阅", addAgain.status === 200 && addAgain.text.includes("already subscribed"), addAgain.text.slice(0, 300))

    // remove_subscription：成功移除刚添加的本地源
    let addedFeedId: string | null = null
    try {
      const addJson = JSON.parse(add.text)
      addedFeedId = addJson?.feedId ?? null
    } catch { /* ignore */ }
    check("add_subscription 返回了 feedId", !!addedFeedId, add.text.slice(0, 200))
    if (addedFeedId) {
      const remove = await callTool(token, "remove_subscription", { feedId: addedFeedId })
      check("remove_subscription 移除成功", remove.status === 200 && !remove.isError && remove.text.includes("removed"), remove.text.slice(0, 200))
    }

    // ── Bot 工具完整生命周期（create → add_feed → list_feeds → remove_feed → delete） ──
    const botName = `verify-bot-${Date.now()}`
    const createBotRes = await callTool(token, "create_bot", {
      name: botName, preferredUsername: `verifybot_${Date.now()}`, description: "MCP verify bot",
    })
    const createBotJson = createBotRes.isError ? null : (() => { try { return JSON.parse(createBotRes.text) } catch { return null } })()
    check("create_bot 成功", !createBotRes.isError && !!createBotJson?.id, createBotRes.text.slice(0, 200))
    const botId = createBotJson?.id ?? null

    if (botId && testFeedId) {
      // add_bot_feed：把已订阅的源关联到 bot
      const addBotFeed = await callTool(token, "add_bot_feed", { botId, feedId: testFeedId })
      check("add_bot_feed 关联成功", !addBotFeed.isError && addBotFeed.text.includes("linked"), addBotFeed.text.slice(0, 200))

      // list_bot_feeds：查看 bot 关联的源
      const listBotFeeds = await callTool(token, "list_bot_feeds", { botId })
      check("list_bot_feeds 列出关联源", !listBotFeeds.isError && listBotFeeds.text.includes(testFeedId), listBotFeeds.text.slice(0, 200))

      // organize_bots：自动分组
      const organize = await callTool(token, "organize_bots", {})
      check("organize_bots 执行成功", !organize.isError, organize.text.slice(0, 200))

      // remove_bot_feed：解除关联
      const removeBotFeed = await callTool(token, "remove_bot_feed", { botId, feedId: testFeedId })
      check("remove_bot_feed 解除关联", !removeBotFeed.isError && removeBotFeed.text.includes("unlinked"), removeBotFeed.text.slice(0, 200))
    }

    // delete_bot：删除刚创建的 bot
    if (botId) {
      const deleteBotRes = await callTool(token, "delete_bot", { botId })
      check("delete_bot 删除成功", !deleteBotRes.isError && deleteBotRes.text.includes("deleted"), deleteBotRes.text.slice(0, 200))
    }

    // ── 其他工具：search_entries / update_subscription / pause+resume ──
    if (testFeedId) {
      const search = await callTool(token, "search_entries", { feedId: testFeedId, keyword: "test", limit: 5 })
      check("search_entries 成功", search.status === 200, search.text.slice(0, 200))

      const update = await callTool(token, "update_subscription", { feedId: testFeedId, title: "MCP 更新后的标题" })
      check("update_subscription 更新元数据", !update.isError && update.text.includes("updated"), update.text.slice(0, 200))

      const pause = await callTool(token, "pause_subscription", { feedId: testFeedId })
      check("pause_subscription 暂停", !pause.isError && pause.text.includes("paused"), pause.text.slice(0, 200))

      const resume = await callTool(token, "resume_subscription", { feedId: testFeedId })
      check("resume_subscription 恢复", !resume.isError && resume.text.includes("active"), resume.text.slice(0, 200))

      const refetch = await callTool(token, "refetch_feed", { feedId: testFeedId })
      check("refetch_feed 触发抓取", !refetch.isError && refetch.text.includes("queued"), refetch.text.slice(0, 200))
    }

    // get_feed
    if (testFeedId) {
      const getFeed = await callTool(token, "get_feed", { feedId: testFeedId })
      check("get_feed 读取订阅元数据", getFeed.status === 200 && !getFeed.isError, getFeed.text.slice(0, 200))
    }

    // list_entries
    if (testFeedId) {
      const entries = await callTool(token, "list_entries", { feedId: testFeedId, limit: 5 })
      check("list_entries 读取条目", entries.status === 200, entries.text.slice(0, 200))
    }

    // list_bots
    const bots = await callTool(token, "list_bots", {})
    check("list_bots 成功", bots.status === 200 && !bots.isError, bots.text.slice(0, 200))

    // pause 非本人订阅的 feed → 拒绝（归属校验）
    const pauseMissing = await callTool(token, "pause_subscription", { feedId: "nonexistent_feed" })
    check("pause 非本人订阅 → 拒绝", pauseMissing.isError, pauseMissing.text.slice(0, 200))

    // remove 不存在订阅 → 拒绝
    const removeMissing = await callTool(token, "remove_subscription", { feedId: "nonexistent_feed" })
    check("remove 不存在订阅 → 拒绝", removeMissing.isError, removeMissing.text.slice(0, 200))

    console.log("\n=== 验证完成 ===")
  } finally {
    // 复原测试期间对全局 feed 元数据/状态的改动（避免污染共享数据）
    if (testFeedId) {
      await db.update(feeds)
        .set({ title: "https://news.ycombinator.com/rss", status: "active" })
        .where(eq(feeds.id, testFeedId))
        .catch(() => {})
    }
    // 删除测试期间新增的 bot（含 organize_bots 自动创建的"未分组"），保持环境干净
    const nowBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, USER_ID))
    const newBotIds = nowBots.map((b) => b.id).filter((id) => !preExistingBotIds.has(id))
    if (newBotIds.length) {
      await db.delete(bots).where(inArray(bots.id, newBotIds)).catch(() => {})
    }
    await db.delete(apiToken).where(eq(apiToken.id, record.id)).catch(() => {})
    await new Promise<void>((resolve) => localRssServer.close(() => resolve()))
    console.log(`[cleanup] restored feed + removed test token + cleaned ${newBotIds.length} test bot(s)`)
  }

  console.log(`\n结果: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("verify failed:", err)
  process.exit(1)
})
