#!/usr/bin/env node
/**
 * 验证「同步最近 N 天」依赖的两条真实行为（单测里的 PouchDB 是假的，这里对真 CouchDB 跑）。
 *
 *   1. `_selector` 过滤复制：只有窗口内的条目（和全部 FeedDoc）落到本地库，
 *      附件也跟着来；窗口外历史条目一条都不下载。
 *   2. **复制 id 稳定 = checkpoint 能续用**：同一个 selector 再复制一次不再写任何文档；
 *      selector 一变（锚点前移）就多出一个 `_local/*` checkpoint —— 这正是
 *      `utils/syncWindow` 要把锚点固定下来的原因（否则每天全量重扫一遍 _changes）。
 *
 * 用法：
 *   node scripts/verify-sync-window.mjs
 *   COUCHDB_URL=http://couch:5984 COUCHDB_USER=... COUCHDB_PASSWORD=... node scripts/verify-sync-window.mjs
 *
 * 脚本自建一个临时库与临时本地库，结束时删除；失败时以非零码退出。
 */
import PouchDB from 'pouchdb'
import path from 'node:path'

const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const USER = process.env.COUCHDB_USER ?? 'admin'
const PASS = process.env.COUCHDB_PASSWORD ?? 'admin'

const remoteName = `rssfed-verify-window-${Date.now().toString(36)}`
const remoteNoAuth = `${COUCH}/${remoteName}`
const remoteWithAuth = (() => {
  const url = new URL(remoteNoAuth)
  url.username = USER
  url.password = PASS
  return url.toString()
})()
const localPath = path.join(process.cwd(), '.tmp-verify-sync-window')

const authHeader = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

/** 删掉本地临时库（Node 版 PouchDB 没有静态 destroy，按库名建实例再删） */
async function destroyLocal() {
  await new PouchDB(localPath).destroy().catch(() => {})
}

/** 直接打 CouchDB HTTP（建库 / 写文档 / 列 _local 文档 / 删库） */
async function couch(pathname, init = {}) {
  const res = await fetch(`${COUCH}${pathname}`, {
    ...init,
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → HTTP ${res.status}: ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

const DAY_MS = 86_400_000
const cut = offsetDays => new Date(Date.now() - offsetDays * DAY_MS).toISOString()
const WINDOW_ANCHOR = cut(3)

/** 构造复制用的 selector，与 app/utils/syncWindow.ts 的 windowSelector 同形 */
const windowSelector = anchor => ({
  $or: [
    { type: 'feed' },
    { publishedAt: { $gte: anchor } }
  ]
})

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * 远端库上 PouchDB 写下的 `_local/*`（复制 checkpoint）。
 *
 * 数它而不是数本地库：PouchDB 的 allDocs 不返回 `_local` 文档，而 checkpoint 是
 * 「源 + 目标」两边都写的，看源库就够了。条数变化 = 复制 id 变化 = checkpoint 重开一条线。
 */
async function remoteCheckpoints() {
  const res = await couch(`/${remoteName}/_local_docs`)
  return res.rows.map(r => r.id).sort()
}

async function main() {
  console.log(`CouchDB: ${COUCH}\n临时库: ${remoteName}\n本地库: ${localPath}\n`)

  await destroyLocal()
  await couch(`/${remoteName}`, { method: 'PUT' }).catch(() => {})

  // 3 条窗口内条目 + 2 条窗口外条目；窗口内第一条带附件（正文图片）
  await couch(`/${remoteName}/_bulk_docs`, {
    method: 'POST',
    body: JSON.stringify({
      docs: [
        { _id: 'feed-probe', type: 'feed', title: '探针源' },
        {
          _id: 'entry:feed-probe:recent1',
          type: 'entry',
          publishedAt: cut(1),
          title: '窗口内 1',
          _attachments: {
            'cover.avif': { content_type: 'image/avif', data: Buffer.from('fake-avif-bytes').toString('base64') }
          }
        },
        { _id: 'entry:feed-probe:recent2', type: 'entry', publishedAt: cut(2), title: '窗口内 2' },
        { _id: 'entry:feed-probe:recent3', type: 'entry', publishedAt: cut(2.5), title: '窗口内 3' },
        { _id: 'entry:feed-probe:old1', type: 'entry', publishedAt: cut(10), title: '窗口外 1' },
        { _id: 'entry:feed-probe:old2', type: 'entry', publishedAt: '2020-01-01T00:00:00.000Z', title: '窗口外 2' }
      ]
    })
  })

  const remote = new PouchDB(remoteWithAuth)
  const local = new PouchDB(localPath)

  console.log('① 按 3 天窗口过滤复制')
  const first = await local.replicate.from(remote, { selector: windowSelector(WINDOW_ANCHOR), batch_size: 20 })
  const ids = (await local.allDocs()).rows.map(r => r.id).sort()
  check('只同步 FeedDoc + 窗口内条目', JSON.stringify(ids) === JSON.stringify([
    'entry:feed-probe:recent1',
    'entry:feed-probe:recent2',
    'entry:feed-probe:recent3',
    'feed-probe'
  ]), ids.join(', '))
  check('窗口外条目没有落到本地', !ids.includes('entry:feed-probe:old1') && !ids.includes('entry:feed-probe:old2'))
  check('附件随文档同步', (await local.getAttachment('entry:feed-probe:recent1', 'cover.avif')) != null,
    `docs_written=${first.docs_written}`)

  console.log('\n② 同一 selector 再复制：checkpoint 续用，不重复写')
  const checkpointsAfterFirst = await remoteCheckpoints()
  check('首次复制写下了一条 checkpoint', checkpointsAfterFirst.length === 1, `${checkpointsAfterFirst.length} 条`)
  const second = await local.replicate.from(remote, { selector: windowSelector(WINDOW_ANCHOR), batch_size: 20 })
  const checkpointsAfterSecond = await remoteCheckpoints()
  check('第二轮没有写入任何文档', (second.docs_written ?? 0) === 0, `docs_written=${second.docs_written}`)
  check('第二轮没有重开 checkpoint（复制 id 未变）',
    checkpointsAfterSecond.length === checkpointsAfterFirst.length,
    `${checkpointsAfterFirst.length} → ${checkpointsAfterSecond.length}`)

  console.log('\n③ 锚点前移（窗口调大）：复制 id 随之变化，重开一条 checkpoint 线并回补更早的条目')
  const third = await local.replicate.from(remote, { selector: windowSelector(cut(20)), batch_size: 20 })
  const checkpointsAfterThird = await remoteCheckpoints()
  check('selector 变化会新增一条 checkpoint',
    checkpointsAfterThird.length === checkpointsAfterSecond.length + 1,
    `${checkpointsAfterSecond.length} → ${checkpointsAfterThird.length}`)
  check('宽窗口把更早的条目补回来', !!(await local.get('entry:feed-probe:old1').catch(() => null)),
    `docs_written=${third.docs_written}`)
  check('比新窗口更早的条目仍然不拉', !(await local.get('entry:feed-probe:old2').catch(() => null)))

  await local.destroy()
  await couch(`/${remoteName}`, { method: 'DELETE' }).catch(() => {})

  console.log(failures.length === 0
    ? '\n全部通过：窗口过滤 + checkpoint 稳定性符合 utils/syncWindow 的前提。'
    : `\n失败 ${failures.length} 项：${failures.join('；')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\n探针异常：', err)
  await destroyLocal()
  await couch(`/${remoteName}`, { method: 'DELETE' }).catch(() => {})
  process.exit(1)
})
