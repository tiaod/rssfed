/**
 * 源库自适应保留条数的运维脚本：默认 **dry-run**（只报告会落到哪一档、会裁多少），
 * `--apply` 才真的写 N 并裁剪源库。
 *
 * 用法（在 packages/hono-server 下）：
 *   pnpm feed-retention                # 全量 dry-run，打印会变档的源
 *   pnpm feed-retention --limit 50     # 只跑前 50 个源
 *   pnpm feed-retention --feed-id <id> # 单源
 *   pnpm feed-retention --apply        # 真应用（写 feeds.retention_entries + 裁剪）
 *
 * ⚠️ N 变小是**破坏性**的：源库删除会随复制一路传到所有用户库与浏览器。第一次上线前先用
 * dry-run 看一眼会裁多少，必要时用 --limit 灰度。
 */
import 'dotenv/config'
import pLimit from 'p-limit'
import {
  inspectAdaptiveRetentionFeed,
  listAdaptiveRetentionFeeds,
  readAdaptiveRetentionConfig,
  runAdaptiveRetentionForFeed,
} from '../src/services/feed-retention'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const limitArg = argv[argv.indexOf('--limit') + 1]
const feedArg = argv[argv.indexOf('--feed-id') + 1]
const maxFeeds = argv.includes('--limit') ? Math.max(1, Number(limitArg) || 1) : undefined
const onlyFeed = argv.includes('--feed-id') ? feedArg : undefined

const fmtMb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}MB`
const fmtKb = (bytes: number) => `${(bytes / 1024).toFixed(0)}KB`

async function main() {
  const config = readAdaptiveRetentionConfig({ dryRun: !apply })
  let feeds = await listAdaptiveRetentionFeeds()
  if (onlyFeed) feeds = feeds.filter((feed) => feed.id === onlyFeed)
  if (maxFeeds && !onlyFeed) feeds = feeds.slice(0, maxFeeds)
  console.log(
    `\n=== 自适应保留 ${apply ? '应用' : 'dry-run'}：${feeds.length} 个源`
    + `（并发 ${config.concurrency}）===\n`,
  )

  if (!apply) {
    const limit = pLimit(config.concurrency)
    const rows = (await Promise.all(feeds.map((feed) => limit(() => inspectAdaptiveRetentionFeed(feed)))))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
    // currentN=null 是「首次设定」：会写 PG 并裁剪，但不是"从旧档变过来"
    const firstSet = rows.filter((row) => row.currentN === null && row.nextN !== 50)
    const changed = rows.filter((row) => row.currentN !== null && row.changed)
    const dist: Record<string, number> = {}
    for (const row of rows) dist[String(row.nextN)] = (dist[String(row.nextN)] ?? 0) + 1
    console.log('N 分布（按目标档位）:', JSON.stringify(dist))
    console.log(
      `首次设定 ${firstSet.length} 个源，从旧档变过来 ${changed.length} 个，`
      + `跳过 ${feeds.length - rows.length} 个（样本不足/视图缺失）\n`,
    )
    const pending = [...firstSet, ...changed]
    pending.sort((a, b) => (b.currentN ?? 50) - b.nextN - ((a.currentN ?? 50) - a.nextN))
    for (const row of pending.slice(0, 80)) {
      console.log(
        `  ${row.feedId}  N ${row.currentN ?? 50} → ${row.nextN}`
        + `  条目≈${Math.max(0, row.docCount - 1)}`
        + `  活跃=${row.bytesPerDay === null ? '-' : `${fmtKb(row.bytesPerDay)}/天`}`
        + `  体积=${fmtMb(row.externalBytes)}  库=${row.couchDbName}`,
      )
    }
    if (pending.length > 80) console.log(`  … 其余 ${pending.length - 80} 个略（可用 --limit 缩小范围）`)
    return
  }

  let done = 0
  const totals = { feeds: 0, changed: 0, shrunk: 0, trimmed: 0, skipped: 0, errors: 0 }
  const limit = pLimit(config.concurrency)
  await Promise.all(feeds.map((feed) => limit(async () => {
    try {
      const result = await runAdaptiveRetentionForFeed(feed, config)
      totals.feeds += 1
      if (result.skipped) totals.skipped += 1
      if (result.changed) totals.changed += 1
      if (result.shrunk) totals.shrunk += 1
      totals.trimmed += result.trimmed
    } catch (err) {
      totals.errors += 1
      console.warn(`  ${feed.id} 失败：${((err as Error)?.message ?? String(err)).slice(0, 200)}`)
    }
    done += 1
    if (done % 100 === 0) console.log(`  已处理 ${done}/${feeds.length}`)
  })))
  console.log(
    `\n完成：源=${totals.feeds} 变档=${totals.changed}（收紧=${totals.shrunk}）`
    + ` 裁掉=${totals.trimmed} 跳过=${totals.skipped} 失败=${totals.errors}`,
  )
  console.log('裁剪产生的删除会在下一轮聚合（默认 5 分钟）同步到用户库与浏览器。')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
