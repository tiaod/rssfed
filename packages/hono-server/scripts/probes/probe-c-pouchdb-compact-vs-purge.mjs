#!/usr/bin/env node
/**
 * 探针 C：客户端本地库（PouchDB）`compact()` 与 `purge()` 的区别 —— 谁安全、谁引发复活。
 *
 * 方案（storage-refactor-plan.md §2.4 / §6）主张：客户端不 purge、不重置，只 `compact()`。
 * 依据是"compact 不抹修订记忆、purge 会"。这个探针把它量出来：
 *
 *   ① 首次复制：源库 40 条（每条 50KB 附件）→ 本地 PouchDB，记录本地体积
 *   ② 本地删掉 20 条（产生墓碑）→ 体积变化
 *   ③ `db.compact()` → 体积变化（附件与旧修订是否回收）
 *   ④ **擦掉 checkpoint 强制重扫**（不用"增量复制"，否则测不出修订记忆）
 *      → compact 之后被删的 20 条**不该**回来（证明 compact 安全）
 *   ⑤ 对一条墓碑做 `db.purge()` → 再擦 checkpoint 重扫 → 该条**应该**回来
 *      （证明 purge 会抹掉修订记忆、导致重扫复活 —— 客户端不能拿它做日常清理）
 *
 * 用法：node report/aggregation-purge/probe-c-pouchdb-compact-vs-purge.mjs
 */
import PouchDB from 'pouchdb'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const REMOTE_DB = `probe_c_remote_${Date.now()}`
const REMOTE_URL = `${COUCH.replace(/^https?:\/\//, `http://${USER}:${PASS}@`)}/${REMOTE_DB}`

let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); ok ? pass++ : fail++ }

async function req(method, p, body) {
  const res = await fetch(COUCH + p, { method, headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: text } }
}

const dir = mkdtempSync(path.join(tmpdir(), 'probe-c-'))
const du = () => Number(execSync(`du -sk ${dir} | cut -f1`).toString().trim()) // KB
const id = (i) => `entry:${String(i).padStart(3, '0')}`

console.log(`\n=== 探针 C：PouchDB compact vs purge（本地目录 ${dir}）===\n`)
await req('PUT', `/${REMOTE_DB}`)
const docs = Array.from({ length: 40 }, (_, i) => ({
  _id: id(i), type: 'entry', publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  _attachments: { 'a.bin': { content_type: 'application/octet-stream', data: Buffer.alloc(50 * 1024, i % 251).toString('base64') } },
}))
await req('POST', `/${REMOTE_DB}/_bulk_docs`, { docs })

const local = new PouchDB(dir)
/** 复制 checkpoint 的哈希：两端同名 `_local/<哈希>`，但 `_local` 文档不出现在 allDocs 里，
 *  所以从**远端**反查哈希，再按 id 直接操作本地/远端两份。 */
