#!/usr/bin/env node
/**
 * 探针 E：在**目标端**（汇聚库）purge 活文档，会不会让"源库 → 目标端"的复制复活这些文档？
 *
 * 这是用户提的问题：源库永久保留（不清），汇聚库按窗口 purge 掉旧文档，
 * 那下一次同步会不会把它们从源库重新搬回来？
 *
 * 三种可能，结论差别很大：
 *   a. 不会复活 —— 增量复制只读 checkpoint 之后的变更，被 purge 的旧序号不会被重读。
 *      → "直接 purge" 可行（重扫/重建时才会临时复活）。
 *   b. 每次 purge 后复活 —— 如果复制器因为目标端 `purge_seq` 变化而丢掉 checkpoint，
 *      就会退化成"purge 一次 → 全量重扫 → 复活 → 再 purge"的循环。
 *      → "直接 purge" 不可行。
 *   c. 只有重扫时复活 —— 日常增量不复活；删掉 (`_local`) checkpoint 做全量重扫时复活
 *      （因为 purge 抹掉了修订记忆，目标端 `_revs_diff` 会认为这些 rev 它没有）。
 *      → 需要评估重扫的频率与代价。
 *
 * 判别法与 probe-b2 一致：不看 `docs_read`（它不可靠），直接看文档在不在。
 *
 * 用法：node packages/hono-server/scripts/probes/probe-e-target-purge-resurrection.mjs
 */
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const credUrl = (d) => `http://${USER}:${PASS}@${COUCH.replace(/^https?:\/\//, '')}/${d}`

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

const S = Date.now()
const SRC = `probe_e_src_${S}`
const TGT = `probe_e_tgt_${S}`
const ATT_BYTES = 5 * 1024
const TOTAL = 300
const id = (i) => `entry:${String(i).padStart(3, '0')}`
let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); ok ? pass++ : fail++ }

