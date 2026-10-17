#!/usr/bin/env node
/**
 * 探针 F：验证 `source-side-retention-plan.md` 的机制基石 ——
 * **"复制只带 filter（不带 selector、不带 query_params）时，删除会自然跟着复制传播"**。
 *
 * 这是那份方案能不能成立的关键。已知（`couchdb-replicator-aggregation.md` 结论 1）：
 * **Mango `selector` 会漏掉删除**（`deleted:true` 的变更没有可匹配字段）。但方案用的是
 * **JS filter function**，而且新 filter 只挡设计文档：
 *
 *     function(doc) { return doc._id.indexOf('_design/') !== 0; }
 *
 * 墓碑（`{_id, _rev, _deleted:true}`）的 `_id` 不以 `_design/` 开头 → 应该返回 true。
 * 本探针同时验证三件事：
 *   ① filter 挡掉了源库的 `_design/main`（否则会和用户库自己的设计文档撞车）
 *   ② 源库**删除**的条目，会以 `_deleted` 变更复制到目标端（目标端跟着消失）
 *   ③ 按"最新 N 条"裁剪（= 方案里的裁剪动作）之后，目标端精确收敛成 N 条
 *
 * 用法：node packages/hono-server/scripts/probes/probe-f-filter-carries-deletions.mjs
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
const SRC = `probe_f_src_${S}`
const TGT = `probe_f_tgt_${S}`
const N = 50
let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); ok ? pass++ : fail++ }

/** 方案 §4.3 里的新 filter：只挡设计文档，墓碑自然放行 */
const FILTER = `function(doc) {
  // 源库的设计文档不能搬进用户库：用户库自己也有 _design/main
  return doc._id.indexOf('_design/') !== 0;
}`

const replicate = async () => {
  const t = Date.now()
  const r = await req('POST', '/_replicate', {
    source: credUrl(SRC),
    target: credUrl(TGT),
    filter: 'main/onlyUserDocs',
    continuous: false,
    create_target: true,
  })
  return { status: r.status, ok: r.json?.ok, error: r.json?.error, reason: r.json?.reason, docsWritten: r.json?.history?.[0]?.docs_written, ms: Date.now() - t }
}
const liveIds = async (db) => ((await req('GET', `/${db}/_all_docs`)).json.rows ?? []).map((x) => x.id)
const deletedIds = async (db) => {
  const rows = ((await req('GET', `/${db}/_changes?since=0&style=all_docs`)).json.results ?? [])
  return rows.filter((r) => r.deleted || r.changes?.some((c) => c.rev?.startsWith('2-')))
}
const id = (i) => `entry:${String(i).padStart(3, '0')}`
const iso = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()

console.log(`\n=== 探针 F：filter 复制是否携带删除（${SRC} → ${TGT}）===\n`)
await req('PUT', `/${SRC}`)
// 源库：设计文档（要被挡住）+ feed 文档 + 100 条 entry
await req('PUT', `/${SRC}/_design/main`, { views: { 'entries-by-date': { map: "function(doc){ if(doc.type==='entry') emit(doc.publishedAt, null); }" } }, filters: { onlyUserDocs: FILTER } })
await req('PUT', `/${SRC}/feed:f1`, { type: 'feed', title: 'src' })
await req('POST', `/${SRC}/_bulk_docs`, { docs: Array.from({ length: 100 }, (_, i) => ({ _id: id(i), type: 'entry', publishedAt: iso(i) })) })

console.log('① 首次复制：只有 filter，没有 selector、没有 query_params')
const r1 = await replicate()
console.log(`   ok=${r1.ok} docs_written=${r1.docsWritten} ${r1.ms}ms`)
const tgtInit = await liveIds(TGT)
check('复制成功', r1.status === 200 && r1.ok === true, r1.reason ?? '')
check('源库的 _design/main 没有被搬进目标端', !tgtInit.some((x) => x.startsWith('_design/')))
check('feed 文档与 100 条 entry 都到了目标端', tgtInit.includes('feed:f1') && tgtInit.filter((x) => x.startsWith('entry:')).length === 100, `${tgtInit.length} 条`)

