import { eq } from "drizzle-orm"
import { db, feeds, bots, botFeeds, timelineSourceSync, user } from "../db"
import { createCouchDb, ensureTimelineDatabase, nanoServer } from "../couchdb/client"
import { feedDocId } from "../couchdb/doc-ids"
import { buildPurgeBody, countPurged, purgeRequest } from "../couchdb/retention"
import { entryIdPrefix } from "./timeline"

/**
 * 删除一个订阅源（管理员操作）。
 *
 * ## 为什么不能只删 `feeds` 那一行
 *
 * 一个 feed 的内容散在四处，全都要清，否则会留下"列表里还在、点进去永远空白"的源：
 *
 *   | 位置 | 内容 | 不清的后果 |
 *   | --- | --- | --- |
 *   | PostgreSQL `feeds` | 注册表行（含 couch_db_name） | 调度器继续抓 —— 幽灵源 |
 *   | PostgreSQL `timeline_source_sync` | 每用户的水位行 | 退订清理靠"水位有、订阅没有"触发； |
 *   | | | 行没了就永远不会再触发，用户库里的条目永久残留 |
 *   | PostgreSQL `bot_feeds` | Bot 对 feed 的引用（裸 text，无外键） | 孤儿行；Bot 继续引用已删源 |
 *   | 用户库 `user-timeline_*` | `subscription:` 文档、条目、FeedDoc 副本 | 用户的订阅列表里还挂着， |
 *   | | | 但源库没了 → 同步永久失败 |
 *   | 源库 `feed_*` | 条目与 FeedDoc 本体 | 磁盘残留；同 feedId 再建时摸到旧数据 |
 *
 * 顺序是刻意的：**先清用户侧、再删源库、最后删注册表行**。任一步失败都还能重试；
 * 反过来先删注册表行，用户侧的清理就失去"该源存在过"的依据，只能全库扫描。
 *
 * ## 订阅者守卫
 *
 * 删除是破坏性的：别人还在读这个源时直接删等于单方面清掉他们的内容。所以先查订阅者，
 * 有人订阅就拒绝并列出是谁。查法见 `listFeedSubscribers`。
 */

/** 一个订阅者（用户或 Bot 引用） */
export interface FeedSubscriber {
  /** 用户 id；Bot 引用时为 Bot 的所属用户 */
  userId: string
  email?: string
  /** 命中来源：subscription=用户库里的订阅文档，bot=bot_feeds 引用 */
  via: "subscription" | "bot"
}

/**
 * 查「谁订阅了这个源」。
 *
 * **不能只查 `timeline_source_sync`**：那张表本职是同步进度，行是「那次同步自己 upsert 的」，
 * 新订阅要等聚合跑完才有行；休眠账号（`aggregation_paused_at` 非空）在暂停期间照常能订阅，
 * 但聚合被跳过、永远不建行。用它当权威会漏人，进而误删别人还在订阅的源。
 *
 * 所以分两段（方案：水位表快查 + 用户库兜底）：
 *   1. 水位表命中 → 直接采信（快路径，绝大多数情况走这里）；
 *   2. 命中为空 → 才去枚举各用户库的 `subscription:` 文档（慢路径，只在"看起来没人订阅"时付代价）。
 *      "看起来没人订阅"正是最危险的判断，必须复核。
 *
 * `bot_feeds` 无论如何都要查：Bot 可以引用 feed 而不产生任何 `subscription:` 文档。
 */
export async function listFeedSubscribers(feedId: string): Promise<FeedSubscriber[]> {
  const found = new Map<string, FeedSubscriber>()

  // Bot 引用：与订阅无关，始终查。bot_feeds 只存 botId，要 join bots 拿所属用户
  const botRows = await db
    .select({ userId: bots.userId })
    .from(botFeeds)
    .innerJoin(bots, eq(bots.id, botFeeds.botId))
    .where(eq(botFeeds.feedId, feedId))
    .catch(() => [])
  for (const row of botRows) {
    if (row.userId) found.set(row.userId, { userId: row.userId, via: "bot" })
  }

  // 快路径：水位表有行就采信（不放过任何一行，它是"曾经订阅过"的强证据）
  const watermarkRows = await db
    .select({ userId: timelineSourceSync.userId })
    .from(timelineSourceSync)
    .where(eq(timelineSourceSync.sourceId, feedId))
  for (const row of watermarkRows) {
    found.set(row.userId, { userId: row.userId, via: "subscription" })
  }

  // 慢路径：水位表没有任何行时，必须回到权威来源（用户库里的 subscription 文档）复核
  if (watermarkRows.length === 0) {
    for (const subscriber of await scanSubscriptionDocs(feedId)) {
      if (!found.has(subscriber.userId)) found.set(subscriber.userId, subscriber)
    }
  }

  // 补邮箱，便于把提示写具体
  const userIds = [...found.keys()]
  if (userIds.length > 0) {
    const rows = await db.select({ id: user.id, email: user.email }).from(user)
    const emailById = new Map(rows.map((r) => [r.id, r.email]))
    for (const [id, sub] of found) {
      const email = emailById.get(id)
      if (email) sub.email = email
    }
  }

  return [...found.values()]
}

/**
 * 枚举所有用户的聚合库，查其中的 `subscription:<feedId>` 文档。
 *
 * 幂等且与库数量线性相关 —— 单次点查约 1.4ms（实测 6234 文档的库同样 1.4ms，B-tree 命中），
 * 因此只在快路径没结果时才跑，代价可接受。
 */