const replicate = async () => {
  const t = Date.now()
  const r = await req('POST', '/_replicate', { source: credUrl(SRC), target: credUrl(TGT), selector: { type: 'entry' }, continuous: false, create_target: true })
  const h = r.json?.history?.[0] ?? {}
  const tgt = (await req('GET', `/${TGT}`)).json
  return { status: r.status, ok: r.json?.ok, error: r.json?.error, docsWritten: h.docs_written, ms: Date.now() - t, tgtPurgeSeq: tgt?.purge_seq, tgtUpdateSeq: tgt?.update_seq }
}
const exists = async (docId) => (await req('GET', `/${TGT}/${encodeURIComponent(docId)}`)).status === 200
const liveIds = async (db) => ((await req('GET', `/${db}/_all_docs`)).json.rows ?? []).map((x) => x.id)
const purgeLive = async (db, ids) => {
  const rows = (await req('POST', `/${db}/_all_docs?include_docs=true`, { keys: ids })).json.rows ?? []
  const body = {}
  for (const row of rows) if (row.doc?._rev) body[row.id] = [row.doc._rev]
  if (!Object.keys(body).length) return 0
  const r = await req('POST', `/${db}/_purge`, body)
  return Object.keys(r.json?.purged ?? {}).length
}
const checkpointIds = async (db) => ((await req('GET', `/${db}/_local_docs`)).json?.rows ?? []).map((x) => x.id)
const deleteCheckpoints = async (db) => {
  for (const id of await checkpointIds(db)) {
    const short = id.replace(/^_local\//, '')
    const cur = await req('GET', `/${db}/_local/${short}`)
    await req('DELETE', `/${db}/_local/${short}?rev=${encodeURIComponent(cur.json?._rev ?? '')}`)
  }
}

console.log(`\n=== 探针 E：目标端 purge 后会不会被源库重新搬回来（${SRC} → ${TGT}）===\n`)
await req('PUT', `/${SRC}`)
const docs = Array.from({ length: TOTAL }, (_, i) => ({
  _id: id(i), type: 'entry', publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  _attachments: { 'a.bin': { content_type: 'application/octet-stream', data: Buffer.alloc(ATT_BYTES, i % 251).toString('base64') } },
}))
for (let i = 0; i < docs.length; i += 100) await req('POST', `/${SRC}/_bulk_docs`, { docs: docs.slice(i, i + 100) })

console.log(`① 首次复制（${TOTAL} 条 × ${ATT_BYTES / 1024}KB 附件，模拟"源库完整、汇聚库只有窗口内"）`)
const r1 = await replicate()
console.log(`   ok=${r1.ok} docs_written=${r1.docsWritten} ${r1.ms}ms｜目标端 purge_seq=${r1.tgtPurgeSeq} update_seq=${String(r1.tgtUpdateSeq).slice(0, 8)}…`)
check('首次复制把 300 条搬到目标端', (await liveIds(TGT)).length === TOTAL)

console.log('\n② 目标端 purge 掉 100 条（模拟"汇聚库按 14 天清掉过期内容"，源库照旧保留）')
const purgedIds = Array.from({ length: 100 }, (_, i) => id(i))
const nPurged = await purgeLive(TGT, purgedIds)
check('目标端 purge 了 100 条活文档', nPurged === 100, `实际 ${nPurged}`)
const afterPurge = await liveIds(TGT)
check('purge 后目标端只剩 200 条', afterPurge.length === 200, `${afterPurge.length} 条`)

console.log('\n③ **关键**：同参数再复制一次（增量）—— 看那 100 条会不会被搬回来')
const r2 = await replicate()
const back = []
for (const docId of purgedIds.slice(0, 5)) if (await exists(docId)) back.push(docId)
const backAll = (await liveIds(TGT)).length
console.log(`   ok=${r2.ok} docs_written=${r2.docsWritten} ${r2.ms}ms｜目标端现在 ${backAll} 条｜purge_seq=${String(r2.tgtPurgeSeq).slice(0, 8)}…`)
console.log(`   抽查前 5 条被 purge 的：${back.length ? `回来了（${back.join(',')}）` : '都没回来'}`)
const resurrectIncremental = backAll > 200
check('日常增量复制**不会**复活被 purge 的文档', !resurrectIncremental, `目标端 ${backAll} 条（期望 200）`)

console.log('\n④ 那 checkpoint 还在吗？（目标端 purge 有没有让复制器丢掉它）')
const cps = await checkpointIds(TGT)
console.log(`   目标端 _local 文档：${JSON.stringify(cps)}`)
check('目标端 checkpoint 仍在（没有因为 purge 被清掉）', cps.length === 1)

console.log('\n⑤ 阴性对照：删掉两端 checkpoint 做**全量重扫**（= 重建/换库）')
await deleteCheckpoints(TGT)
await deleteCheckpoints(SRC)
const r3 = await replicate()
const liveAfterRescan = await liveIds(TGT)
const resurrectedOnRescan = purgedIds.filter((x) => liveAfterRescan.includes(x))
console.log(`   重扫：ok=${r3.ok} docs_written=${r3.docsWritten} ${r3.ms}ms｜目标端 ${liveAfterRescan.length} 条｜被 purge 的 100 条里复活 ${resurrectedOnRescan.length} 条`)
check('**全量重扫会复活被 purge 的文档**（源库是完整存档 + purge 抹掉了修订记忆）', resurrectedOnRescan.length === 100)
console.log(`   → 这次重扫多搬了 ${(resurrectedOnRescan.length * ATT_BYTES / 1024 / 1024).toFixed(2)}MB 附件（模拟重建代价）`)

console.log('\n⑥ 对照：如果汇聚库用 delete（留墓碑）而不是 purge，重扫会不会复活？')
const TGT2 = `probe_e_tomb_${S}`
await req('PUT', `/${TGT2}`)
await req('POST', '/_replicate', { source: credUrl(SRC), target: credUrl(TGT2), selector: { type: 'entry' }, continuous: false, create_target: true })
// 目标端 delete 前 100 条（留墓碑）
const rows = (await req('POST', `/${TGT2}/_all_docs?include_docs=true`, { keys: purgedIds })).json.rows ?? []
await req('POST', `/${TGT2}/_bulk_docs`, { docs: rows.filter((r) => r.doc).map((r) => ({ _id: r.id, _rev: r.doc._rev, _deleted: true })) })
console.log(`   第二目标端 delete 后活文档：${(await liveIds(TGT2)).length} 条（墓碑不在 _all_docs 里）`)
await deleteCheckpoints(TGT2)
await deleteCheckpoints(SRC)
const r4 = await req('POST', '/_replicate', { source: credUrl(SRC), target: credUrl(TGT2), selector: { type: 'entry' }, continuous: false })
const liveTomb = await liveIds(TGT2)
const backTomb = purgedIds.filter((x) => liveTomb.includes(x))
console.log(`   delete 方案重扫后：docs_written=${r4.json?.history?.[0]?.docs_written}｜活文档 ${liveTomb.length} 条｜被删的 100 条里复活 ${backTomb.length} 条`)
check('**留墓碑时重扫不会复活**（墓碑挡住重发 —— 与 probe-3 结论一致）', backTomb.length === 0)
await req('DELETE', `/${TGT2}`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await req('DELETE', `/${SRC}`)
await req('DELETE', `/${TGT}`)
console.log('(临时库已删除)')
process.exit(fail === 0 ? 0 : 1)