const cpHash = async () => {
  const r = await req('GET', `/${REMOTE_DB}/_local_docs`)
  return (r.json?.rows ?? []).map((x) => x.id.replace(/^_local\//, ''))
}
const wipeCheckpoint = async () => {
  let n = 0
  for (const h of await cpHash()) {
    for (const [where, get, remove] of [
      ['local', () => local.get(`_local/${h}`), (doc) => local.remove(doc)],
      ['remote', async () => (await req('GET', `/${REMOTE_DB}/_local/${h}`)).json, async (doc) => req('DELETE', `/${REMOTE_DB}/_local/${h}?rev=${encodeURIComponent(doc._rev)}`)],
    ]) {
      try {
        const doc = await get()
        await remove(doc)
        n++
        console.log(`     擦掉 ${where} _local/${h}`)
      } catch (err) {
        console.log(`     （${where} _local/${h} 不存在或删除失败：${err?.message ?? err}）`)
      }
    }
  }
  return n
}
const deletedIds = async () => (await local.allDocs()).rows.map((r) => r.id)

console.log('① 首次复制（40 条 × 50KB 附件）')
await local.replicate.from(REMOTE_URL)
const s0 = du()
const info0 = await local.info()
console.log(`   本地 doc_count=${info0.doc_count} 目录=${s0}KB`)
check('首次复制把 40 条搬到本地', (await deletedIds()).length === 40)

console.log('\n② 本地删掉 20 条（产生墓碑）')
for (let i = 0; i < 20; i++) {
  const d = await local.get(id(i))
  await local.remove(d)
}
const s1 = du()
const info1 = await local.info()
console.log(`   本地 doc_count=${info1.doc_count} doc_del_count=${info1.doc_del_count ?? '-'} update_seq=${info1.update_seq} 目录=${s1}KB`)
check('本地只剩 20 条活文档', (await deletedIds()).length === 20)

console.log('\n③ db.compact()')
await local.compact()
const s2 = du()
console.log(`   目录 ${s1}KB → ${s2}KB`)
check('compact 之后至少不增大', s2 <= s1 + 32, `${s1} → ${s2}KB`)

console.log('\n④ 擦 checkpoint 强制重扫：compact 之后被删的 20 条不该回来（compact 不动修订记忆）')
const wiped = await wipeCheckpoint()
console.log(`   擦掉 ${wiped} 个 checkpoint，重扫…`)
await local.replicate.from(REMOTE_URL)
const afterCompact = await deletedIds()
const backAfterCompact = Array.from({ length: 20 }, (_, i) => id(i)).filter((x) => afterCompact.includes(x))
console.log(`   重扫后本地活文档 ${afterCompact.length} 条；被删的 20 条里回来的 = ${backAfterCompact.length} 条`)
check('compact 之后全量重扫不会复活已删文档', backAfterCompact.length === 0, backAfterCompact.slice(0, 3).join(','))

console.log('\n⑤ 对一条墓碑做 purge，再擦 checkpoint 重扫：该条应该被"复活"')
// 取一条墓碑的 rev：只有 _changes 能看到墓碑
const ch = await local.changes({ since: 0, include_docs: false })
const tomb = ch.results.find((r) => r.id === id(0) && r.deleted)
console.log(`   墓碑 ${id(0)} rev=${tomb?.changes?.[0]?.rev}`)
let purgeAvailable = true
try {
  const purgeRes = await local.purge(id(0), tomb.changes[0].rev)
  console.log(`   purge 结果 = ${JSON.stringify(purgeRes)}`)
} catch (err) {
  purgeAvailable = false
  console.log(`   ⚠️ 本地 purge 不可用：${err?.reason ?? err?.message ?? err}`)
  console.log('   → leveldb 适配器未实现 purge（IndexedDB 适配器自 8.0 起才有）。')
  console.log('   → 所以"客户端 purge 会不会导致重扫复活"这条在本探针环境下无法实测；')
  console.log('      方案里"客户端不 purge"的结论依据是 PouchDB 官方对 purge 的定位 + 机制推理，')
  console.log('      以及本探针 ④ 已证明的反面：compact 不动修订记忆。')
}
if (purgeAvailable) {
  await wipeCheckpoint()
  await local.replicate.from(REMOTE_URL)
  const afterPurge = await deletedIds()
  const resurrected = afterPurge.includes(id(0))
  console.log(`   重扫后本地活文档 ${afterPurge.length} 条；${id(0)} 回来了？${resurrected ? '是（复活）' : '否'}；目录=${du()}KB`)
  check('purge 之后全量重扫会复活该文档（所以客户端不能拿 purge 做日常清理）', resurrected)
}

console.log(`\n体积汇总（KB）：初始 ${s0} → 删 20 条 ${s1} → compact ${s2}`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
await local.destroy()
await req('DELETE', `/${REMOTE_DB}`)
rmSync(dir, { recursive: true, force: true })
console.log('(本地目录与远端临时库已清理)')
process.exit(fail === 0 ? 0 : 1)
