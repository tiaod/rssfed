#!/usr/bin/env node
/**
 * 探针 B：`_purge` 与**按需复制**并发时会发生什么？
 *
 * 这是 storage-refactor-plan.md §12 的第 2、3 个待验证项，直接决定"源库每天 purge"能不能和
 * "按需复制"并存。要回答：
 *   ① 源库 purge 之后，目标端的 `_local/<哈希>` checkpoint 还有效吗？下一轮是从上次序号续读，
 *      还是报错/重扫？
 *   ② purge 掉的文档，目标端已经有的那份还在吗（"各端各清各的"是否成立）？
 *   ③ 强制重扫（删 checkpoint）时，被 purge 的文档会不会被搬回来（应该不会 —— 源端已经没有它）？
 *   ④ 全新目标端首次复制时，被 purge 的文档会不会出现（应该不会）？
 *   ⑤ checkpoint **之后**（尚未复制）的文档被 purge 掉，复制会不会报错？
 *      这是最危险的时序：`_changes` 里那一行在复制器读之前就消失了。
 *   ⑥ **真正的并发**：复制正在跑的时候 purge 一批文档，复制会不会 500 / `error`？
 *
 * 全程只用 `probe_b_*` 临时库；跑完删除。
 * 用法：node report/aggregation-purge/probe-b-purge-vs-replication.mjs
 */
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const url = (dbName) => `${COUCH}/${dbName}`
const credUrl = (dbName) => `http://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@${COUCH.replace(/^https?:\/\//, '')}/${dbName}`

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

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
const enc = encodeURIComponent

async function replicate(src, tgt) {
  const started = Date.now()
  const r = await req('POST', '/_replicate', {
    source: credUrl(src),
    target: credUrl(tgt),
    selector: { type: 'entry' },
    continuous: false,
    create_target: true,
  })
  const h = r.json?.history?.[0] ?? {}
  return { status: r.status, ok: r.json?.ok, error: r.json?.error, reason: r.json?.reason, docsWritten: h.docs_written, docsRead: h.docs_read, ms: Date.now() - started, sourceLastSeq: r.json?.source_last_seq }
}

/** 目标端现存（未删除）文档 id 集合 */
async function liveIds(dbName) {
  const r = await req('GET', `/${dbName}/_all_docs`)
  return (r.json.rows ?? []).map((x) => x.id)
}
/** 目标端全部（含墓碑）id 集合：墓碑只在 _changes 里 */
async function allIds(dbName) {
  const r = await req('GET', `/${dbName}/_changes?since=0&style=all_docs`)
  return (r.json.results ?? []).map((x) => x.id)
}
async function localDocs(dbName) {
  const r = await req('GET', `/${dbName}/_local_docs`)
  return (r.json.rows ?? []).map((x) => x.id)
}
/** 直接 purge 活文档（探针 A 已证明可行）：一次 _all_docs keys 查询拿全部 rev */
async function purgeLive(dbName, ids) {
  const r = await req('POST', `/${dbName}/_all_docs?include_docs=true`, { keys: ids })
  const body = {}
  for (const row of r.json?.rows ?? []) if (row.doc?._rev) body[row.id] = [row.doc._rev]
  if (Object.keys(body).length === 0) return { purged: {} }
  const p = await req('POST', `/${dbName}/_purge`, body)
  return p.json
}
const iso = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()

const S = Date.now()
const SRC = `probe_b_src_${S}`
const TGT = `probe_b_tgt_${S}`
const TGT2 = `probe_b_fresh_${S}`
const SRC2 = `probe_b_race_${S}`
const TGT3 = `probe_b_racetgt_${S}`

console.log(`\n=== 探针 B：_purge × 按需复制（临时库 ${SRC} → ${TGT}）===\n`)
await req('PUT', `/${SRC}`)
await req('PUT', `/${TGT}`)

// ── 准备：300 条 entry + 1 条 feed（验证 selector 真的过滤）────────
const docs = []
for (let i = 0; i < 300; i++) docs.push({ _id: `entry:${String(i).padStart(3, '0')}`, type: 'entry', publishedAt: iso(i), title: `t${i}` })
docs.push({ _id: 'feed:f1', type: 'feed', title: 'source' })
await req('POST', `/${SRC}/_bulk_docs`, { docs })

console.log('① 首次复制（建立 checkpoint）')
const r1 = await replicate(SRC, TGT)
console.log(`   ok=${r1.ok} docs_written=${r1.docsWritten} docs_read=${r1.docsRead} ${r1.ms}ms  source_last_seq=${String(r1.sourceLastSeq).slice(0, 24)}…`)
check('首次复制成功', r1.status === 200 && r1.ok === true, r1.reason ?? '')
check('selector 只搬 entry（feed:f1 未进目标端）', !(await allIds(TGT)).includes('feed:f1'))
const cps1 = await localDocs(TGT)
console.log(`   目标端 _local 文档 = ${JSON.stringify(cps1)}`)
check('目标端写下了复制 checkpoint（_local/<哈希>）', cps1.length === 1)