async function scanSubscriptionDocs(feedId: string): Promise<FeedSubscriber[]> {
  const users = await db
    .select({ id: user.id, dbName: user.timelineDbName })
    .from(user)
  const docId = `subscription:${feedId}`
  const hits: FeedSubscriber[] = []

  await Promise.all(users.map(async (u) => {
    if (!u.dbName) return
    try {
      const db = createCouchDb(u.dbName)
      const doc = await db.get(docId) as { feedId?: string }
      // 文档存在即订阅（再核一次 feedId，防止历史脏文档 key 与内容不一致）
      if (doc && (doc.feedId === feedId || doc.feedId === undefined)) {
        hits.push({ userId: u.id, via: "subscription" })
      }
    } catch {
      // 404 = 没订阅；其它错误也当没订阅（不能让一次 CouchDB 抖动把守卫变成"放行"）
    }
  }))
  return hits
}

/** 清理某个源在**一个用户库**里的全部痕迹：订阅文档、条目、FeedDoc 副本 */
async function purgeSourceFromUserDb(userId: string, feedId: string): Promise<void> {
  const dbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(dbName)

  // 1) 先删订阅文档：这是"退订"的权威信号，后续即使有并发同步也会先读它跳过
  try {
    const doc = await scope.get(`subscription:${feedId}`) as { _rev: string }
    await scope.destroy(`subscription:${feedId}`, doc._rev)
  } catch {
    // 本来就没有订阅文档（Bot 引用场景）：继续清理条目
  }

  // 2) 条目按前缀 purge（用 _purge 不留墓碑，理由见 couchdb/retention.ts）
  const prefix = entryIdPrefix(feedId)
  for (let page = 0; page < 200; page++) {
    let rows: Array<{ id: string, value: { rev: string } }>
    try {
      const res = await scope.list({ startkey: prefix, endkey: `${prefix}\uffff`, limit: 500, include_docs: false })
      rows = res.rows as Array<{ id: string, value: { rev: string } }>
    } catch {
      break
    }
    if (rows.length === 0) break
    const body = buildPurgeBody(rows.map((r) => ({ _id: r.id, _rev: r.value.rev })))
    try {
      const purged = await purgeRequest(dbName, body)
      countPurged(purged, body) // 仅用于确认请求有效；计数在本流程里不参与决策
    } catch {
      break
    }
    if (rows.length < 500) break
  }

  // 3) FeedDoc 副本（源元信息）删掉：留着会让客户端侧边栏继续显示已删除的源
  try {
    const doc = await scope.get(feedDocId(feedId)) as { _rev: string }
    await scope.destroy(feedDocId(feedId), doc._rev)
  } catch {
    // 没有副本：正常
  }
}

/** 删除结果（供接口回包与日志） */
export interface DeleteFeedResult {
  feedId: string
  /** 清掉条目的用户数 */
  purgedUsers: number
  /** 清理过程中的失败（不阻断，但要如实返回） */
  failures: Array<{ userId?: string, error: string }>
}

/**
 * 真正执行删除。调用方必须**先**用 `listFeedSubscribers` 确认没有其他订阅者。
 *
 * 失败不抛（除非注册表行删不掉）：用户库清理单点失败只记进 failures ——
 * 留一条孤儿条目远比"源删了一半、注册表还在"容易收拾。
 */
export async function deleteFeed(feedId: string, subscribers: FeedSubscriber[]): Promise<DeleteFeedResult> {
  const [feed] = await db.select({
    id: feeds.id,
    couchDbName: feeds.couchDbName,
  }).from(feeds).where(eq(feeds.id, feedId)).limit(1)
  if (!feed) throw new Error(`feed not found: ${feedId}`)

  const failures: DeleteFeedResult["failures"] = []

  // ① 用户侧：订阅文档 + 条目 + FeedDoc 副本（含 Bot 引用者，他们的库里也有副本）
  const userIds = [...new Set(subscribers.map((s) => s.userId))]
  await Promise.all(userIds.map(async (userId) => {
    try {
      await purgeSourceFromUserDb(userId, feedId)
    } catch (err) {
      failures.push({ userId, error: (err as Error)?.message ?? String(err) })
    }
  }))

  // ② 水位行：不删的话，之后"水位有、订阅没有"的清理逻辑会把它当成已退订反复处理
  await db.delete(timelineSourceSync)
    .where(eq(timelineSourceSync.sourceId, feedId))
    .catch((err) => { failures.push({ error: `watermark: ${(err as Error)?.message ?? err}` }) })

  // ③ Bot 引用（裸 text，没有外键，不删就是孤儿）
  await db.delete(botFeeds)
    .where(eq(botFeeds.feedId, feedId))
    .catch((err) => { failures.push({ error: `bot_feeds: ${(err as Error)?.message ?? err}` }) })

  // ④ 源库本体：最后删。失败只记录 —— 注册表行还在时，重试删除会再清一次
  if (feed.couchDbName) {
    try {
      await nanoServer.db.destroy(feed.couchDbName)
    } catch (err) {
      failures.push({ error: `couchdb ${feed.couchDbName}: ${(err as Error)?.message ?? err}` })
    }
  }

  // ⑤ 注册表行：放在最后。它一删，上面那些步骤就失去"该源存在过"的依据了
  await db.delete(feeds).where(eq(feeds.id, feedId))

  return { feedId, purgedUsers: userIds.length, failures }
}
