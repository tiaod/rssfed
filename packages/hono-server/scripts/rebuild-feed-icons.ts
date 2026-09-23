import "dotenv/config"
import { createCouchDb, nanoServer } from "../src/couchdb/client"
import { cacheSingleImage, FEED_ICON_CACHE_VERSION } from "../src/rss/entry-images"
import { COUCHDB_FEED_PREFIX } from "../src/db"

/**
 * 一次性重建 feed 图标附件（历史数据迁移用）。
 *
 * 背景：`cacheSingleImage` 原先未传 maxWidth，图标继承正文图片的 1200px 上限，
 * 而侧边栏只把图标渲染成约 20px 的头像 —— 实测 300 张 1200px AVIF 解码会阻塞
 * 主线程 1.0–5.3 秒。改为 64px 后，worker 只会在「下次抓取」时重压，
 * 订阅源多时可能要等好几轮抓取周期；本脚本直接把存量图标一次性重压。
 *
 * 幂等：`imageCached.v === FEED_ICON_CACHE_VERSION` 的文档直接跳过，可重复执行。
 *
 * 用法：
 *   pnpm --filter @rssfed/hono-server exec tsx scripts/rebuild-feed-icons.ts --dry-run
 *   pnpm --filter @rssfed/hono-server exec tsx scripts/rebuild-feed-icons.ts
 */

const dryRun = process.argv.includes("--dry-run")
/** 每个 feed 库最多一个 feed 文档；按库并发，避免 433 个源串行跑太久 */
const CONCURRENCY = 8

interface Stats {
  updated: number
  skipped: number
  failed: number
  noIcon: number
  oldBytes: number
  newBytes: number
  samples: Array<{ feedId: string, from: string, to: string }>
}

function attachmentBytes(doc: Record<string, unknown>, name: string): number {
  const atts = doc._attachments as Record<string, { length?: number }> | undefined
  return atts?.[name]?.length ?? 0
}

async function rebuildOne(dbName: string, stats: Stats): Promise<void> {
  const db = createCouchDb(dbName)
  let rows: Array<{ doc?: Record<string, unknown> }>
  try {
    const list = await db.list({ include_docs: true })
    rows = list.rows as Array<{ doc?: Record<string, unknown> }>
  } catch (err) {
    console.warn(`  ⚠️  ${dbName} 读取失败：${(err as Error).message}`)
    return
  }

  for (const row of rows) {
    const doc = row.doc
    if (!doc) continue
    const id = String(doc._id ?? "")
    // 设计文档不是 feed 元数据
    if (id.startsWith("_design")) continue

    const cached = doc.imageCached as { url?: string, attachment?: string, v?: number } | undefined
    const url = cached?.url ?? (doc.image as string | undefined)
    if (!url) {
      stats.noIcon++
      continue
    }
    if (cached?.v === FEED_ICON_CACHE_VERSION) {
      stats.skipped++
      continue
    }

    if (dryRun) {
      stats.updated++
      continue
    }

    try {
      const result = await cacheSingleImage(url)
      if (!result) {
        stats.failed++
        continue
      }
      const before = attachmentBytes(doc, result.image.attachment)
      await db.multipart.insert(
        { ...doc, image: url, imageCached: result.image },
        [{ name: result.image.attachment, data: result.data, content_type: "image/avif" }],
        { docName: id, rev: doc._rev as string },
      )
      stats.updated++
      stats.oldBytes += before
      stats.newBytes += result.data.length
      if (stats.samples.length < 8) {
        stats.samples.push({
          feedId: id,
          from: `${Math.round(before / 1024)}KB ${(doc.imageCached as { width?: number } | undefined)?.width ?? "?"}px`,
          to: `${Math.round(result.data.length / 1024)}KB ${result.image.width}px`,
        })
      }
    } catch (err) {
      stats.failed++
      console.warn(`  ⚠️  ${id} 重建失败：${(err as Error).message}`)
    }
  }
}

async function main() {
  const all = await nanoServer.db.list() as string[]
  const feedDbs = all.filter(name => name.startsWith(COUCHDB_FEED_PREFIX))
  console.log(`${dryRun ? "[dry-run] " : ""}发现 ${feedDbs.length} 个 feed 库，目标图标版本 v${FEED_ICON_CACHE_VERSION}`)

  const stats: Stats = { updated: 0, skipped: 0, failed: 0, noIcon: 0, oldBytes: 0, newBytes: 0, samples: [] }
  const queue = [...feedDbs]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const dbName = queue.shift()!
      await rebuildOne(dbName, stats)
    }
  })
  await Promise.all(workers)

  console.log(`\n${dryRun ? "[dry-run] " : ""}完成：`)
  console.log(`  需重建 ${stats.updated} 个（已是 v${FEED_ICON_CACHE_VERSION} 跳过 ${stats.skipped}）`)
  console.log(`  无图标 ${stats.noIcon}，失败 ${stats.failed}`)
  if (!dryRun && stats.updated > 0) {
    const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`
    console.log(`  附件体积：${kb(stats.oldBytes)} → ${kb(stats.newBytes)}`)
  }
  if (stats.samples.length > 0) {
    console.log("  样例：")
    for (const s of stats.samples) console.log(`    ${s.feedId}: ${s.from} → ${s.to}`)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error("❌ 重建失败:", error)
  process.exit(1)
})
