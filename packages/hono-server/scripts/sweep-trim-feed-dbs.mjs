#!/usr/bin/env node
/**
 * 上线前的一次性裁剪 sweep：把每个 feed 库裁到「最新 N 条」。
 *
 * 为什么需要它（`docs/notes/aggregation/source-side-retention-plan.md` §11）：
 * 切到镜像复制之后，**新订阅者/重扫的首拉 = 该源库的全部内容**。存量 feed 库还积着全部历史
 * （日常裁剪每次抓取最多删 2000 条，要好几轮才收敛），所以正式放开前先跑一次全量 sweep，
 * 否则第一次同步会把几十万条历史搬进用户库。
 *
 * 它做的事和抓取 worker 里的 `trimSourceToLatestN()` 完全一样（视图降序取 N+1 行算下界 →
 * 按 `publishedAt < 下界` 分页删），只是以库为单位批量跑、批量更大。
 *
 * **删除用标准 delete（留墓碑），不用 `_purge`**：墓碑是"删除能跟着复制传播"的载体
 * 以及"重扫不复活"的保证（实测 probe-e）。
 *
 * 用法：
 *   node packages/hono-server/scripts/sweep-trim-feed-dbs.mjs --dry-run   # 只看会删多少
 *   node packages/hono-server/scripts/sweep-trim-feed-dbs.mjs             # 真删
 *
 * 环境变量：COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD / SOURCE_RETENTION_ENTRIES(默认 50)
 *
 * **跑完还要让下游收敛**：这个脚本绕过抓取路径直接删源库文档，不会更新 PG 的
 * `feeds.last_changed_at`，而聚合侧的判据是「源在上次同步开始后有变化」—— 不 bump 的话
 * 一条删除都不会被搬到用户库。跑完执行一次：
 *
 *   UPDATE feeds SET last_changed_at = now() WHERE last_changed_at IS NOT NULL;
 *
 * 下一轮聚合（默认 5 分钟）就会把每个源重扫一遍，用户库/浏览器跟着删到镜像状态。
 */
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const N = Math.max(1, Number(process.env.SOURCE_RETENTION_ENTRIES ?? 50) || 50)
const BATCH = 500
/** 单个库最多跑几批（= BATCH * MAX_BATCHES 条）；没删完的再跑一遍脚本即可 */
const MAX_BATCHES = 200
const CONCURRENCY = 4
const DRY_RUN = process.argv.includes('--dry-run')
const VIEW = '/_design/main/_view/entries-by-date'

async function req(method, path, body) {
  const res = await fetch(COUCH + path, {
    method,
    headers: { Authorization: AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

/** dry-run：视图响应的 total_rows 就是该库的条目总数，一次请求就够 */
async function countEntries(db) {
  const res = await req('GET', `/${db}${VIEW}?limit=1`)
  if (res.status !== 200) return null
  return typeof res.json?.total_rows === 'number' ? res.json.total_rows : null
}

async function trimOne(db) {
  // ① 总条数（视图的 total_rows，与 limit 无关）
  const head = await req('GET', `/${db}${VIEW}?limit=1`)
  if (head.status !== 200) return { db, deleted: 0, note: 'view-missing' }
  const total = typeof head.json?.total_rows === 'number' ? head.json.total_rows : 0
  const excess = Math.max(0, total - N)
  if (DRY_RUN) return { db, deleted: 0, wouldDelete: excess, total }
  if (excess === 0) return { db, deleted: 0 }

  // ② 按视图**升序**（最旧在前）分批删掉 excess 条：行序是 (key, doc id) 的全序，
  //    所以并列时间戳也能精确收敛到 N 条（下界方案在并列时会一条都删不掉）。
  let deleted = 0
  let remaining = excess
  for (let batch = 0; batch < MAX_BATCHES && remaining > 0; batch++) {
    const page = await req('GET', `/${db}${VIEW}?include_docs=true&limit=${Math.min(BATCH, remaining)}`)
    const docs = (page.json?.rows ?? [])
      .map((row) => row.doc)
      .filter((doc) => doc?._id && doc?._rev)
    if (docs.length === 0) break
    const res = await req('POST', `/${db}/_bulk_docs`, {
      docs: docs.map((doc) => ({ _id: doc._id, _rev: doc._rev, _deleted: true })),
    })
    // 只统计成功删掉的：并发的同 rev 删除会作为 conflict 返回，忽略即可（幂等）
    const ok = (Array.isArray(res.json) ? res.json : []).filter((row) => !row.error).length
    deleted += ok
    remaining -= ok
    if (ok === 0) break // 没有进展就停，绝不对同一页无限重试
  }
  return { db, deleted }
}

async function main() {
  const dbList = await req('GET', '/_all_dbs')
  if (dbList.status !== 200) throw new Error(`读 _all_dbs 失败：${dbList.status}`)
  const dbs = (dbList.json ?? []).filter((name) => name.startsWith('feed_'))
  console.log(`\n=== 裁剪 sweep：${dbs.length} 个 feed 库，N=${N}${DRY_RUN ? '（dry-run，不写）' : ''} ===\n`)

  const results = []
  let cursor = 0
  let done = 0
  const worker = async () => {
    while (cursor < dbs.length) {
      const db = dbs[cursor++]
      try {
        results.push(await trimOne(db))
      } catch (err) {
        results.push({ db, deleted: 0, note: `error: ${err?.message ?? err}` })
      }
      done += 1
      if (done % 50 === 0) {
        const deleted = results.reduce((sum, r) => sum + (r.deleted ?? 0) + (r.wouldDelete ?? 0), 0)
        console.log(`   进度 ${done}/${dbs.length}，累计 ${DRY_RUN ? '会删' : '已删'} ${deleted} 条`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const total = results.reduce((sum, r) => sum + (r.deleted ?? 0) + (r.wouldDelete ?? 0), 0)
  const touched = results.filter((r) => (r.deleted ?? 0) > 0 || (r.wouldDelete ?? 0) > 0).length
  const problems = results.filter((r) => r.note)
  console.log(`\n=== 汇总：${touched} 个库${DRY_RUN ? '会' : '已'}裁剪，共 ${DRY_RUN ? '会删' : '已删'} ${total} 条 ===`)
  for (const problem of problems.slice(0, 10)) console.log(`   ⚠ ${problem.db}: ${problem.note}`)
  if (problems.length > 10) console.log(`   … 另有 ${problems.length - 10} 个`)
  console.log(DRY_RUN
    ? '\n（dry-run 结束；去掉 --dry-run 就真删。删除只留墓碑，磁盘要 compact 才回落。）'
    : '\n（已删。磁盘不会立刻回落：CouchDB 删除只产生墓碑，需要 [compactions] 或定时 _compact。）'
      + '\n记得 bump 下游：UPDATE feeds SET last_changed_at = now() WHERE last_changed_at IS NOT NULL;')
}

main().catch((err) => {
  console.error('sweep 失败：', err)
  process.exit(1)
})
