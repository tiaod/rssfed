import "dotenv/config"
import postgres from "postgres"
import { createCouchDb, ensureTimelineDatabase, nanoServer } from "../src/couchdb/client"

/**
 * 一次性运维脚本：把遗留的 `user-state_<随机>` 库里的用户状态文档搬进合并后的用户库
 * （`user-timeline_<随机>`，见 ARCHITECTURE.md 的「用户库」）。
 *
 * 为什么必须搬：合并之后服务端只读写用户库，客户端升级时本地那个 `rssfed-user-state-<uid>`
 * 会被 v5 清理标记删掉 —— 如果服务端没把状态搬过去，用户就**永久失去订阅关系与已读/收藏**
 * （订阅不在 PostgreSQL 里，任何地方都重建不出来；条目倒是可以重新聚合）。
 *
 * 用法（先在服务器上 dry-run 看清要搬什么）：
 *   docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate \
 *     pnpm exec tsx scripts/merge-user-state-into-timeline.ts
 *   # 确认无误后加 --apply 真搬；老库确认没用了再加 --delete-source 删除
 *   docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate \
 *     pnpm exec tsx scripts/merge-user-state-into-timeline.ts --apply --delete-source
 *
 * 不变量：
 *   - **带原 `_rev` 搬运**（`new_edits: false`）：客户端本地那份状态文档的 rev 与远端一致，
 *     rev 不一致会让客户端把整份状态当成新改动重新推一遍（甚至把对端的删除位复活）。
 *   - **幂等**：同一份文档重复搬不会产生冲突（rev 相同即视为已存在），可以反复执行；
 *     部署窗口内用户还在往老库写，所以在切流量前再跑一次是安全且推荐的做法。
 *   - 老库 → 用户的映射优先取库级 `_security.members.names[0]`（服务端写的就是用户 id），
 *     这样即使 `user.couch_db_name` 列已经被 migrate 删掉也照样能对上；只有拿不到 `_security`
 *     时才回退查那一列（若列已不存在则跳过并告警）。
 */

const APPLY = process.argv.includes("--apply")
const DELETE_SOURCE = process.argv.includes("--delete-source")
const VERBOSE = process.argv.includes("--verbose")
const LIMIT = readNumberArg("--limit")
const CHUNK = 200

