import "dotenv/config"
import { db, user } from "../src/db"
import { createCouchDb, ensureTimelineDatabase } from "../src/couchdb/client"
import { deriveFeedId, parseSubscription, subscriptionDocId } from "../src/couchdb/subscription-doc"
import { feedDocId } from "../src/couchdb/doc-ids"

/**
 * 一次性迁移：给**重构前写入**的订阅文档补上 `url`。
 *
 * ## 为什么需要
 *
 * 旧模型的订阅文档只存 `feedId`（`sha256(url)` 的截断），真实地址在 PostgreSQL 的
 * `feeds` 表里。新模型按 owner 抓取，调度读到订阅文档就必须能拿到地址 ——
 * 而 `db:push` 之后 `feeds` 表已经删了，**订阅文档没有 url 就等于这个源再也不会被抓**。
 *
 * ## 地址从哪来
 *
 * 用户库里存着该源的 **FeedDoc 副本**（`feed:{feedId}` 或裸 feedId），里面带着 `url`。
 * 那是旧模型从源库复制进用户库的展示字段，`db:push` 不会碰 CouchDB，所以还在。
 *
 * ## 两种情形
 *
 * - **对齐**（`feedId === deriveFeedId(url)`）：直接把 url 写进订阅文档。
 * - **对不齐**：旧代码允许管理员改 `feeds.url`，改完 `feedId` **没跟着变**
 *   （它是创建时派生的）。这类订阅如果照抄 url，`parseSubscription` 会判
 *   `url-feed-id-mismatch` 并跳过，还是抓不到。所以按**新地址重新派生 feedId**，
 *   新建一条订阅文档，并把旧前缀下的条目原样搬过去（改 `_id` 前缀），
 *   最后删掉旧订阅文档 —— 用户的阅读记录（`entry-state:`）按条目 id 关联，也要跟着改。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/backfill-subscription-urls.ts --dry-run   # 只看会做什么
 * npx tsx scripts/backfill-subscription-urls.ts --yes       # 真写
 * ```
 */

