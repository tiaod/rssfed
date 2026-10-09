#!/usr/bin/env node
/**
 * 验证「服务端聚合 + 客户端 live 复制」这条链路是真的通（单测里服务端与 PouchDB 都是替身，
 * 这里全部打真的：真 Hono、真 CouchDB、真 PouchDB）。
 *
 * 它替代了旧的 `verify-sync-window.mjs`：那时客户端自己按窗口 selector 逐源复制（所以要验证
 * selector 与 checkpoint 的稳定性）；现在聚合在服务端完成，客户端只把派生库 live 复制下来，
 * 于是要验证的性质变成了：
 *
 *   ① 派生库确实按用户生成，并且**只有本人**能读（_security.members.names = [userId]）；
 *   ② 源库（feed 库）里新写入的条目会在下一轮聚合里出现在派生库中；
 *   ③ 客户端 live 复制能在**不重启复制**的情况下拿到服务端后来写入的条目 ——
 *      这是「服务端一有新内容，浏览器几秒内自动看到」的全部依据；
 *   ④ 源库里的条目被删除后，客户端也删掉本地副本（退订 / 窗口收窄的语义：本地跟随服务端）；
 *   ⑤ 未登录访问代理被拒（401）；
 *   ⑥ 同一张图在两个用户下压出的附件**不同**（图片参数是按用户生效的，不是一个全局值）。
 *
 * 用法：
 *   node scripts/verify-timeline-sync.mjs
 *   API_BASE=http://localhost:3001 COUCHDB_URL=http://localhost:5984 \
 *     COUCHDB_USER=admin COUCHDB_PASSWORD=admin node scripts/verify-timeline-sync.mjs
 *
 * 脚本会自己注册一个临时账号 + 一条订阅（指向一个必然连不上的本地端口，因此不会真的抓取），
 * 直接往该源的 CouchDB 库里写探针条目来模拟抓取结果。
 *
 * **清理是必达的**：正常结束与中途抛错都会走 `cleanup()` —— 销毁本地 PouchDB、删掉派生库与
 * 用户状态库、（有管理员账号时）删掉临时账号，并清掉写进探针源库的两条探针条目。
 *
 * 探针地址是**固定**的（不带时间戳），所以重复运行复用同一行 `feeds` 记录，不会累积。
 * **探针源库（`feed_xxx`）特意不删**：`feeds.couch_db_name` 一旦登记就走快路径、
 * 不再校验库是否存在（见 docs/troubleshooting.md），删了库但不改登记名，下一次 OPML 导入会直接
 * 报 `Database does not exist`。所以它连同那一行 feeds 一起留着（只有一条 FeedDoc，可忽略）。
 * 早期版本用带时间戳的地址且删库收尾，每跑一次就多一行 + 一个空库，别改回去。
 */
import PouchDB from 'pouchdb'
// 用 PouchDB 自己那套 fetch：它的响应对象带 .buffer()，直接塞全局 fetch 会在附件上炸
// （Node 的 Response 只有 .blob()，leveldb 适配器写附件时要 Buffer）
import pouchdbFetch from 'pouchdb-fetch'
import path from 'node:path'

const API = (process.env.API_BASE ?? 'http://localhost:3001').replace(/\/+$/, '')
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const COUCH_USER = process.env.COUCHDB_USER ?? 'admin'
const COUCH_PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin123!'
/** 请求里要带的 Origin：better-auth 用它做 CSRF 校验（真实浏览器一定会带） */
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:3000'

const stamp = Date.now().toString(36)
const TEMP_EMAIL = `verify-timeline-${stamp}@rssfed.local`
const TEMP_PASSWORD = 'Verify123!'
/** 探针源地址：指向本机一个不会有人监听的端口，注册时连接立刻被拒（不会拖慢导入）；**固定地址**，重复运行复用同一行 feeds */
const PROBE_FEED_URL = 'http://127.0.0.1:9/verify-timeline-probe.xml'
const localPath = path.join(process.cwd(), `.tmp-verify-timeline-${stamp}`)