// ── ② 源库 purge 掉已复制过的文档（checkpoint 之下）────────────
console.log('\n② 源库 purge 掉 10 条（已在 checkpoint 之下），再加 5 条新的；同参数再复制一次')
await req('POST', `/${SRC}/_bulk_docs`, { docs: Array.from({ length: 5 }, (_, i) => ({ _id: `entry:new:${i}`, type: 'entry', publishedAt: iso(1000 + i) })) })
const purged = await purgeLive(SRC, Array.from({ length: 10 }, (_, i) => `entry:${String(i).padStart(3, '0')}`))
console.log(`   purge 结果条数 = ${Object.keys(purged.purged ?? {}).length}`)
check('源库 purge 掉 10 条活文档', Object.keys(purged.purged ?? {}).length === 10)

const r2 = await replicate(SRC, TGT)
console.log(`   第二次复制：ok=${r2.ok} error=${r2.error ?? '-'} docs_written=${r2.docsWritten} docs_read=${r2.docsRead} ${r2.ms}ms`)
check('purge 之后同参数复制仍然成功、不报错', r2.status === 200 && r2.ok === true, r2.reason ?? r2.error ?? '')
const tgtLive = await liveIds(TGT)
check('目标端**保留**已被源库 purge 的文档（各端各清各的）', Array.from({ length: 10 }, (_, i) => `entry:${String(i).padStart(3, '0')}`).every((id) => tgtLive.includes(id)), `目标端 ${tgtLive.length} 条`)
check('新条目到达目标端', Array.from({ length: 5 }, (_, i) => `entry:new:${i}`).every((id) => tgtLive.includes(id)))
// ⚠️ `history[0].docs_read` 不能用来判断是否重扫（实测无改动也报 300+，删 checkpoint 后反报 0）。
// 用仓库 probe-2 的判别法：目标端 purge 一条（源端仍有）→ 复制 → 不回来 = checkpoint 被复用。
await purgeLive(TGT, ['entry:100'])
await replicate(SRC, TGT)
check('checkpoint 仍被复用（目标端 purge 的 entry:100 没有被搬回来）', !(await allIds(TGT)).includes('entry:100'), `docs_read=${r2.docsRead}（该计数不可靠，仅记录）`)

// ⑤ checkpoint 之后（未复制）的文档被 purge
console.log('\n③ 危险时序：源库写入一条新文档后**立刻 purge**（在 checkpoint 之后、复制之前）')
await req('PUT', `/${SRC}/${enc('entry:late')}`, { type: 'entry', publishedAt: iso(5000) })
const infoMid = (await req('GET', `/${SRC}`)).json
await purgeLive(SRC, ['entry:late'])
const r3 = await replicate(SRC, TGT)
console.log(`   复制：ok=${r3.ok} error=${r3.error ?? '-'} docs_written=${r3.docsWritten} ${r3.ms}ms`)
check('purge 掉尚未复制的文档后，复制仍成功（不报错）', r3.status === 200 && r3.ok === true, r3.reason ?? r3.error ?? '')
check('该文档没有出现在目标端', !(await allIds(TGT)).includes('entry:late'))
const changesAfter = await req('GET', `/${SRC}/_changes?since=${encodeURIComponent(String(infoMid.update_seq).replace(/^/, ''))}&limit=5`)
check('源库 purge 后 update_seq 增长的区间仍可被 since 安全查询（不 400/500）', changesAfter.status === 200, `status=${changesAfter.status}`)

