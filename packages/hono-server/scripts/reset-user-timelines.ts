import "dotenv/config"
import { eq } from "drizzle-orm"
import { db, user, bots as botsTable } from "../src/db"
import { createTimelineDatabase, nanoServer } from "../src/couchdb/client"

/**
 * 一次性重置：把每个用户的库换成**全新的空库**，然后由用户自己重新导入 OPML。
 *
 * ## 为什么不是"清空同一个库的内容"
 *
 * 客户端（`usePouchDb` 的 `startTimelineLiveSync`）只在**远端库名变化**时才丢掉本地缓存
 * 重新全量同步。就地清空同一个库的话，浏览器里那些旧条目会一直挂着 ——
 * 服务端用 `_purge` 删的文档不进 `_changes`，客户端根本收不到"它们没了"的信号。
 * 所以必须换库：`createTimelineDatabase` 生成新库名并回写 `user.timeline_db_name`，
 * 客户端下次同步发现库名变了，自动 `resetLocalData()` 重拉。
 *
 * ## 保留什么
 *
 * - `user` / `session`（账号）
 * - `bots` / `bot_followers` / `bot_following` / `bot_inbox`（联邦身份与关系；产出库不动）
 * - `site_settings` / `attachments`
 * - 对象存储的 `image-cache/`、`fetch-cache/`（可丢弃的中间产物，留着能省首轮抓取的流量）
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/reset-user-timelines.ts --dry-run   # 只看会做什么
 * npx tsx scripts/reset-user-timelines.ts --yes       # 真删真建
 * ```
 */

function flag(name: string): boolean {
  return process.argv.includes(name)
}

async function main() {
  const dryRun = !flag("--yes")
  if (!flag("--dry-run") && !flag("--yes")) {
    console.error("拒绝执行：必须显式传 --dry-run（只看）或 --yes（真执行）")
    process.exit(1)
  }
  console.log(dryRun ? "== DRY RUN：不动任何数据 ==" : "== 开始重置 ==")

  const users = await db.select({ id: user.id, email: user.email, dbName: user.timelineDbName }).from(user)
  const activeBots = await db.select({ id: botsTable.id, dbName: botsTable.couchDbName }).from(botsTable)

  console.log(`\n用户 ${users.length} 个、Bot ${activeBots.length} 个`)
  for (const u of users) {
    console.log(`  ${u.email ?? u.id}  旧库=${u.dbName ?? "(无)"}`)
  }

  if (dryRun) {
    console.log("\n将做的事：")
    console.log("  1. 为每个用户新建一个空库，回写 user.timeline_db_name")
    console.log("  2. 删掉旧库（连同旧订阅与旧条目）")
    console.log("  3. Bot 产出库保持不动（Bot 的联邦身份与已发内容不受影响）")
    console.log("  4. 不改 bots / site_settings / attachments")
    console.log("\n（dry run 到此为止。确认无误后加 --yes 执行）")
    return
  }

  let recreated = 0
  const failures: Array<{ id: string, error: string }> = []

  for (const row of users) {
    const oldDbName = row.dbName
    try {
      // ① 先建新库并把库名回写（这一步成功之后，客户端才会看到"库变了"）
      const newDbName = await createTimelineDatabase(row.id)
      if (newDbName === oldDbName) {
        failures.push({ id: row.id, error: "新库名与旧库名相同（不该发生）" })
        continue
      }
      // ② 删旧库：内容与旧订阅都不需要了，用户会重新导入 OPML
      if (oldDbName) {
        try {
          await nanoServer.db.destroy(oldDbName)
        } catch (err) {
          // 旧库不存在/正被删：不算失败，新库已经就位
          console.warn(`  旧库 ${oldDbName} 删除失败（不影响新库）：${(err as Error)?.message ?? err}`)
        }
      }
      recreated += 1
      console.log(`  ✓ ${row.email ?? row.id}  ${oldDbName ?? "(无)"} → ${newDbName}`)
    } catch (err) {
      failures.push({ id: row.id, error: (err as Error)?.message ?? String(err) })
      console.error(`  ✗ ${row.email ?? row.id} 失败：${(err as Error)?.message ?? err}`)
    }
  }

  // Bot 产出库不动，但它们的「最后产出时间」保留即可；这里什么都不做，
  // 只是明确写在日志里，避免以后有人以为漏了。
  console.log(`\nBot 产出库 ${activeBots.length} 个（保持不动）`)

  console.log(`\n完成：重置 ${recreated} 个用户库，失败 ${failures.length}`)
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ${f.id}: ${f.error}`)
  }
  console.log("\n下一步：")
  console.log("  1. 重启后端（清掉进程内缓存的库名与设计文档标记）")
  console.log("  2. 浏览器刷新页面：客户端会发现库名变了，自动丢掉本地缓存重拉")
  console.log("  3. 重新导入 OPML（订阅会带上 url，抓取立刻开始）")
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