/**
 * 结束时要回收的东西。放模块级是为了让异常路径也能清干净 —— 之前只在正常路径里清理，
 * 一次中途失败（探针异常）就在 dev 库里留下临时用户 + 两个空库 + 一行 feeds。
 */
const resources = {
  /** 依次创建的所有临时账号及其派生库（每项 { userId, timelineDb, userStateDb }） */
  accounts: [],
  feedDbName: null,
  feedId: null,
  local: null,
  replication: null
}

/** 尽力而为地回收：每一步独立 catch，一个失败不影响其它步骤 */
async function cleanup() {
  // 每一步独立 catch：清理是「尽力而为」，某一步失败不能让后面的步骤跟着跳过
  const ignore = () => {}
  try {
    resources.replication?.cancel()
  } catch { ignore() }
  try {
    await resources.local?.destroy()
  } catch { ignore() }
  for (const account of resources.accounts) {
    for (const name of [account.timelineDb, account.userStateDb]) {
      if (!name) continue
      try {
        await couch(`/${name}`, { method: 'DELETE' })
      } catch { ignore() }
    }
  }
  // 探针源库留着（见文件头说明），但把探针条目清掉：下次运行从干净状态开始，图片附件也一并消失
  if (resources.feedDbName && resources.feedId) {
    for (const suffix of ['verify1', 'verify2']) {
      const id = `entry:${resources.feedId}:${suffix}`
      try {
        const doc = await couch(`/${resources.feedDbName}/${encodeURIComponent(id)}`)
        if (doc?._rev) {
          await couch(`/${resources.feedDbName}/${encodeURIComponent(id)}?rev=${doc._rev}`, { method: 'DELETE' })
        }
      } catch { ignore() }
    }
  }
  if (resources.accounts.length === 0) return true
  try {
    const admin = makeSession()
    const login = await admin.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    })
    if (!login.ok) return false
    let allRemoved = true
    for (const account of resources.accounts) {
      if (!account.userId) continue
      const removed = await admin.request('/api/auth/admin/remove-user', {
        method: 'POST',
        body: JSON.stringify({ userId: account.userId })
      })
      if (!removed.ok) allRemoved = false
    }
    return allRemoved
  } catch {
    return false
  }
}

