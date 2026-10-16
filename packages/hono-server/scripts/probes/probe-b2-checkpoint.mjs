#!/usr/bin/env node
/**
 * 探针 B2（聚焦）：源库 purge 会不会让复制的 checkpoint 失效、从而每轮从 0 重扫源库？
 *
 * 背景：按需复制 + 每天 purge 的组合里，如果 purge 让 checkpoint 失效，就会退化成
 * "每轮对每个 (用户×源) 全量重扫源库" —— 那正是这次重构想消掉的东西。
 *
 * ⚠️ 方法说明：`_replicate` 响应里的 `history[0].docs_read` **不能**用来判断是否重扫
 * （实测：无改动时也会报 200；删掉两端 checkpoint 后反而报 0）。这里改用仓库
 * probe-2 用过的判别法 —— **在目标端 purge 掉一条文档，看它会不会被重新搬回来**：
 *   会回来 ⇒ 这一轮确实从 0 重扫了；不回来 ⇒ checkpoint 被复用、只读了增量。
 *
 * 步骤：
 *   A 基线：目标端 purge 一条 → 复制 → 期望**不回来**（证明判别法与 checkpoint 都正常）
 *   B 源端 purge 一批（都在 checkpoint 之下）→ 目标端再 purge 另一条 → 复制
 *     → 关键问题：目标端那条会不会回来（= 源端 purge 是否打断了 checkpoint）
 *   C 阴性对照：正确删掉两端 `_local` → 目标端 purge 一条 → 复制 → 期望**回来**
 *     （证明判别法确实能测出"重扫"，否则 A/B 的结论不成立）
 *   D 全量重扫时，被源端 purge 的文档不该回来
 *
 * 用法：node report/aggregation-purge/probe-b2-checkpoint.mjs
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
const SRC = `probe_b2_src_${S}`
const TGT = `probe_b2_tgt_${S}`
const id = (i) => `entry:${String(i).padStart(3, '0')}`

const replicate = async () => {
  const t = Date.now()
  const r = await req('POST', '/_replicate', { source: credUrl(SRC), target: credUrl(TGT), selector: { type: 'entry' }, continuous: false, create_target: true })
  const h = r.json?.history?.[0] ?? {}
  return { status: r.status, ok: r.json?.ok, error: r.json?.error, reason: r.json?.reason, docsRead: h.docs_read, docsWritten: h.docs_written, ms: Date.now() - t }
}
/** 直接从库内容判断（不看复制的自报计数） */
const exists = async (db, docId) => (await req('GET', `/${db}/${encodeURIComponent(docId)}`)).status === 200
const liveIds = async (db) => ((await req('GET', `/${db}/_all_docs`)).json.rows ?? []).map((x) => x.id)
/** 直接 purge 活文档（探针 A 已证明可行） */
const purgeLive = async (db, ids) => {
  const rows = (await req('POST', `/${db}/_all_docs?include_docs=true`, { keys: ids })).json.rows ?? []
  const body = {}
  for (const row of rows) if (row.doc?._rev) body[row.id] = [row.doc._rev]
  if (!Object.keys(body).length) return 0
  const r = await req('POST', `/${db}/_purge`, body)
  return Object.keys(r.json?.purged ?? {}).length
}
const dumpCheckpoint = async (db) => {
  for (const row of (await req('GET', `/${db}/_local_docs`)).json?.rows ?? []) {
    const short = row.id.replace(/^_local\//, '')
    const r = await req('GET', `/${db}/_local/${short}`)
    const hist = r.json?.history ?? []
    console.log(`   ${db} ${row.id}：recorded_seq=${String(hist[0]?.recorded_seq ?? '-').slice(0, 16)}… 上次 docs_read=${hist[0]?.docs_read ?? '-'} history=${hist.length}`)
  }
}
const deleteCheckpoints = async (db) => {
  for (const row of (await req('GET', `/${db}/_local_docs`)).json?.rows ?? []) {
    const short = row.id.replace(/^_local\//, '')
    const cur = await req('GET', `/${db}/_local/${short}`)
    const del = await req('DELETE', `/${db}/_local/${short}?rev=${encodeURIComponent(cur.json?._rev ?? '')}`)
    console.log(`   删除 ${db} ${row.id} → ${del.status}`)
  }
}

let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); ok ? pass++ : fail++ }

console.log(`\n=== 探针 B2：源端 purge 是否打断复制 checkpoint（${SRC} → ${TGT}）===\n`)
await req('PUT', `/${SRC}`)
await req('PUT', `/${TGT}`)
await req('POST', `/${SRC}/_bulk_docs`, { docs: Array.from({ length: 200 }, (_, i) => ({ _id: id(i), type: 'entry', publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() })) })