console.log('\n② 源库**删除** 30 条（模拟"裁剪"），同参数再复制 —— 关键：删除会不会传播')
const rows = (await req('POST', `/${SRC}/_all_docs?include_docs=true`, { keys: Array.from({ length: 30 }, (_, i) => id(i)) })).json.rows
await req('POST', `/${SRC}/_bulk_docs`, { docs: rows.filter((r) => r.doc).map((r) => ({ _id: r.id, _rev: r.doc._rev, _deleted: true })) })
const r2 = await replicate()
const tgtAfter = await liveIds(TGT)
const stillThere = Array.from({ length: 30 }, (_, i) => id(i)).filter((x) => tgtAfter.includes(x))
console.log(`   ok=${r2.ok} docs_written=${r2.docsWritten} ${r2.ms}ms｜目标端活文档 ${tgtAfter.length} 条`)
check('**删除传播到了目标端**（那 30 条在目标端也没了）', stillThere.length === 0, stillThere.length ? `还在：${stillThere.slice(0, 3).join(',')}` : '')
check('目标端剩下 70 条 entry + 1 条 feed', tgtAfter.filter((x) => x.startsWith('entry:')).length === 70)

console.log('\n③ 目标端拿到的是墓碑（不是"没收到"）：该 id 在目标端 _changes 里是 deleted')
const tgtDeleted = await deletedIds(TGT)
const tombIds = Array.from({ length: 30 }, (_, i) => id(i))
const seenTomb = tombIds.filter((x) => tgtDeleted.some((r) => r.id === x && r.deleted))
console.log(`   目标端墓碑可见 ${seenTomb.length}/30 条`)
check('目标端确实收到了墓碑（所以后续重扫也不会复活）', seenTomb.length === 30)

console.log('\n④ 按方案"保留最新 N 条"裁剪源库，再复制 → 目标端应精确收敛成 N 条')
// 源库现在 70 条 entry（id 30..99）。按 publishedAt 倒序保留最新 N 条 = 删掉最老的 20 条
const viewRows = (await req('GET', `/${SRC}/_design/main/_view/entries-by-date?descending=false&limit=71`)).json.rows ?? []
const toDelete = viewRows.slice(0, Math.max(0, viewRows.length - N)).map((r) => r.id)
const rows2 = (await req('POST', `/${SRC}/_all_docs?include_docs=true`, { keys: toDelete })).json.rows
await req('POST', `/${SRC}/_bulk_docs`, { docs: rows2.filter((r) => r.doc).map((r) => ({ _id: r.id, _rev: r.doc._rev, _deleted: true })) })
await replicate()
const tgtFinal = (await liveIds(TGT)).filter((x) => x.startsWith('entry:'))
console.log(`   源库删了 ${toDelete.length} 条最老的；复制后目标端 entry ${tgtFinal.length} 条`)
check(`目标端精确收敛成 ${N} 条（源库裁剪的唯一权威）`, tgtFinal.length === N, `${tgtFinal.length} 条`)
check('留下的都是最新的 N 条', tgtFinal.every((x) => Number(x.slice(6)) >= 50))

console.log('\n⑤ checkpoint 稳定性：全程没有 query_params，复制 id 不变（看目标端 _local 是否始终同一个）')
const cps = ((await req('GET', `/${TGT}/_local_docs`)).json?.rows ?? []).map((x) => x.id)
console.log(`   目标端 _local 文档：${JSON.stringify(cps)}`)
check('只有一个固定的 checkpoint（没随裁剪/删除变化）', cps.length === 1)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await req('DELETE', `/${SRC}`)
await req('DELETE', `/${TGT}`)
console.log('(临时库已删除)')
process.exit(fail === 0 ? 0 : 1)
