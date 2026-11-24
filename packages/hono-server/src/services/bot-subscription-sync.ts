import type { DocumentScope } from "nano"
import { createCouchDb, ensureBotDatabase, ensureTimelineDatabase } from "../couchdb/client"
import { buildPurgeBody, countPurged, purgeRequest } from "../couchdb/retention"

/**
 * 「用户订阅了某个 Bot」——把该 Bot 产出库里的新条目搬进用户库。
 *
 * ## 为什么这条链路单独存在
 *
 * 新模型下抓取按 owner 各写各的库，**用户库与 Bot 库之间没有复制**。
 * 但用户确实可以订阅一个 Bot（`subscription:bot:{botId}` 文档，`kind: 'bot'`）——
 * 那是一个 Bot 按自身身份分发/聚合出的内容，不是某个 RSS 源。
 * 所以这条路径必须单独把内容送过去，否则「订阅了 Bot，时间线里一条都没有」。
 *
 * ## 与旧实现的区别
 *
 * 旧模型是「Bot 库写完后，用户库以它为源跑一次 CouchDB 复制」。现在没有复制器，
 * 改成**抓取 Bot 源之后顺手把同一个源的产出同步到订阅了它的用户**。
 * 这不是"扇出"的复辟：Bot 的产出**数量级完全不同**（一个 Bot 一天几条），
 * 而 RSS 源是"几百个源 × 每源几十条"。
 *
 * ## 幂等
 *
 * 用 Bot 库里条目的 `_id` 原样写进用户库（`entry:bot:{botId}:{hash}`），
 * 已存在就跳过。所以重复跑只会命中"已存在"分支，不会重复写。
 */

/** 一次 Bot 订阅同步的结果 */
export interface BotSyncResult {
  /** 搬进用户库的条目数 */
  copied: number
  /** 检查过的 Bot 条目数 */
  scanned: number
}

/**
 * 列出订阅了某 Bot 的用户 id。
 *
 * 没有订阅关系的投影表，只能枚举用户库 —— 与 `services/feeds.ts` 的
 * `listSubscriptionDocs` 同一个取舍（见 ARCHITECTURE.md 里"为什么订阅关系在 CouchDB"）。
 *
 * 单次点查约 1.4ms（实测 6234 文档的库同样 1.4ms，B-tree 命中），
 * 而 Bot 产出是低频事件，所以这个成本可以接受。
 */
export async function listBotSubscribers(botId: string, userDbNames: Array<{ id: string, dbName: string | null }>): Promise<string[]> {
  const docId = `subscription:bot:${botId}`
  const hits: string[] = []
  await Promise.all(userDbNames.map(async (row) => {
    if (!row.dbName) return
    try {
      const doc = await createCouchDb(row.dbName).get(docId) as { kind?: string }
      // 文档存在即订阅；再核一次 kind 防止历史脏文档
      if (doc?.kind === "bot") hits.push(row.id)
    } catch {
      // 404 = 没订阅；其它错误也当没订阅（一次库抖动不该让同步变成"放行"）
    }
  }))
  return hits
}

/**
 * 把 Bot 产出库里的条目同步进一个用户库。
 *
 * 只搬 `entry:` 开头的文档：`_design/*` 是视图定义、`_local/*` 是内部状态，
 * 都不该出现在用户库里。
 *
 * 附件随 fetch 一起读（`attachments: true`）再 multipart 写入 —— 与旧实现同一套路，
 * 让用户离线也能看图。条目数很小（一天几条），不必担心内存。
 */
export async function syncBotEntriesToUser(
  botId: string,
  userId: string,
  options: { limit?: number } = {},
): Promise<BotSyncResult> {
  const botDbName = await ensureBotDatabase(botId)
  const userDbName = await ensureTimelineDatabase(userId)
  const botDb = createCouchDb(botDbName)
  const userDb = createCouchDb(userDbName)

  // Bot 库里的条目按发布时间倒序取一批（与 outbox 一致）
  const view = await botDb.view("main", "entries-by-date", {
    descending: true,
    limit: options.limit ?? 100,
    include_docs: false,
  }) as unknown as { rows?: Array<{ id?: string }> }

  const entryIds = (view.rows ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.startsWith("entry:"))
  if (entryIds.length === 0) return { copied: 0, scanned: 0 }

  // 批量判存在：已搬过的不再读正文与附件
  const existing = await listExistingIds(userDb, entryIds)
  let copied = 0
  for (const entryId of entryIds) {
    if (existing.has(entryId)) continue
    try {
      const doc = await botDb.get(entryId, { attachments: true }) as unknown as Record<string, unknown> & {
        _attachments?: Record<string, { data: string, content_type: string }>
      }
      const { _rev: _rev, _attachments, ...rest } = doc
      const attachments = Object.entries(_attachments ?? {}).map(([name, att]) => ({
        name,
        data: Buffer.from(att.data, "base64"),
        content_type: att.content_type,
      }))
      if (attachments.length > 0) {
        await userDb.multipart.insert(rest as never, attachments, { docName: entryId })
      } else {
        await userDb.insert(rest as never)
      }
      copied += 1
    } catch (err) {
      // 单条失败不拦下其余：下一轮还会再试（判存在会跳过已成功的）
      console.warn(`[Bot] 同步条目到用户失败 ${botId} → ${userId} ${entryId}:`, (err as Error)?.message ?? err)
    }
  }
  return { copied, scanned: entryIds.length }
}

/** 用户库里已存在的这些 id */
async function listExistingIds(scope: DocumentScope<unknown>, ids: string[]): Promise<Set<string>> {
  const present = new Set<string>()
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    try {
      const res = await scope.fetch({ keys: chunk }) as {
        rows?: Array<{ key?: string, error?: string, value?: { deleted?: boolean } }>
      }
      for (const row of res.rows ?? []) {
        if (!row.key || row.error === "not_found" || row.value?.deleted) continue
        present.add(row.key)
      }
    } catch {
      // 读失败：当作都不存在（宁可多写一次，也不要漏搬）
      break
    }
  }
  return present
}

/**
 * 用户退订 Bot 时清掉该 Bot 在用户库里的条目。
 *
 * 与 RSS 源退订同一个语义：订阅没了，内容也不留（否则侧边栏没这个 Bot，时间线里还能翻到它的帖子）。
 * 用 `_purge` 而不是 delete —— 不留墓碑，理由见 `couchdb/retention.ts`。
 */
export async function purgeBotFromUser(botId: string, userId: string): Promise<number> {
  const userDbName = await ensureTimelineDatabase(userId)
  const scope = createCouchDb(userDbName)
  const prefix = `entry:bot:${botId}:`
  let deleted = 0

  for (let round = 0; round < 200; round++) {
    let rows: Array<{ id: string, value: { rev: string } }>
    try {
      const res = await scope.list({ startkey: prefix, endkey: `${prefix}\uffff`, limit: 500, include_docs: false })
      rows = res.rows as Array<{ id: string, value: { rev: string } }>
    } catch {
      break
    }
    if (rows.length === 0) break
    const body = buildPurgeBody(rows.map((row) => ({ _id: row.id, _rev: row.value?.rev })).filter((doc) => Boolean(doc._rev)))
    if (Object.keys(body).length === 0) break
    const purged = await purgeRequest(userDbName, body)
    const removed = countPurged(purged, body)
    deleted += removed
    if (removed === 0) break
  }
  return deleted
}