function readNumberArg(flag: string): number | null {
  const arg = process.argv.find(a => a.startsWith(`${flag}=`))
  if (!arg) return null
  const value = Number(arg.split("=")[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

const LEGACY_PREFIX = "user-state_"
/** 用户库的前缀（合并后的唯一库；与 src/db/constants.ts 的 COUCHDB_USER_TIMELINE_PREFIX 一致） */
const TIMELINE_PREFIX = "user-timeline_"

interface LegacyDb { name: string, userId: string | null, docs: Array<Record<string, unknown>> }

/** 列出遗留库名（`_all_dbs` 只返回名字，逐个库再取 `_security`） */
async function listLegacyDbs(): Promise<string[]> {
  const names = await nanoServer.db.list() as string[]
  return names.filter(name => name.startsWith(LEGACY_PREFIX)).sort()
}

/** 读库级 `_security` 里的 members.names[0]（服务端建库时写的就是 userId） */
async function ownerOf(dbName: string): Promise<string | null> {
  try {
    const security = await nanoServer.request({ db: dbName, path: "_security" }) as {
      members?: { names?: string[] }
    }
    return security?.members?.names?.[0] ?? null
  } catch {
    return null
  }
}

/** 读出库里全部用户文档（跳过设计文档；`_local` 不在 `_all_docs` 里，不需要处理） */
async function readStateDocs(dbName: string): Promise<Array<Record<string, unknown>>> {
  const docs: Array<Record<string, unknown>> = []
  let skip = 0
  for (;;) {
    const page = await nanoServer.request({
      db: dbName,
      path: "_all_docs",
      method: "GET",
      qs: { include_docs: "true", limit: CHUNK, skip },
    }) as { rows?: Array<{ id: string, doc?: Record<string, unknown> | null }> }
    const rows = page?.rows ?? []
    for (const row of rows) {
      if (row.id.startsWith("_design/")) continue
      if (row.doc) docs.push(row.doc)
    }
    if (rows.length < CHUNK) break
    skip += rows.length
  }
  return docs
}

/** 回退路径：`couch_db_name` 列还在时用它做映射（列已被 migrate 删掉就返回空表） */
async function legacyNameToUserFromDb(): Promise<Map<string, string>> {
  const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost:5432/rssfed")
  const map = new Map<string, string>()
  try {
    const columns = await sql`
      select 1 from information_schema.columns
      where table_name = 'user' and column_name = 'couch_db_name'
    `
    if (columns.length === 0) return map
    const rows = await sql<Array<{ id: string, couch_db_name: string | null }>>`
      select id, couch_db_name from "user" where couch_db_name is not null
    `
    for (const row of rows) if (row.couch_db_name) map.set(row.couch_db_name, row.id)
  } catch (err) {
    console.warn(`  ! 读取 couch_db_name 失败（忽略）：${(err as Error)?.message ?? err}`)
  } finally {
    await sql.end()
  }
  return map
}

async function main() {
  const legacyNames = await listLegacyDbs()
  console.log(`遗留 user-state 库：${legacyNames.length} 个${LIMIT ? `（本次只处理前 ${LIMIT} 个）` : ""}`)
  if (legacyNames.length === 0) {
    console.log("没有需要搬运的库。")
    return
  }

  const fallback = await legacyNameToUserFromDb()
  const targets = LIMIT ? legacyNames.slice(0, LIMIT) : legacyNames

  let totalDocs = 0
  let totalErrors = 0
  let totalDeleted = 0
  const skipped: string[] = []

  for (const legacyName of targets) {
    const userId = await ownerOf(legacyName) ?? fallback.get(legacyName) ?? null
    if (!userId) {
      skipped.push(legacyName)
      console.warn(`! ${legacyName}：对不上用户（_security 与 couch_db_name 都没有），跳过`)
      continue
    }

    const docs = await readStateDocs(legacyName)
    const timelineDb = APPLY ? await ensureTimelineDatabase(userId) : `(dry-run) ${TIMELINE_PREFIX}*`
    console.log(`· ${legacyName} → user=${userId} docs=${docs.length} → ${timelineDb}`)
    if (VERBOSE) {
      for (const doc of docs) console.log(`    ${String(doc._id)} rev=${String(doc._rev)} type=${String(doc.type ?? "-")}`)
    }
    totalDocs += docs.length
    if (!APPLY || docs.length === 0) continue

    // new_edits: false + 原 _rev：与客户端手上那份保持同一版本，不产生冲突也不需要重推
    const scope = createCouchDb(timelineDb)
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK)
      const results = await scope.bulk({ docs: chunk, new_edits: false } as never) as unknown as Array<{ error?: string }>
      const errors = results.filter(r => r?.error)
      totalErrors += errors.length
      for (const err of errors) console.warn(`    ! 搬运失败：${JSON.stringify(err)}`)
    }

    if (DELETE_SOURCE) {
      await nanoServer.db.destroy(legacyName)
      totalDeleted++
      console.log(`  已删除源库 ${legacyName}`)
    }
  }

  const mode = APPLY ? (DELETE_SOURCE ? "已搬运并删除源库" : "已搬运") : "dry-run（未写入任何数据）"
  console.log(`\n${mode}：库 ${targets.length} 个、文档 ${totalDocs} 份、失败 ${totalErrors} 份` +
    `${DELETE_SOURCE ? `、删除源库 ${totalDeleted} 个` : ""}`)
  if (skipped.length > 0) console.log(`跳过 ${skipped.length} 个：${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " …" : ""}`)
  if (!APPLY) console.log("确认无误后加 --apply 真搬（可反复执行，幂等）")
  if (APPLY && !DELETE_SOURCE) console.log("源库还留着（回滚余量）。确认新架构稳定后再加 --delete-source 删掉")
  if (totalErrors > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error("搬运失败：", err)
  process.exit(1)
})
