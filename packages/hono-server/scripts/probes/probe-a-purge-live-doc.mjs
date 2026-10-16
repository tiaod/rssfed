#!/usr/bin/env node
/**
 * 探针 A：CouchDB `_purge` 能不能直接清除**活文档**（不先删除）？
 *
 * 要回答的问题（决定 storage-refactor-plan.md §5.2 的实现写法）：
 *   ① 官方文档说 "Documents can be previously deleted, but it is not necessary.
 *      Revisions must be leaf revisions." —— 真的可以直接 purge 活文档吗？
 *   ② 带附件的活文档 purge 之后，附件字节真的回收了吗（要 compact 吗）？
 *   ③ 冲突分支：只 purge winner 会怎样？要把所有叶子一起 purge 才彻底吗？
 *   ④ 非叶子 rev / 重复 purge 会报错吗（决定"墓碑账本"能不能容错）？
 *   ⑤ purge 对 `_all_docs` / `_changes` / `update_seq` / `purge_seq` 的影响
 *      —— 其中 `_changes` 里会不会留下"取不到 rev"的行，是探针 B 的前提。
 *
 * 全程只创建/删除 `probe_a_*` 临时库，不触碰任何现有库。
 * 用法：node report/aggregation-purge/probe-a-purge-live-doc.mjs
 */
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