console.log('① 首次复制建立 checkpoint')
const r1 = await replicate()
console.log(`   ok=${r1.ok} docs_read=${r1.docsRead} ${r1.ms}ms`)
await dumpCheckpoint(TGT)
check('首次复制把 200 条搬到目标端', (await liveIds(TGT)).length === 200)

console.log('\n② A 基线：目标端 purge 一条（源端仍有）→ 复制 → 期望**不回来**（= 判别法本身有效且 checkpoint 被复用）')
await purgeLive(TGT, [id(150)])
console.log(`   目标端 purge entry:150 后：${await exists(TGT, id(150)) ? '仍在（异常）' : '已消失'}`)
const rA = await replicate()
const backA = await exists(TGT, id(150))
console.log(`   复制后 entry:150 ${backA ? '回来了' : '仍未回来'}（docs_read=${rA.docsRead} ${rA.ms}ms）`)
check('基线：目标端 purge 的文档没有被搬回来（checkpoint 被复用）', !backA)
await dumpCheckpoint(TGT)

console.log('\n③ B 关键问题：源端 purge 10 条（都在 checkpoint 之下）→ 目标端再 purge entry:160 → 复制')
const srcBefore = (await req('GET', `/${SRC}`)).json
const nPurged = await purgeLive(SRC, Array.from({ length: 10 }, (_, i) => id(i)))
const srcAfter = (await req('GET', `/${SRC}`)).json
console.log(`   源端 purge ${nPurged} 条；update_seq ${String(srcBefore.update_seq).slice(0, 10)}… → ${String(srcAfter.update_seq).slice(0, 10)}…；purge_seq ${String(srcBefore.purge_seq).slice(0, 10)}… → ${String(srcAfter.purge_seq).slice(0, 10)}…`)
await purgeLive(TGT, [id(160)])
const rB = await replicate()
const backB = await exists(TGT, id(160))
console.log(`   复制后 entry:160 ${backB ? '回来了 ⇒ 这一轮从 0 重扫了' : '仍未回来 ⇒ checkpoint 仍然有效'}（docs_read=${rB.docsRead} ${rB.ms}ms）`)
check('源端 purge 之后，目标端 purge 的文档仍未被搬回（checkpoint 未失效）', !backB)
await dumpCheckpoint(TGT)

console.log('\n④ C 阴性对照：删掉两端 checkpoint → 目标端 purge entry:170 → 复制 → 期望**回来**（证明判别法能测出重扫）')
await deleteCheckpoints(TGT)
await deleteCheckpoints(SRC)
await purgeLive(TGT, [id(170)])
const rC = await replicate()
const backC = await exists(TGT, id(170))
console.log(`   复制后 entry:170 ${backC ? '回来了 ⇒ 判别法有效（确实测到了重扫）' : '仍未回来 ⇒ 判别法失效，前面 A/B 的结论不成立'}（docs_read=${rC.docsRead} ${rC.ms}ms）`)
check('阴性对照：删掉 checkpoint 后目标端 purge 的文档被搬回（判别法有效）', backC)

console.log('\n⑤ D 目标端也 purge 掉那 10 条（源端已 purge）→ 再强制重扫 → 它们不该回来')
// 注意：目标端在第一轮复制时就已经有这 10 条了，"重扫"只会新增不会删除，
// 所以必须先把目标端那 10 条也清掉，才能测出"源端已 purge 的东西不会被重扫带回来"。
const nTgtPurged = await purgeLive(TGT, Array.from({ length: 10 }, (_, i) => id(i)))
await deleteCheckpoints(TGT)
await deleteCheckpoints(SRC)
const rD = await replicate()
const live = await liveIds(TGT)
const resurrected = Array.from({ length: 10 }, (_, i) => id(i)).filter((x) => live.includes(x))
console.log(`   目标端先 purge ${nTgtPurged} 条，强制重扫后（docs_read=${rD.docsRead}）：目标端活文档 ${live.length} 条；被源端 purge 的 10 条里回来的 = ${resurrected.length} 条`)
check('源端已 purge 的文档不会因为全量重扫而复活', resurrected.length === 0, resurrected.join(','))
check('重扫后目标端仍有其他条目（重扫确实干活了）', live.length >= 180, `${live.length} 条`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await req('DELETE', `/${SRC}`)
await req('DELETE', `/${TGT}`)
console.log('(临时库已删除)')
process.exit(fail === 0 ? 0 : 1)