// ── ③ 强制重扫 ─────────────────────────────────────────────
console.log('\n④ 强制重扫（两端删掉 checkpoint）后：被 purge 的文档不该回来，但没 purge 的应该回来')
// 判别法：目标端 purge 两批 —— 一批源端已 purge（不该回来）、一批源端仍在（该回来，做阳性对照）
const goneIds = Array.from({ length: 10 }, (_, i) => `entry:${String(i).padStart(3, '0')}`) // 源端已 purge
await purgeLive(TGT, goneIds)
await purgeLive(TGT, ['entry:290', 'entry:291']) // 源端仍在 → 重扫时应该被搬回来
for (const d of [TGT, SRC]) {
  for (const cp of await localDocs(d)) {
    const short = cp.replace(/^_local\//, '')
    const cur = await req('GET', `/${d}/_local/${short}`)
    const del = await req('DELETE', `/${d}/_local/${short}?rev=${encodeURIComponent(cur.json?._rev ?? '')}`)
    console.log(`   删除 ${d} ${cp} → ${del.status}${del.status >= 400 ? ` ${JSON.stringify(del.json)}` : ''}`)
  }
}
const r4 = await replicate(SRC, TGT)
console.log(`   重扫复制：ok=${r4.ok} docs_read=${r4.docsRead} ${r4.ms}ms`)
check('删 checkpoint 后复制仍成功', r4.status === 200 && r4.ok === true, r4.reason ?? '')
const afterRescan = await allIds(TGT)
check('阴性对照：源端仍有的条目被重扫搬回来了（证明这一轮确实重扫了）', ['entry:290', 'entry:291'].every((id) => afterRescan.includes(id)))
check('重扫没有把源端已 purge 的文档带回来', !goneIds.some((id) => afterRescan.includes(id)))
check('重扫后仍包含被 purge 之前就在目标端的其他条目', afterRescan.includes('entry:299'))

// ── ④ 全新目标端 ───────────────────────────────────────────
console.log('\n⑤ 全新目标端首次复制：被 purge 的文档不应出现')
const r5 = await replicate(SRC, TGT2)
const fresh = await liveIds(TGT2)
console.log(`   ok=${r5.ok} docs_written=${r5.docsWritten} 目标端条数=${fresh.length}`)
check('全新目标端首拉成功', r5.status === 200 && r5.ok === true, r5.reason ?? '')
check('全新目标端里没有被 purge 的文档', !Array.from({ length: 10 }, (_, i) => `entry:${String(i).padStart(3, '0')}`).some((id) => fresh.includes(id)))
check('全新目标端里没有 entry:late', !fresh.includes('entry:late'))

// ── ⑥ 真并发：复制进行中 purge ──────────────────────────────
console.log('\n⑥ 真并发：600 条 × 50KB 附件在复制途中 purge 一半')
await req('PUT', `/${SRC2}`)
await req('PUT', `/${TGT3}`)
const bulk = []
for (let i = 0; i < 600; i++) {
  bulk.push({
    _id: `entry:r${String(i).padStart(3, '0')}`,
    type: 'entry',
    publishedAt: iso(i),
    _attachments: { 'a.bin': { content_type: 'application/octet-stream', data: Buffer.alloc(50 * 1024, i % 251).toString('base64') } },
  })
}
for (let i = 0; i < bulk.length; i += 100) await req('POST', `/${SRC2}/_bulk_docs`, { docs: bulk.slice(i, i + 100) })
console.log('   源库准备完成，开始复制并在途中 purge')
const racePromise = replicate(SRC2, TGT3)
await new Promise((r) => setTimeout(r, 250))
const racePurged = await purgeLive(SRC2, Array.from({ length: 300 }, (_, i) => `entry:r${String(i).padStart(3, '0')}`))
const r6 = await racePromise
console.log(`   复制：status=${r6.status} ok=${r6.ok} error=${r6.error ?? '-'} reason=${r6.reason ?? '-'} docs_written=${r6.docsWritten} ${r6.ms}ms`)
console.log(`   并发 purge 了 ${Object.keys(racePurged.purged ?? {}).length} 条`)
check('复制与 purge 并发时复制没有 5xx / error', r6.status === 200 && r6.ok === true, `${r6.status} ${r6.reason ?? r6.error ?? ''}`)
// 收敛：再复制一次 + 强制重扫，目标端应与源端"活文档集合"一致（被 purge 的除外或存在——各清各的）
const r7 = await replicate(SRC2, TGT3)
check('并发之后再次复制仍成功（可恢复）', r7.status === 200 && r7.ok === true, r7.reason ?? '')
const src2Live = new Set(await liveIds(SRC2))
const tgt3Live = await liveIds(TGT3)
const ghost = tgt3Live.filter((id) => !src2Live.has(id))
const missing = [...src2Live].filter((id) => !tgt3Live.includes(id))
console.log(`   收敛检查：源端活文档 ${src2Live.size} 条｜目标端 ${tgt3Live.length} 条｜目标端多出（源端已 purge）${ghost.length} 条｜目标端缺 ${missing.length} 条`)
check('目标端没有缺失（除了被 purge 的）', missing.length === 0, `缺 ${missing.length} 条`)
check('目标端多出的都是源端被 purge 的文档', ghost.every((id) => id.startsWith('entry:r')) && ghost.length <= 300, `多出 ${ghost.length} 条`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
for (const d of [SRC, TGT, TGT2, SRC2, TGT3]) await req('DELETE', `/${d}`)
console.log(`(临时库已删除：${[SRC, TGT, TGT2, SRC2, TGT3].join(', ')})`)
process.exit(fail === 0 ? 0 : 1)