async function req(method, path, body, raw) {
  const res = await fetch(COUCH + path, {
    method,
    headers: {
      Authorization: AUTH,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const enc = encodeURIComponent
const db = (name) => `/${name}`

async function dbInfo(name) {
  const r = await req('GET', db(name))
  return r.json
}
async function leaves(name) {
  const r = await req('GET', `${db(name)}/_all_docs?conflicts=true&include_docs=true`)
  return r.json.rows ?? []
}
async function changes(name, since = 0) {
  const r = await req('GET', `${db(name)}/_changes?since=${since}&style=all_docs`)
  return r.json
}

const stamp = Date.now()
const DB = `probe_a_purge_${stamp}`

console.log(`\n=== 探针 A：_purge 活文档（临时库 ${DB}）===\n`)

await req('PUT', db(DB))

// ── 准备文档 ────────────────────────────────────────────────
await req('PUT', `${db(DB)}/${enc('live:plain')}`, { type: 'entry', publishedAt: '2026-01-01T00:00:00.000Z' })

const withAtt = await req('PUT', `${db(DB)}/${enc('live:withatt')}`, { type: 'entry', publishedAt: '2026-01-02T00:00:00.000Z' })
// 附件必须是二进制 body（用 fetch 直接发 Uint8Array）
const attach = await fetch(`${COUCH}${db(DB)}/${enc('live:withatt')}/a.bin?rev=${withAtt.json.rev}`, {
  method: 'PUT',
  headers: { Authorization: AUTH, 'Content-Type': 'application/octet-stream' },
  body: new Uint8Array(200 * 1024).fill(7),
})

const tomb = await req('PUT', `${db(DB)}/${enc('del:tomb')}`, { type: 'entry' })
await req('DELETE', `${db(DB)}/${enc('del:tomb')}?rev=${tomb.json.rev}`)

// 冲突：rev1 正常写，再用 new_edits:false 塞一条同深度的另一分支
const conf = await req('PUT', `${db(DB)}/${enc('conf:two')}`, { type: 'entry', publishedAt: '2026-01-03T00:00:00.000Z' })
await req('POST', `${db(DB)}/_bulk_docs`, {
  new_edits: false,
  docs: [{ _id: 'conf:two', _rev: '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'entry', publishedAt: '2026-01-03T00:00:00.000Z', branch: 'b' }],
})

// 非叶子 rev 的样本：同一文档改两次
const dup1 = await req('PUT', `${db(DB)}/${enc('dup:doc')}`, { type: 'entry', v: 1 })
const dup2 = await req('PUT', `${db(DB)}/${enc('dup:doc')}`, { _rev: dup1.json.rev, type: 'entry', v: 2 })

console.log(`① 准备完成：附件上传 ${attach.status}；文档树 =`)
for (const row of await leaves(DB)) console.log(`     ${row.id}  rev=${row.doc?._rev}  deleted=${!!row.value?.deleted}  conflicts=${(row.doc?._conflicts ?? []).join(',') || '-'}`)

const infoBefore = await dbInfo(DB)
console.log(`   库信息：doc_count=${infoBefore.doc_count} doc_del_count=${infoBefore.doc_del_count} update_seq=${infoBefore.update_seq} purge_seq=${infoBefore.purge_seq} file=${infoBefore.sizes?.file}`)

// ── ① 直接 purge 活文档 ─────────────────────────────────────
console.log('\n② 直接 purge 活文档 live:plain（不先删除）')
const plain = (await leaves(DB)).find((r) => r.id === 'live:plain')
const p1 = await req('POST', `${db(DB)}/_purge`, { 'live:plain': [plain.doc._rev] })
console.log(`   POST _purge → ${p1.status}  ${JSON.stringify(p1.json)}`)
check('purge 活文档被接受（201）', p1.status === 201, `status=${p1.status}`)
check('响应里列出了被 purge 的 rev', (p1.json?.purged?.['live:plain'] ?? []).length === 1)
const g1 = await req('GET', `${db(DB)}/${enc('live:plain')}`)
check('purge 后 GET 该文档 → 404', g1.status === 404, `status=${g1.status}`)
check('purge 后不在 _all_docs 里', !(await leaves(DB)).some((r) => r.id === 'live:plain'))

const infoAfter = await dbInfo(DB)
console.log(`   库信息：update_seq ${infoBefore.update_seq}→${infoAfter.update_seq}  purge_seq ${infoBefore.purge_seq}→${infoAfter.purge_seq}  doc_count ${infoBefore.doc_count}→${infoAfter.doc_count}`)

// ⑤ `_changes` 里有没有留下"取不到 rev"的行？
const ch = await changes(DB, 0)
const chRow = (ch.results ?? []).find((r) => r.id === 'live:plain')
console.log(`   _changes 里 live:plain 的行：${chRow ? JSON.stringify(chRow) : '（无）'}`)
check('purge 掉的活文档不在 _changes 里（复制器不会去取不存在的 rev）', !chRow)

// ── ④ 非叶子 rev / 重复 purge ───────────────────────────────
console.log('\n③ 用非叶子 rev 与重复 rev 调 purge（容错性）')
const dupNonLeaf = await req('POST', `${db(DB)}/_purge`, { 'dup:doc': [dup1.json.rev] })
console.log(`   非叶子 rev → ${dupNonLeaf.status} ${JSON.stringify(dupNonLeaf.json)}`)
check('非叶子 rev 不报错（被忽略）', dupNonLeaf.status === 201, `status=${dupNonLeaf.status}`)
check('该文档仍然存在（只 purge 了非叶子 rev）', (await req('GET', `${db(DB)}/${enc('dup:doc')}`)).status === 200)
const dupAgain = await req('POST', `${db(DB)}/_purge`, { 'live:plain': [plain.doc._rev] })
console.log(`   重复 purge 同一个 rev → ${dupAgain.status} ${JSON.stringify(dupAgain.json)}`)
check('重复 purge 不报错', dupAgain.status === 201 || dupAgain.status === 202, `status=${dupAgain.status}`)

// ── ③ 冲突分支 ──────────────────────────────────────────────
console.log('\n④ 冲突分支：只 purge winner 会怎样')
const confRow = (await leaves(DB)).find((r) => r.id === 'conf:two')
console.log(`   conflict 行：doc._rev=${confRow.doc._rev} _conflicts=${JSON.stringify(confRow.doc._conflicts)}`)
const pWinner = await req('POST', `${db(DB)}/_purge`, { 'conf:two': [confRow.doc._rev] })
console.log(`   只 purge winner(${confRow.doc._rev}) → ${JSON.stringify(pWinner.json.purged)}`)
const gConf = await req('GET', `${db(DB)}/${enc('conf:two')}`)
check('只 purge winner 后文档还在（loser 分支存活）', gConf.status === 200, `status=${gConf.status} rev=${gConf.json?._rev}`)
const remain = (await leaves(DB)).find((r) => r.id === 'conf:two')
const pLoser = await req('POST', `${db(DB)}/_purge`, { 'conf:two': [remain.doc._rev] })
console.log(`   再 purge 剩余叶子(${remain.doc._rev}) → ${JSON.stringify(pLoser.json.purged)}`)
check('所有叶子都 purge 后文档彻底消失', (await req('GET', `${db(DB)}/${enc('conf:two')}`)).status === 404)

// ── ④ 墓碑 ─────────────────────────────────────────────────
console.log('\n⑤ 已删除文档（墓碑）的 purge')
// ⚠️ 墓碑不出现在 `_all_docs` 里，只能从 `_changes` 取 rev（这也是 probe-3 的结论）
const tombRev = ((await changes(DB, 0)).results ?? []).find((r) => r.id === 'del:tomb')?.changes?.[0]?.rev
console.log(`   从 _changes 取到墓碑 rev = ${tombRev}`)
const pTomb = await req('POST', `${db(DB)}/_purge`, { 'del:tomb': [tombRev ?? '2-missing'] })
console.log(`   purge 墓碑 → ${JSON.stringify(pTomb.json)}`)
check('墓碑可被 purge', (pTomb.json?.purged?.['del:tomb'] ?? []).length === 1)
check('purge 后墓碑不在 _changes 里', !((await changes(DB, 0)).results ?? []).some((r) => r.id === 'del:tomb'))

// ── ② 附件回收 ──────────────────────────────────────────────
console.log('\n⑥ 带附件的活文档 purge + compact 的空间回收')
const attBefore = await dbInfo(DB)
const attRow = (await leaves(DB)).find((r) => r.id === 'live:withatt')
const pAtt = await req('POST', `${db(DB)}/_purge`, { 'live:withatt': [attRow.doc._rev] })
check('带附件的活文档可被 purge', pAtt.status === 201, JSON.stringify(pAtt.json.purged))
const purgedInfos = await req('GET', `${db(DB)}/_purged_infos`)
console.log(`   _purged_infos = ${JSON.stringify(purgedInfos.json).slice(0, 400)}`)
const attPurged = await dbInfo(DB)
console.log(`   purge 后（未 compact）：external ${attBefore.sizes.external} → ${attPurged.sizes.external}  file ${attBefore.sizes.file} → ${attPurged.sizes.file}`)
await req('POST', `${db(DB)}/_compact`, {})
// 等 compaction 真的跑完：先等任务出现，再等它消失；全程记录 file 体积的最小值
let sawTask = false
let minFile = attBefore.sizes.file
let waited = 0
for (;;) {
  const tasks = await req('GET', '/_active_tasks')
  const running = (tasks.json ?? []).filter((t) => t.database === DB && t.type === 'database_compaction')
  const info = await dbInfo(DB)
  minFile = Math.min(minFile, info.sizes.file)
  if (running.length > 0) sawTask = true
  if (sawTask && running.length === 0) break
  if (waited > 60000) { console.log('   ⚠️ compaction 60s 未收敛，按当前值记录'); break }
  await new Promise((r) => setTimeout(r, 300)); waited += 300
}
const attAfter = await dbInfo(DB)
console.log(`   compaction ${sawTask ? '观察到任务' : '未观察到任务'}，等了 ${waited}ms：external ${attAfter.sizes.external}  file ${attBefore.sizes.file} → ${attAfter.sizes.file}（最小 ${minFile}）  active ${attAfter.sizes.active}`)
check('附件字节在 purge 后即从 external 统计中消失', attAfter.sizes.external < attBefore.sizes.external / 2, `${attBefore.sizes.external} → ${attAfter.sizes.external}`)
check('compact 后文件不大于 compact 前', minFile <= attBefore.sizes.file, `${attBefore.sizes.file} → 最小 ${minFile}`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await req('DELETE', db(DB))
console.log(`(临时库 ${DB} 已删除)`)
process.exit(fail === 0 ? 0 : 1)
