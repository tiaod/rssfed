/**
 * 源库墓碑 GC 的运维脚本：默认 **dry-run**（只报告能清多少），`--apply` 才真的 purge。
 *
 * 用法（在 packages/hono-server 下）：
 *   pnpm tombstone-gc                 # 全量 dry-run
 *   pnpm tombstone-gc --limit 50      # 只跑前 50 个源
 *   pnpm tombstone-gc --source <id>   # 单源
 *   pnpm tombstone-gc --apply         # 真清（会 purge + compact）
 *
 * 报告口径：
 *   - `新墓碑` = 本次扫 changes 补录的条目墓碑（历史墓碑在功能上线后第一次跑时全量补录）
 *   - `可清`   = 当前水位判定下已经能 purge 的（含 dry-run 下"无订阅者"的源全部算可清）
 *   - `被挡`   = 还有订阅者没同步到该墓碑之后；被挡的源会自动 nudge 一次同步（--apply 时）
 */
import 'dotenv/config'
import {
  listTombstoneGcFeeds,
  readTombstoneGcConfig,
  runTombstoneGcForFeed,
  type TombstoneGcFeed,
} from '../src/services/timeline-maintenance'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const limitArg = argv[argv.indexOf('--limit') + 1]
const sourceArg = argv[argv.indexOf('--source') + 1]
const maxSources = argv.includes('--limit') ? Math.max(1, Number(limitArg) || 1) : undefined
const onlySource = argv.includes('--source') ? sourceArg : undefined

async function main() {
  const config = readTombstoneGcConfig({
    dryRun: !apply,
    maxSources,
  })
  let feeds: TombstoneGcFeed[] = await listTombstoneGcFeeds()
  if (onlySource) feeds = feeds.filter((feed) => feed.id === onlySource)
  if (maxSources && !onlySource) feeds = feeds.slice(0, maxSources)
  console.log(
    `\n=== 墓碑 GC ${apply ? '实清' : 'dry-run'}：${feeds.length} 个 feed 库 ===`
    + `（并发 ${config.concurrency}，batch=${config.batchSize}，grace=${config.graceMs}ms）\n`,
  )

  let cursor = 0
  const totals = { scannedChanges: 0, recorded: 0, purgeable: 0, purged: 0, blocked: 0, nudged: 0, compacted: 0 }
  const rows: Array<{ feed: TombstoneGcFeed, result: Awaited<ReturnType<typeof runTombstoneGcForFeed>> }> = []
  let done = 0
  let failed = 0

  const worker = async () => {
    while (cursor < feeds.length) {
      const feed = feeds[cursor++]!
      try {
        const result = await runTombstoneGcForFeed(feed.id, feed.couchDbName, config)
        rows.push({ feed, result })
        totals.scannedChanges += result.scannedChanges
        totals.recorded += result.recorded
        totals.purgeable += result.purgeable
        totals.purged += result.purged
        totals.compacted += result.compacted
        if (result.blocked) totals.blocked += 1
        if (result.nudged) totals.nudged += 1
      } catch (err) {
        failed += 1
        const message = ((err as Error)?.message ?? String(err)).slice(0, 300)
        console.warn(`   ⚠ ${feed.title ?? feed.id}: ${message}`)
      }
      done += 1
      if (done % 100 === 0) {
        console.log(`   进度 ${done}/${feeds.length}，累计可清 ${totals.purgeable}、已清 ${totals.purged}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker))

  // 只列"有内容"的源：有可清墓碑 / 本次扫到新墓碑 / 被挡住
  const interesting = rows
    .filter(({ result }) => result.purgeable > 0 || result.recorded > 0 || result.blocked)
    .sort((a, b) => (b.result.purgeable + b.result.recorded) - (a.result.purgeable + a.result.recorded))
  console.log(`\n=== 明细（前 ${Math.min(30, interesting.length)} 个源）===`)
  for (const { feed, result } of interesting.slice(0, 30)) {
    console.log(
      `  ${(feed.title ?? feed.id).slice(0, 40).padEnd(42)}`
      + ` 新墓碑=${String(result.recorded).padStart(5)}`
      + ` 可清=${String(result.purgeable).padStart(5)}`
      + ` 已清=${String(result.purged).padStart(5)}`
      + ` 待办=${String(result.pendingLeft).padStart(5)}`
      + (result.blocked ? ' [被挡]' : '')
      + (result.compacted ? ' [compact]' : ''),
    )
  }
  if (interesting.length > 30) console.log(`  … 另有 ${interesting.length - 30} 个源`)

  console.log(
    `\n=== 汇总：源=${feeds.length} 扫changes=${totals.scannedChanges} 新墓碑=${totals.recorded} `
    + `可清=${totals.purgeable} 已清=${totals.purged} compact=${totals.compacted} `
    + `被挡=${totals.blocked} nudge=${totals.nudged} 失败=${failed} ===`,
  )
  if (!apply) {
    console.log('\n（dry-run 结束：没有写 PG、没有 purge、没有 nudge。加 --apply 才会真的清理。）')
  } else {
    console.log('\n（已实清。文件字节的回收由 compact 在后台完成。）')
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('墓碑 GC 脚本失败：', err)
  process.exit(1)
})