const couchAuth = `Basic ${Buffer.from(`${COUCH_USER}:${COUCH_PASS}`).toString('base64')}`

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 一次次请求里带着会话 cookie：Node 的 fetch 不管理 cookie，手动传 */
function makeSession() {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
    set cookie(value) {
      cookie = value
    },
    async request(pathname, init = {}) {
      const res = await fetch(`${API}${pathname}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          // better-auth 的 CSRF 防护要求带 Origin（真实浏览器一定带），否则 403
          'Origin': ORIGIN,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(init.headers ?? {})
        }
      })
      const setCookie = res.headers.getSetCookie?.() ?? []
      if (setCookie.length) cookie = setCookie.map(c => c.split(';')[0]).join('; ')
      return res
    }
  }
}

async function couch(pathname, init = {}) {
  const res = await fetch(`${COUCH}${pathname}`, {
    ...init,
    headers: { 'Authorization': couchAuth, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → HTTP ${res.status}: ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 等某个条件成立（PouchDB 的 live 复制是异步到达的，不能只看一次） */
async function waitFor(label, fn, timeoutMs = 60_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined)
    if (last) return last
    await sleep(stepMs)
  }
  throw new Error(`等待超时：${label}`)
}

/** 探针条目：publishedAt 用当前时间，必然落在窗口内 */
function probeEntry(id, title, imageUrl) {
  const now = new Date().toISOString()
  return {
    _id: id,
    type: 'entry',
    feedId: 'probe',
    title,
    url: `https://example.invalid/${id}`,
    publishedAt: now,
    insertedAt: now,
    content: imageUrl ? `<p>${title}</p><img src="${imageUrl}" alt="">` : `<p>${title}</p>`
  }
}

async function main() {
  console.log(`API: ${API}\nCouchDB: ${COUCH}\n临时账号: ${TEMP_EMAIL}\n本地库: ${localPath}\n`)

  // ── 0. 注册临时账号 ──
  const session = makeSession()
  const signUp = await session.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email: TEMP_EMAIL, password: TEMP_PASSWORD, name: '时间线验证' })
  })
  if (!signUp.ok) throw new Error(`注册临时账号失败（HTTP ${signUp.status}）：${await signUp.text()}`)
  const signedUp = await signUp.json()
  const userId = signedUp?.user?.id
  const primary = { userId: userId ?? null, timelineDb: null, userStateDb: null }
  resources.accounts.push(primary)
  check('临时账号注册成功并拿到登录态', !!userId && !!session.cookie, `userId=${userId}`)

  // ── 1. 订阅一个探针源（不会真的抓取：端口 9 无人监听） ──
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="验证" title="验证">
      <outline type="rss" text="探针源" title="探针源" xmlUrl="${PROBE_FEED_URL}" />
    </outline>
  </body></opml>`
  const imported = await session.request('/api/feeds/import-opml', {
    method: 'POST',
    body: JSON.stringify({ opml })
  })
  if (!imported.ok) throw new Error(`导入 OPML 失败（HTTP ${imported.status}）：${await imported.text()}`)
  const importResult = await imported.json()
  // 探针地址是固定的：第一次跑是新建（imported=1），之后是「已存在」（skipped=1），两者都算成功
  check('探针源已订阅', importResult.imported === 1 || importResult.skipped === 1, JSON.stringify(importResult))

  const subs = await (await session.request('/api/feeds/subscriptions')).json()
  const subscription = subs.find(s => s.feedId)
  resources.feedId = subscription?.feedId ?? null
  check('订阅列表里有这条订阅', !!subscription, subscription ? `feedId=${subscription.feedId}` : '')

  // ── 2. 拿到该源的库名，直接写一条探针条目（模拟抓取结果） ──
  const targets = await (await session.request('/api/couchdb/targets')).json()
  const feedDbName = targets?.feeds?.[subscription.feedId]
  resources.feedDbName = feedDbName ?? null
  check('能取到探针源的 CouchDB 库名', typeof feedDbName === 'string' && feedDbName.length > 0, feedDbName)

  const IMAGE_URL = process.env.PROBE_IMAGE_URL ?? 'https://httpbin.org/image/png'
  const ENTRY_ID = `entry:${subscription.feedId}:verify1`
  await couch(`/${feedDbName}/_bulk_docs`, {
    method: 'POST',
    body: JSON.stringify({
      docs: [
        { _id: subscription.feedId, type: 'feed', title: '探针源', url: PROBE_FEED_URL },
        probeEntry(ENTRY_ID, '探针条目 1', IMAGE_URL)
      ]
    })
  })

  // ── 3. 催一轮聚合（wait=1：本请求内跑完） ──
  const refresh = await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  check('催促聚合返回 200', refresh.status === 200, `HTTP ${refresh.status}`)
  const refreshBody = refresh.ok ? await refresh.json() : {}
  check('一轮聚合在请求内跑完（wait=1）', refreshBody.completed === true, JSON.stringify(refreshBody))

  // ── 4. 派生库：命名、归属、_security ──
  const syncTargets = await (await session.request('/api/couchdb/sync-targets')).json()
  const timelineDb = syncTargets?.timeline
  primary.timelineDb = timelineDb ?? null
  primary.userStateDb = syncTargets?.userState ?? null
  check('sync-targets 下发的是按用户的时间线库', typeof timelineDb === 'string' && timelineDb.startsWith('user-timeline_'), String(timelineDb))

  const security = await couch(`/${timelineDb}/_security`)
  const members = security?.members?.names ?? []
  check('派生库只有本人可读（_security.members.names = [userId]）',
    members.length === 1 && members[0] === userId, JSON.stringify(members))

  // ── 5. 开一条 live 复制，然后**在复制运行期间**再写一条条目 ──
  const proxyUrl = `${API}/api/couchdb/proxy/${encodeURIComponent(timelineDb)}`
  // 浏览器里 cookie 是自动带的；Node 里 PouchDB 用不了 cookie jar，手动注入到它自己的 fetch 上
  const nodeFetch = pouchdbFetch.fetch
  const pouchFetch = (url, opts = {}) => {
    const headers = new pouchdbFetch.Headers(opts.headers ?? {})
    headers.set('Cookie', session.cookie)
    return nodeFetch(url, { ...opts, headers })
  }
  const local = new PouchDB(localPath)
  resources.local = local
  const replicating = local.replicate.from(proxyUrl, {
    live: true,
    retry: true,
    batch_size: 20,
    fetch: pouchFetch
  })
  resources.replication = replicating
  const replicationErrors = []
  replicating.on('error', err => replicationErrors.push(err))

  const firstLocal = await waitFor('首轮同步把探针条目 1 拉下来', async () => {
    const doc = await local.get(ENTRY_ID).catch(() => null)
    return doc
  })
  check('live 复制把探针条目 1 拉到本地', !!firstLocal, firstLocal?.title)

  // 派生库里的附件是服务端按用户参数重新压过的（源库没有附件）
  const attachmentNames = Object.keys(firstLocal._attachments ?? {})
  if (attachmentNames.length > 0) {
    const att = firstLocal._attachments[attachmentNames[0]]
    check('派生条目带服务端重新压好的 AVIF 附件（按用户参数生成）',
      att.content_type === 'image/avif', `${attachmentNames[0]} (${att.content_type})`)
  } else {
    console.log(`  · 跳过附件检查：源图未能下载（${IMAGE_URL}），条目本身已正确同步`)
  }

  // ── 6. 复制运行中新增条目：服务端写入 → 客户端自动收到（不重启复制） ──
  const ENTRY_ID_2 = `entry:${subscription.feedId}:verify2`
  await couch(`/${feedDbName}/_bulk_docs`, {
    method: 'POST',
    body: JSON.stringify({ docs: [probeEntry(ENTRY_ID_2, '探针条目 2', null)] })
  })
  const secondRefresh = await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  check('第二次催促聚合在请求内跑完', secondRefresh.status === 200, `HTTP ${secondRefresh.status}`)

  const secondLocal = await waitFor('live 复制在运行中拿到新条目', async () => {
    const doc = await local.get(ENTRY_ID_2).catch(() => null)
    return doc
  })
  check('复制没有重启，新条目自己到达本地', !!secondLocal, secondLocal?.title)
  check('复制过程中没有报错', replicationErrors.length === 0,
    replicationErrors.map(e => e?.message ?? String(e)).join('；'))

  // ── 7. 源库删除 → 本地跟随删除 ──
  const sourceDoc = await couch(`/${feedDbName}/${encodeURIComponent(ENTRY_ID_2)}`)
  await couch(`/${feedDbName}/${encodeURIComponent(ENTRY_ID_2)}?rev=${sourceDoc._rev}`, { method: 'DELETE' })
  const thirdRefresh = await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  check('删除源条目后催促聚合成功', thirdRefresh.status === 200, `HTTP ${thirdRefresh.status}`)

  const removed = await waitFor('客户端跟随服务端的删除', async () => {
    const doc = await local.get(ENTRY_ID_2).catch(() => null)
    return doc === null
  }, 60_000).then(() => true).catch(() => false)
  check('源条目删除后本地副本也删掉了（本地跟随服务端）', removed)

  // ── 8. 未登录不能读派生库 ──
  const anonymous = await fetch(`${proxyUrl}/_all_docs`)
  check('未登录访问派生库被拒（401）', anonymous.status === 401, `HTTP ${anonymous.status}`)

  // ── 9. 同一张图 + 不同用户参数 → 附件必须不同（图片策略是按用户生效的，不是一个全局值） ──
  const session2 = makeSession()
  const TEMP_EMAIL_2 = `verify-timeline-b-${stamp}@rssfed.local`
  const signUp2 = await session2.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email: TEMP_EMAIL_2, password: TEMP_PASSWORD, name: '时间线验证 B' })
  })
  if (!signUp2.ok) throw new Error(`注册第二个临时账号失败（HTTP ${signUp2.status}）：${await signUp2.text()}`)
  const second = { userId: (await signUp2.json())?.user?.id ?? null, timelineDb: null, userStateDb: null }
  resources.accounts.push(second)

  // 小图 + 低质量：与第一个账号的默认值（1200px / q45）必然产出不同字节
  const patched = await session2.request('/api/timeline/settings', {
    method: 'PATCH',
    body: JSON.stringify({ maxImageWidth: 64, avifQuality: 30 })
  })
  check('第二个账号的时间线设置可改（PATCH 生效）', patched.ok, `HTTP ${patched.status}`)

  await session2.request('/api/feeds/import-opml', {
    method: 'POST',
    body: JSON.stringify({ opml })
  })
  const refresh2 = await session2.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  check('第二个账号的聚合在请求内跑完', refresh2.status === 200, `HTTP ${refresh2.status}`)

  const targets2 = await (await session2.request('/api/couchdb/sync-targets')).json()
  second.timelineDb = targets2?.timeline ?? null
  second.userStateDb = targets2?.userState ?? null
  const ownDb = typeof second.timelineDb === 'string'
    && second.timelineDb.startsWith('user-timeline_')
    && second.timelineDb !== primary.timelineDb
  check('第二个账号拿到自己的派生库', ownDb, String(second.timelineDb))

  /**
   * 取派生库里某条目附件的**字节数**。
   *
   * 附件本体必须走 `/db/doc/att` 这个端点：`?attachments=true` 在 CouchDB 3.5 上对带附件的文档
   * 返回 `multipart/related`（不是 JSON），`?atts=true` 又只给 stub、不带 data。
   */
  async function attachmentBytes(dbName, entryId) {
    if (!dbName) return null
    const doc = await couch(`/${dbName}/${encodeURIComponent(entryId)}`).catch(() => null)
    const name = Object.keys(doc?._attachments ?? {})[0]
    if (!name) return null
    const res = await fetch(`${COUCH}/${dbName}/${encodeURIComponent(entryId)}/${encodeURIComponent(name)}`, {
      headers: { Authorization: couchAuth }
    })
    if (!res.ok) return null
    return (await res.arrayBuffer()).byteLength
  }

  if (attachmentNames.length > 0) {
    const bytesA = await attachmentBytes(primary.timelineDb, ENTRY_ID)
    const bytesB = await attachmentBytes(second.timelineDb, ENTRY_ID)
    check('两个账号都拿到了同一张图的附件', !!bytesA && !!bytesB, `A=${bytesA}B B=${bytesB}B`)
    check('附件按各自用户参数压缩（字节数不同，小图/低质量的更小）',
      !!bytesA && !!bytesB && bytesB < bytesA, `A=${bytesA}B → B=${bytesB}B`)
  } else {
    console.log('  · 跳过按用户参数的附件对比：源图未能下载')
  }

  // ── 清理：本地库 + 各账号的远端库 + 临时账号（探针源库保留，见文件头说明） ──
  const accountRemoved = await cleanup()
  check('临时账号已清理', accountRemoved, `共 ${resources.accounts.length} 个临时账号`)

  console.log(failures.length === 0
    ? '\n全部通过：服务端聚合 → 派生库归属 → live 复制 → 删除跟随 → 按用户图片策略，链路行为符合设计。'
    : `\n失败 ${failures.length} 项：${failures.join('；')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\n探针异常：', err)
  // 异常路径同样要回收：否则一次失败就在 dev 库里留下临时用户与空库
  await cleanup()
  process.exit(1)
})