interface Plan {
  userId: string
  dbName: string
  oldFeedId: string
  url: string
  title: string
  /** 对齐 / 需要换 feedId */
  action: "fill" | "rekey"
  /** rekey 时的新 feedId */
  newFeedId?: string
  entryCount?: number
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

/** 读该用户的 FeedDoc（可能不存在） */
async function readFeedDoc(scope: ReturnType<typeof createCouchDb>, feedId: string): Promise<Record<string, unknown> | null> {
  try {
    return await scope.get(feedDocId(feedId)) as unknown as Record<string, unknown>
  } catch {
    // 兼容早期没有 feedDocId 前缀的库存文档
    try {
      return await scope.get(feedId) as unknown as Record<string, unknown>
    } catch {
      return null
    }
  }
}

/** 数某前缀下的条目 */
async function countEntries(scope: ReturnType<typeof createCouchDb>, feedId: string): Promise<number> {
  const prefix = `entry:${feedId}:`
  try {
    const res = await scope.list({ startkey: prefix, endkey: `${prefix}\uffff`, include_docs: false, limit: 1000 })
    return res.rows.length
  } catch {
    return 0
  }
}

async function main() {
  const dryRun = !flag("--yes")
  if (!flag("--dry-run") && !flag("--yes")) {
    console.error("拒绝执行：必须显式传 --dry-run（只看）或 --yes（真写）")
    process.exit(1)
  }
  console.log(dryRun ? "== DRY RUN：不写任何东西 ==" : "== 开始写入 ==")

  const users = await db.select({ id: user.id, dbName: user.timelineDbName }).from(user)
  const plans: Plan[] = []
  let skippedBot = 0
  let alreadyOk = 0
  let noUrl = 0

  for (const row of users) {
    if (!row.dbName) continue
    const dbName = await ensureTimelineDatabase(row.id)
    const scope = createCouchDb(dbName)
    let docs: Array<Record<string, unknown>>
    try {
      const res = await scope.list({ startkey: "subscription:", endkey: "subscription:\uffff", include_docs: true })
      docs = res.rows.map((r) => r.doc as Record<string, unknown>).filter(Boolean)
    } catch (err) {
      console.warn(`  读 ${dbName} 失败：${(err as Error)?.message ?? err}`)
      continue
    }

    for (const doc of docs) {
      // Bot 订阅没有 url，也不是 RSS 源
      if (doc.kind === "bot") { skippedBot += 1; continue }
      const feedId = typeof doc.feedId === "string" ? doc.feedId : ""
      if (!feedId) continue
      // 已经有 url 且能通过校验 = 不用动
      if (parseSubscription(doc).ok) { alreadyOk += 1; continue }

      const feedDoc = await readFeedDoc(scope, feedId)
      const url = typeof feedDoc?.url === "string" ? feedDoc.url.trim() : ""
      if (!url) { noUrl += 1; continue }

      const title = (typeof doc.title === "string" && doc.title) || (typeof feedDoc?.title === "string" ? feedDoc.title : url)
      const expected = deriveFeedId(url)
      const entryCount = await countEntries(scope, feedId)
      if (expected === feedId) {
        plans.push({ userId: row.id, dbName, oldFeedId: feedId, url, title, action: "fill", entryCount })
      } else {
        plans.push({ userId: row.id, dbName, oldFeedId: feedId, url, title, action: "rekey", newFeedId: expected, entryCount })
      }
    }
  }

  console.log(`\n扫描结果：`)
  console.log(`  已是新格式（有 url 且能校验）: ${alreadyOk}`)
  console.log(`  需要补 url（feedId 对得上）  : ${plans.filter(p => p.action === "fill").length}`)
  console.log(`  需要换 feedId（改过地址）      : ${plans.filter(p => p.action === "rekey").length}`)
  console.log(`  找不到 url（无 FeedDoc）      : ${noUrl}`)
  console.log(`  Bot 订阅（不需要 url）        : ${skippedBot}`)
  for (const p of plans.filter(x => x.action === "rekey")) {
    console.log(`    rekey ${p.oldFeedId} → ${p.newFeedId}  (${p.entryCount} 条目)  ${p.url}`)
  }

  if (dryRun) {
    console.log("\n（dry run 到此为止。确认无误后加 --yes 执行）")
    return
  }

  // ── 执行 ──
  let filled = 0
  let rekeyed = 0
  let movedEntries = 0
  let movedStates = 0
  for (const p of plans) {
    const scope = createCouchDb(p.dbName)
    try {
      if (p.action === "fill") {
        // 只补 url（读改写：订阅文档是客户端也会写的，必须带 _rev）
        const doc = await scope.get(subscriptionDocId(p.oldFeedId)) as Record<string, unknown>
        await scope.insert({ ...doc, url: p.url } as never)
        filled += 1
        continue
      }

      // rekey：把旧前缀下的条目改成新前缀，再换订阅文档。
      //
      // **不能直接改 `_id` 后 bulk 写**：条目的 `_attachments` 是 stub（digest + revpos +
      // stub:true），CouchDB 会拿它去原文档的附件存储里找字节，而新 id 没有那份字节 ——
      // 报 `Invalid attachment stub ... for img-0.avif`（实测 7 条全部失败）。
      // 所以必须带 `attachments: true` 读出正文附件，再用 multipart 写到新 id。
      const oldPrefix = `entry:${p.oldFeedId}:`
      const newPrefix = `entry:${p.newFeedId!}:`
      for (let round = 0; round < 50; round++) {
        const res = await scope.list({ startkey: oldPrefix, endkey: `${oldPrefix}\uffff`, include_docs: false, limit: 100 })
        const ids = (res.rows as Array<{ id: string }>).map((r) => r.id)
        if (ids.length === 0) break
        for (const oldId of ids) {
          const doc = await scope.get(oldId, { attachments: true }) as unknown as Record<string, unknown> & {
            _rev?: string
            _attachments?: Record<string, { data: string, content_type: string }>
          }
          const { _rev: rev, _attachments, ...rest } = doc
          const newId = oldId.replace(oldPrefix, newPrefix)
          const attachments = Object.entries(_attachments ?? {}).map(([name, att]) => ({
            name,
            data: Buffer.from(att.data, "base64"),
            content_type: att.content_type,
          }))
          const next = { ...rest, _id: newId, feedId: p.newFeedId! }
          if (attachments.length > 0) {
            await scope.multipart.insert(next as never, attachments, { docName: newId })
          } else {
            await scope.insert(next as never)
          }
          await scope.destroy(oldId, String(rev))
          movedEntries += 1
        }
      }

      // FeedDoc 副本也换 id（客户端按新 feedId 查源名/图标）
      const feedDoc = await readFeedDoc(scope, p.oldFeedId)
      if (feedDoc) {
        const { _rev: _fr, ...feedRest } = feedDoc
        await scope.insert({ ...feedRest, _id: feedDocId(p.newFeedId!), feedId: p.newFeedId!, url: p.url } as never).catch(() => {})
      }

      // 已读/收藏状态也要跟着换：它的 _id 与 entryId 都内嵌了条目 id，
      // 不搬的话用户的阅读记录会挂到不存在的旧条目上（617 条实测数据会全丢）。
      const oldEntryPrefix = `entry:${p.oldFeedId}:`
      const newEntryPrefix = `entry:${p.newFeedId!}:`
      const statePrefix = `entry-state:${oldEntryPrefix}`
      for (let round = 0; round < 50; round++) {
        const res = await scope.list({ startkey: statePrefix, endkey: `${statePrefix}\uffff`, include_docs: true, limit: 200 })
        const rows = res.rows as Array<{ doc?: Record<string, unknown> }>
        if (rows.length === 0) break
        const moved: Array<Record<string, unknown>> = []
        for (const row of rows) {
          const doc = row.doc
          if (!doc?._id) continue
          const { _rev: rev, ...rest } = doc as Record<string, unknown> & { _rev?: string }
          const oldEntryId = String(doc.entryId ?? "")
          const newEntryId = oldEntryId.replace(oldEntryPrefix, newEntryPrefix)
          moved.push({
            ...rest,
            _id: `entry-state:${newEntryId}`,
            entryId: newEntryId,
            feedId: p.newFeedId,
          })
          moved.push({ _id: doc._id, _rev: rev, _deleted: true })
        }
        if (moved.length === 0) break
        await scope.bulk({ docs: moved } as never)
        movedStates += rows.length
      }

      // 新订阅文档 + 删旧订阅
      const oldSub = await scope.get(subscriptionDocId(p.oldFeedId)) as Record<string, unknown>
      const { _rev: _sr, ...subRest } = oldSub
      await scope.insert({
        ...subRest,
        _id: subscriptionDocId(p.newFeedId!),
        feedId: p.newFeedId!,
        url: p.url,
        title: p.title,
      } as never)
      await scope.destroy(subscriptionDocId(p.oldFeedId), String(oldSub._rev))

      // 调度状态也要换 key：那是 `_local/schedule` 里的一个 map，键是 feedId。
      // 不换的话新 feedId 会被当成"从没抓过"（会立刻抓一次，无害），但旧键会一直占着。
      try {
        const { readSchedule, mergeSourceSchedule, dropSourceSchedule } = await import("../src/services/owner-schedule")
        const sched = await readSchedule(p.dbName)
        const old = sched.sources?.[p.oldFeedId]
        if (old) {
          await mergeSourceSchedule(p.dbName, p.newFeedId!, {
            lastFetchedAt: old.lastFetchedAt,
            lastNewEntryAt: old.lastNewEntryAt,
            errorStreak: 0,
            hasValidators: old.hasValidators,
            retentionEntries: old.retentionEntries,
          })
          await dropSourceSchedule(p.dbName, p.oldFeedId)
        }
      } catch {
        // 调度状态丢了只是"下一轮重新抓一次"，不影响内容
      }

      rekeyed += 1
    } catch (err) {
      console.warn(`  ${p.action} 失败 ${p.oldFeedId}：${(err as Error)?.message ?? err}`)
    }
  }

  console.log(`\n补 url: ${filled}，换 feedId: ${rekeyed}，搬条目: ${movedEntries}，搬已读/收藏: ${movedStates}`)
  console.log("\n== 完成 ==")
  console.log("下一步：重启后端；这些源会在下一轮调度里按新订阅开始抓。")
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
