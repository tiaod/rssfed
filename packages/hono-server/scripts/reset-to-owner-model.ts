// 与 index.ts 一致：脚本跑在仓库里，环境变量来自 .env
import "dotenv/config"
import { nanoServer } from "../src/couchdb/client"
import { db } from "../src/db"
import { sql } from "drizzle-orm"

/**
 * 一次性迁移：清掉「共享源库 + 复制扇出」时代的全部遗留数据。
 *
 * ## 什么时候需要
 *
 * 从旧模型（`feed_*` 库 + 用户库镜像 + PG 水位表）切到新模型（每 owner 独立抓取、
 * 直接写自己的库）时跑一次。**不可逆**：删掉的内容要靠重新抓 RSS 补，
 * 而发布方当前还列着什么就补什么。
 *
 * ## 为什么必须清，不能兼容
 *
 * 旧订阅文档 `subscription:{feedId}` **没有 `url` 字段**（当时的地址在 PG `feeds` 表里），
 * 而新模型的抓取完全依赖订阅文档里的 url —— `feedId` 是 `sha256(url)` 截断，不可逆。
 * 所以老订阅没法自动补全，只能让用户重新订阅一次。测试期直接清库重来是最省事的。
 *
 * ## 保留什么
 *
 * - `user` / `session`（账号，不然所有人要重新注册）
 * - `bots` / `bot_followers` / `bot_following` / `bot_inbox`（Bot 的联邦身份与关系）
 * - `site_settings` / `attachments`（站点配置与已上传文件）
 * - 对象存储里的 `image-cache/`（内容寻址的图片缓存，新模型继续用）
 *
 * ## 用法
 *
 * ```bash
 * # 先看会删什么（不删任何东西）
 * pnpm tsx scripts/reset-to-owner-model.ts --dry-run
 * # 真删
 * pnpm tsx scripts/reset-to-owner-model.ts --yes
 * ```
 */

const COUCH_FEED_PREFIX = "feed_"
const COUCH_OWNER_PREFIXES = ["user-timeline_", "bot_"]

function arg(name: string): boolean {
  return process.argv.includes(name)
}

async function main() {
  const dryRun = !arg("--yes")
  if (!arg("--dry-run") && !arg("--yes")) {
    console.error("拒绝执行：必须显式传 --dry-run（只看）或 --yes（真删）")
    process.exit(1)
  }

  console.log(dryRun ? "== DRY RUN：不会删除任何东西 ==" : "== 开始删除 ==")

  // ① CouchDB：列出所有本服务的库并分类
  const allDbs = await nanoServer.db.list() as string[]
  const feedDbs = allDbs.filter((name) => name.startsWith(COUCH_FEED_PREFIX))
  const ownerDbs = allDbs.filter((name) => COUCH_OWNER_PREFIXES.some((p) => name.startsWith(p)))
  const otherDbs = allDbs.filter((name) => !name.startsWith(COUCH_FEED_PREFIX)
    && !COUCH_OWNER_PREFIXES.some((p) => name.startsWith(p)))

  console.log(`\n[CouchDB] 共 ${allDbs.length} 个库`)
  console.log(`  共享源库 feed_*      ：${feedDbs.length} 个（全删）`)
  console.log(`  owner 库 user-timeline_/bot_：${ownerDbs.length} 个（清空内容重建）`)
  console.log(`  其它（系统库等）      ：${otherDbs.length} 个（不动）`)

  // ② PostgreSQL：水位表整张清空（新模型没有水位）
  const watermarks = await db.execute(sql`select count(*)::int as n from timeline_source_sync`)
    .catch(() => [{ n: 0 }]) as Array<{ n: number }>
  console.log(`\n[PostgreSQL] timeline_source_sync：${watermarks[0]?.n ?? 0} 行（全删）`)

  if (dryRun) {
    console.log("\n（dry run 到此为止。确认无误后加 --yes 执行）")
    return
  }

  // ③ 删共享源库
  let deleted = 0
  for (const name of feedDbs) {
    try {
      await nanoServer.db.destroy(name)
      deleted += 1
      if (deleted % 50 === 0) console.log(`  已删 ${deleted}/${feedDbs.length} 个源库`)
    } catch (err) {
      console.warn(`  删库失败 ${name}：${(err as Error)?.message ?? err}`)
    }
  }
  console.log(`[CouchDB] 删掉 ${deleted}/${feedDbs.length} 个共享源库`)

  // ④ 清空 owner 库（订阅文档缺 url，没法迁移；保留库名以便客户端继续同步同一个库）
  for (const name of ownerDbs) {
    try {
      const scope = nanoServer.use(name)
      // 删所有非设计文档（订阅/条目/已读/收藏都是旧格式）
      const { rows } = await scope.list({ include_docs: false })
      const docs = rows
        .map((row) => ({ _id: row.id, _rev: (row.value as { rev?: string })?.rev, _deleted: true }))
        .filter((doc): doc is { _id: string, _rev: string, _deleted: true } =>
          Boolean(doc._rev) && !doc._id.startsWith("_design/"))
      for (let i = 0; i < docs.length; i += 500) {
        await scope.bulk({ docs: docs.slice(i, i + 500) } as never).catch(() => {})
      }
      // 设计文档也删掉：新模型的设计文档结构变了（两个视图合并成一份），让下次 ensure 重装
      for (const row of rows) {
        if (row.id.startsWith("_design/")) {
          const rev = (row.value as { rev?: string })?.rev
          if (rev) await scope.destroy(row.id, rev).catch(() => {})
        }
      }
      console.log(`[CouchDB] 清空 ${name}：${docs.length} 个文档`)
    } catch (err) {
      console.warn(`  清空失败 ${name}：${(err as Error)?.message ?? err}`)
    }
  }

  // ⑤ PG：水位表（新模型没有它；表本身在生产由 drizzle-kit push 删除）
  await db.execute(sql`delete from timeline_source_sync`).catch((err) => {
    console.warn(`  timeline_source_sync 清空失败（可能表已被删）：${(err as Error)?.message ?? err}`)
  })
  console.log("[PostgreSQL] timeline_source_sync 已清空")

  console.log("\n== 完成 ==")
  console.log("下一步：")
  console.log("  1. pnpm db:push    # 让 schema 变更落库（会删 feeds 表与相关列）")
  console.log("  2. 重启后端，让调度器按 _local/schedule 重新开始")
  console.log("  3. 客户端清一次本地缓存（订阅文档格式变了），重新订阅需要的源")
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
