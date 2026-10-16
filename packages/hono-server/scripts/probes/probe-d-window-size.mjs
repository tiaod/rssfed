#!/usr/bin/env node
/**
 * 探针 D：`N = 30 天` 窗口下，汇聚库会有多大？—— 对**现有 dev 数据只读采样**。
 *
 * 这是 storage-refactor-plan.md 风险 4 的量化：客户端首次拉取量 = 汇聚库窗口内的全部内容
 * （含附件）。仓库留档里"642 个 feed 库 / 95,791 文档 / 2.0GB"是**全量历史**，不是窗口内的量，
 * 不能直接除以天数。这里直接量"每条源最近 30 天的条数与附件字节"。
 *
 * 只读：不写任何库、不建任何库。用 `POST /_dbs_info` 批量取库信息，用源库现成的
 * `_design/main/_view/entries-by-date` 视图（key = publishedAt）按时间下界取窗口内条目。
 *
 * 用法：node report/aggregation-purge/probe-d-window-size.mjs [采样源库数]
 */
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const SAMPLE = Number(process.argv[2] ?? 40)
const DAYS = Number(process.env.WINDOW_DAYS ?? 30)
const ROW_LIMIT = 3000

async function req(method, p, body) {
  const res = await fetch(COUCH + p, { method, headers: { Authorization: AUTH, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: text } }
}
const mb = (b) => (b / 1024 / 1024).toFixed(2)

const cutoff = new Date(Date.now() - DAYS * 86400_000).toISOString()
console.log(`\n=== 探针 D：${DAYS} 天窗口体积（只读采样）===`)
console.log(`时间下界 = ${cutoff}\n`)

const all = (await req('GET', '/_all_dbs')).json.filter((n) => n.startsWith('feed_'))
console.log(`源库总数：${all.length}`)

// 批量取库信息
const infos = []
for (let i = 0; i < all.length; i += 100) {
  const r = await req('POST', '/_dbs_info', { keys: all.slice(i, i + 100) })
  for (const row of r.json ?? []) if (row.info) infos.push({ db: row.key, docs: row.info.doc_count, file: row.info.sizes?.file ?? 0 })
}
const totalDocs = infos.reduce((s, x) => s + x.docs, 0)
const totalFile = infos.reduce((s, x) => s + x.file, 0)
console.log(`全部源库合计：${totalDocs} 文档 / 磁盘 ${mb(totalFile)}MB（= 全量历史，含已过期内容）`)

// 采样：最大的 10 个 + 等距抽样
const bySize = [...infos].sort((a, b) => b.docs - a.docs)
const stride = Math.max(1, Math.floor(bySize.length / SAMPLE))
const top10 = bySize.slice(0, 10)
const strideSet = bySize.filter((_, i) => i % stride === 0).slice(0, SAMPLE).filter((x) => !top10.includes(x))
const sample = [...top10.map((x) => ({ ...x, group: 'top' })), ...strideSet.map((x) => ({ ...x, group: 'stride' }))]
console.log(`采样 ${sample.length} 个源库：最大的 10 个（group=top）+ 等距抽样 ${strideSet.length} 个（group=stride）\n`)

const rows = []
for (const s of sample) {
  const q = `/db/_design/main/_view/entries-by-date?startkey=${encodeURIComponent(JSON.stringify(cutoff))}&include_docs=true&limit=${ROW_LIMIT}`
  const r = await req('GET', q.replace('/db/', `/${s.db}/`))
  if (r.status !== 200) {
    console.log(`  ! ${s.db} 视图查询失败：${r.status} ${JSON.stringify(r.json).slice(0, 120)}`)
    continue
  }
  const list = r.json.rows ?? []
  let attBytes = 0
  let withAtt = 0
  for (const row of list) {
    const atts = row.doc?._attachments ?? {}
    const n = Object.values(atts).reduce((a, x) => a + (x.length ?? 0), 0)
    if (n > 0) { withAtt++; attBytes += n }
  }
  rows.push({ db: s.db, group: s.group, total: s.docs, window: list.length, truncated: list.length === ROW_LIMIT, withAtt, attBytes })
}

const sum = (f) => rows.reduce((s, x) => s + f(x), 0)
const mean = (f) => (rows.length ? sum(f) / rows.length : 0)
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0 }

console.log('窗口内条数最多的源库（窗口内条数 / 窗口内附件体积）：')
for (const r of [...rows].sort((a, b) => b.window - a.window).slice(0, 15)) {
  console.log(`  ${r.db}  窗口内 ${String(r.window).padStart(5)} 条（${r.truncated ? '达到 limit，实际更多' : `全库 ${r.total} 条`}）  附件 ${mb(r.attBytes).padStart(7)}MB  含附件条目 ${r.withAtt}`)
}

for (const g of ['stride', 'top']) {
  const rs = rows.filter((x) => x.group === g)
  if (!rs.length) continue
  const tag = g === 'stride' ? '等距抽样（近似代表整体）' : '最大的 10 个源库'
  console.log(`\n[${tag}] n=${rs.length}`)
  console.log(`  窗口内条数：mean=${(rs.reduce((s, x) => s + x.window, 0) / rs.length).toFixed(1)}  median=${pct(rs.map((x) => x.window), 0.5)}  p90=${pct(rs.map((x) => x.window), 0.9)}  max=${Math.max(...rs.map((x) => x.window))}`)
  console.log(`  窗口内附件：mean=${mb(rs.reduce((s, x) => s + x.attBytes, 0) / rs.length)}MB  median=${mb(pct(rs.map((x) => x.attBytes), 0.5))}MB  p90=${mb(pct(rs.map((x) => x.attBytes), 0.9))}MB  max=${mb(Math.max(...rs.map((x) => x.attBytes)))}MB`)
}

// 只用"等距抽样"外推，避免被刻意选中的大库带偏
const rs = rows.filter((x) => x.group === 'stride')
const perFeedEntries = rs.reduce((s, x) => s + x.window, 0) / Math.max(1, rs.length)
const perFeedAtt = rs.reduce((s, x) => s + x.attBytes, 0) / Math.max(1, rs.length)
console.log('\n按等距抽样均值外推（偏保守，见下方重尾说明）：')
for (const feeds of [50, 200, 625]) {
  console.log(`  账号有 ${feeds} 个源：窗口内约 ${(perFeedEntries * feeds).toFixed(0)} 条 / 附件 ${mb(perFeedAtt * feeds)}MB`)
}
console.log('\n重尾提醒：分布极度偏斜（中位数远小于均值）。一个账号只要订阅了少数几个图片重的源，')
console.log('窗口内附件就会从几十 MB 跳到 GB 级（本样本里单源 30 天最高 385MB）。')
console.log(`\n注：`+"`_dbs_info`"+` 的 doc_count 是全量；窗口内条数与附件是实测。`)
