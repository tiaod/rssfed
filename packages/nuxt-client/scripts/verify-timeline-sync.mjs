#!/usr/bin/env node
/**
 * 验证「服务端聚合 + 客户端单库双向同步」这条链路是真的通（单测里服务端与 PouchDB 都是替身，
 * 这里全部打真的：真 Hono、真 CouchDB、真 PouchDB）。
 *
 * 它替代了旧的 `verify-sync-window.mjs`：那时客户端自己按窗口 selector 逐源复制（所以要验证
 * selector 与 checkpoint 的稳定性）；现在聚合在服务端完成，客户端只同步**一个**库。
 * 要验证的性质：
 *
 *   ① 用户库确实按用户生成，并且**只有本人**能读（_security.members.names = [userId]）；
 *   ② sync-targets 只下发这一个库（订阅与条目同库，旧版逐源下发的 /targets 已删除）；
 *   ③ 源库（feed 库）里新写入的条目会在下一轮聚合里出现在用户库中；
 *   ④ 拉取通道能在**不重启复制**的情况下拿到服务端后来写入的条目 ——
 *      这是「服务端一有新内容，浏览器几秒内自动看到」的全部依据；
 *   ⑤ 源库里的条目被删除后，客户端也删掉本地副本（退订 / 窗口收窄的语义：本地跟随服务端）；
 *   ⑥ **写方向闸门**（用户库设计文档里的 validate_doc_update）：
 *      经代理写 `entry` 文档被拒（403，否则客户端能影子化/删掉服务端聚合产物）、
 *      写 `entry-state` / `subscription` 这类状态文档放行；
 *   ⑦ 回写通道只推状态文档：本地写的已读/收藏能自己上去；
 *   ⑧ 未登录访问代理被拒（401）；
 *   ⑨ **附件只在抓取时产生**：探针源库里的附件被原样搬进各用户库，两个用户的字节与源库
 *      完全一致（图片策略是 per-feed 的，聚合不再下载/压缩任何图片）。
 *   ⑩ **搬运由 CouchDB 复制器完成**：该用户订阅的每个源一条常驻复制（selector 按窗口过滤，
 *      窗口外的老条目不会被搬进来）；退订会把任务与内容一起清掉；
 *   ⑪ **重建 / v1→v2 升级**：伪造一份 version 1 的状态文档，验证「换一个空聚合库重搬」——
 *      老库换掉、用户自己写的状态跟着搬、内容按当前窗口重新搬回来（复制是变更投递不是投影，
 *      就地清空是搬不回来的）。
 *
 * 用法：
 *   node scripts/verify-timeline-sync.mjs
 *   API_BASE=http://localhost:3001 COUCHDB_URL=http://localhost:5984 \
 *     COUCHDB_USER=admin COUCHDB_PASSWORD=admin node scripts/verify-timeline-sync.mjs
 *
 * 脚本会自己注册一个临时账号 + 一条订阅（指向一个必然连不上的本地端口，因此不会真的抓取），
 * 直接往该源的 CouchDB 库里写探针条目来模拟抓取结果。
 *
 * **清理是必达的**：正常结束与中途抛错都会走 `cleanup()` —— 销毁本地 PouchDB、删掉用户库、
 * （有管理员账号时）删掉临时账号，并清掉写进探针源库的两条探针条目。
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
  /** 依次创建的所有临时账号及其用户库（每项 { userId, timelineDb }） */
  accounts: [],
  feedDbName: null,
  feedId: null,
  local: null,
  /** 拉取通道 */
  replication: null,
  /** 状态回写通道 */
  pushing: null
}

/** 尽力而为地回收：每一步独立 catch，一个失败不影响其它步骤 */
async function cleanup() {
  // 每一步独立 catch：清理是「尽力而为」，某一步失败不能让后面的步骤跟着跳过
  const ignore = () => {}
  for (const channel of [resources.replication, resources.pushing]) {
    try {
      channel?.cancel()
    } catch { ignore() }
  }
  try {
    await resources.local?.destroy()
  } catch { ignore() }
  for (const account of resources.accounts) {
    // 先删复制任务再删库：任务留着的话复制器会对着已删除的源/目标一直重试（_scheduler 里堆 crashing）
    if (account.userId) await deleteUserReplications(account.userId)
    if (!account.timelineDb) continue
    try {
      await couch(`/${account.timelineDb}`, { method: 'DELETE' })
    } catch { ignore() }
  }
  // 探针源库留着（见文件头说明），但把探针条目清掉：下次运行从干净状态开始，图片附件也一并消失
  if (resources.feedDbName && resources.feedId) {
    for (const suffix of ['verify1', 'verify2', 'verifyold']) {
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
/**
 * 探针条目：`attachmentBase64` 非空时带上一个附件，模拟**抓取路径已经压好图**的源库文档。
 * 聚合不该再对它做任何事，只把它原样搬进用户库。
 */
function probeEntry(id, title, attachmentBase64, publishedAt = new Date().toISOString()) {
  const now = publishedAt
  const imageUrl = 'https://example.invalid/probe.avif'
  return {
    _id: id,
    type: 'entry',
    feedId: 'probe',
    title,
    url: `https://example.invalid/${id}`,
    publishedAt: now,
    insertedAt: now,
    content: attachmentBase64 ? `<p>${title}</p><img src="${imageUrl}" alt="">` : `<p>${title}</p>`,
    ...(attachmentBase64
      ? {
          images: [{ url: imageUrl, attachment: 'img-0.avif', width: 1, height: 1, cover: true }],
          _attachments: { 'img-0.avif': { content_type: 'image/avif', data: attachmentBase64 } }
        }
      : {})
  }
}

/**
 * 反查探针源的 CouchDB 库名。
 *
 * 旧版是问 `GET /api/couchdb/targets`（逐源下发库名），那个端点随逐源同步一起删掉了；
 * 库名是随机生成、只存在业务表里的，客户端也不再需要它。脚本要直接写探针条目，
 * 只能按 `_id = feedId` 在 `feed_*` 库里反查（dev 环境约两百个库，本地请求很快）。
 */
async function findFeedDb(feedId) {
  const dbs = await couch('/_all_dbs')
  for (const name of dbs) {
    if (!name.startsWith('feed_')) continue
    const doc = await couch(`/${name}/${encodeURIComponent(feedId)}`).catch(() => null)
    if (doc?._id === feedId) return name
  }
  return null
}

/**
 * 该用户在 `_replicator` 里的复制任务（文档 id 前缀 = `rssfed-{userId}:`）。
 *
 * 聚合搬运改成复制器之后，「哪些源正在搬」的真相就在这个系统库里 —— 脚本直接读它，
 * 而不是相信某个接口自述。
 */
async function replicationDocs(userId) {
  const prefix = `rssfed-${userId}:`
  const res = await couch(`/_replicator/_all_docs?include_docs=true` +
    `&startkey=${encodeURIComponent(JSON.stringify(prefix))}` +
    `&endkey=${encodeURIComponent(JSON.stringify(`${prefix}\uffff`))}`)
  return (res?.rows ?? []).map(row => ({ id: row.id, rev: row.value?.rev, doc: row.doc }))
}

/** 删掉某个用户的全部复制任务（清理临时账号时必做：否则复制器会对着已删除的库一直重试） */
async function deleteUserReplications(userId) {
  for (const doc of await replicationDocs(userId)) {
    try {
      await couch(`/_replicator/${encodeURIComponent(doc.id)}?rev=${doc.rev}`, { method: 'DELETE' })
    } catch { /* 尽力而为 */ }
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
  const primary = { userId: userId ?? null, timelineDb: null }
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

  // ── 2. 反查该源的库名，直接写一条探针条目（模拟抓取结果） ──
  const feedDbName = await findFeedDb(subscription.feedId)
  resources.feedDbName = feedDbName ?? null
  check('能反查到探针源的 CouchDB 库名', typeof feedDbName === 'string' && feedDbName.length > 0, feedDbName)

  /**
   * 探针条目**自带附件**：这就是抓取路径的产物形状（正文图在抓取时按 per-feed 策略压成 AVIF
   * 附件写进源库，见 rss/entry-images.ts）。字节由脚本自己造，不依赖外网图床 ——
   * 于是「聚合只搬运、两用户字节一致」这条断言是确定的，图片下载链路由单测覆盖。
   */
  const PROBE_ATTACHMENT = Buffer.from('rssfed-probe-attachment-bytes-v1').toString('base64')
  const ENTRY_ID = `entry:${subscription.feedId}:verify1`
  await couch(`/${feedDbName}/_bulk_docs`, {
    method: 'POST',
    body: JSON.stringify({
      docs: [
        { _id: subscription.feedId, type: 'feed', title: '探针源', url: PROBE_FEED_URL },
        probeEntry(ENTRY_ID, '探针条目 1', PROBE_ATTACHMENT)
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
  check('sync-targets 下发的是按用户的合并库', typeof timelineDb === 'string' && timelineDb.startsWith('user-timeline_'), String(timelineDb))
  check('sync-targets 只回一个库（订阅与条目同库）',
    Object.keys(syncTargets).join(',') === 'timeline' && syncTargets.userState === undefined,
    Object.keys(syncTargets).join(','))
  const legacyTargets = await session.request('/api/couchdb/targets')
  check('旧版逐源下发的 /api/couchdb/targets 已删除（404）', legacyTargets.status === 404, `HTTP ${legacyTargets.status}`)

  const security = await couch(`/${timelineDb}/_security`)
  const members = security?.members?.names ?? []
  check('派生库只有本人可读（_security.members.names = [userId]）',
    members.length === 1 && members[0] === userId, JSON.stringify(members))

  // ── 4.1 复制拓扑：每个 (用户 × 订阅源) 一条常驻复制，窗口写成 selector ──
  const jobs = await replicationDocs(userId)
  check('该用户有一条复制任务（源库 → 用户库）', jobs.length === 1, JSON.stringify(jobs.map(j => j.id)))
  const jobDoc = jobs[0] ? await couch(`/_replicator/${encodeURIComponent(jobs[0].id)}`) : null
  check('复制任务指向该用户的派生库、且是常驻复制',
    jobDoc?.target?.endsWith(`/${timelineDb}`) === true && jobDoc?.continuous === true,
    `target=${jobDoc?.target} continuous=${jobDoc?.continuous}`)
  // 为什么是 JS filter 而不是 Mango selector：selector 对「已删除文档」无字段可匹配，
  // 源端删除永远不会被搬过来（实测）。这是「本地跟随服务端删除」的前提。
  check('复制任务用 JS filter 按窗口过滤',
    jobDoc?.filter === 'main/timeline' && typeof jobDoc?.query_params?.minPublishedAt === 'string',
    `filter=${jobDoc?.filter} query_params=${JSON.stringify(jobDoc?.query_params)}`)
  check('过滤参数名不叫 since（会和 _changes 自己的 since 撞车，窗口会静默失效）',
    jobDoc?.query_params?.since === undefined, JSON.stringify(jobDoc?.query_params))
  check('复制任务的 id 里带窗口天数（换窗口 = 换复制哈希 = 从 0 重扫回填）',
    /:w\d+:.+$/.test(jobs[0]?.id ?? ''), String(jobs[0]?.id))

  // 过滤器装在**源库**的设计文档里（存量库也要补装，否则任务直接 crashing）
  const sourceDdoc = await couch(`/${feedDbName}/_design/main`)
  check('源库设计文档里装上了聚合复制过滤器，且删除放行',
    typeof sourceDdoc?.filters?.timeline === 'string'
      && sourceDdoc.filters.timeline.includes('doc._deleted')
      && Object.keys(sourceDdoc?.views ?? {}).length > 0,
    `filters=${Object.keys(sourceDdoc?.filters ?? {})} views=${Object.keys(sourceDdoc?.views ?? {})}`)

  // ── 4.2 窗口 selector 真的在过滤：窗口外的老条目不会被搬进来 ──
  const OLD_ENTRY_ID = `entry:${subscription.feedId}:verifyold`
  await couch(`/${feedDbName}/_bulk_docs`, {
    method: 'POST',
    body: JSON.stringify({ docs: [probeEntry(OLD_ENTRY_ID, '窗口外的老条目', null,
      new Date(Date.now() - 60 * 86_400_000).toISOString())] })
  })
  await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  const oldEntry = await couch(`/${timelineDb}/${encodeURIComponent(OLD_ENTRY_ID)}`).catch(() => null)
  check('窗口外的条目不会被搬进用户库（selector 生效）', oldEntry === null,
    oldEntry ? '老条目竟然进来了' : '未搬入')

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

  // 回写通道：与 usePouchDb 的 isClientWritableDoc 同口径（设计文档与 entry/feed 一概不推）
  const pushing = local.replicate.to(proxyUrl, {
    live: true,
    retry: true,
    fetch: pouchFetch,
    filter: doc => !String(doc._id).startsWith('_design/') && doc.type !== 'entry' && doc.type !== 'feed'
  })
  resources.pushing = pushing
  pushing.on('error', err => replicationErrors.push(err))

  const firstLocal = await waitFor('首轮同步把探针条目 1 拉下来', async () => {
    const doc = await local.get(ENTRY_ID).catch(() => null)
    return doc
  })
  check('live 复制把探针条目 1 拉到本地', !!firstLocal, firstLocal?.title)

  // 派生库里的附件是从源库搬过来的成品（聚合不碰图片）
  const attachmentNames = Object.keys(firstLocal._attachments ?? {})
  if (attachmentNames.length > 0) {
    const att = firstLocal._attachments[attachmentNames[0]]
    check('派生条目带源库搬过来的 AVIF 附件',
      att.content_type === 'image/avif', `${attachmentNames[0]} (${att.content_type})`)
  } else {
    check('派生条目带源库搬过来的 AVIF 附件', false, '派生条目上没有附件')
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

  // ── 8.1 写方向闸门：客户端能写状态文档，写不了服务端聚合产物 ──
  // 单库之后客户端与聚合侧写的是同一个库，所以这条边界必须在数据库层成立
  // （库设计文档里的 validate_doc_update，见 hono-server 的 couchdb/client.ts）。
  const dbPath = `/api/couchdb/proxy/${encodeURIComponent(timelineDb)}`

  const forgedEntry = await session.request(`${dbPath}/${encodeURIComponent(`entry:${subscription.feedId}:forged`)}`, {
    method: 'PUT',
    body: JSON.stringify({
      type: 'entry',
      feedId: subscription.feedId,
      title: '伪造条目',
      publishedAt: new Date().toISOString()
    })
  })
  check('客户端经代理写 entry 文档被拒（403）', forgedEntry.status === 403, `HTTP ${forgedEntry.status}`)

  const forgedFeed = await session.request(`${dbPath}/${encodeURIComponent(`feed:${subscription.feedId}`)}`, {
    method: 'PUT',
    body: JSON.stringify({ type: 'feed', title: '伪造源名' })
  })
  check('客户端经代理写 feed 文档被拒（403）', forgedFeed.status === 403, `HTTP ${forgedFeed.status}`)

  // 删掉服务端刚聚合出来的条目也该被拒（否则本地删除会推上来把内容抹掉）
  const aggregated = await couch(`/${timelineDb}/${encodeURIComponent(ENTRY_ID)}`)
  const forgedDelete = await session.request(
    `${dbPath}/${encodeURIComponent(ENTRY_ID)}?rev=${aggregated._rev}`,
    { method: 'DELETE' }
  )
  check('客户端经代理删聚合条目被拒（403）', forgedDelete.status === 403, `HTTP ${forgedDelete.status}`)
  const survived = await couch(`/${timelineDb}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null)
  check('被拒之后聚合条目还在（闸门只是拒绝，不产生副作用）', !!survived)

  const stateViaProxy = await session.request(`${dbPath}/${encodeURIComponent('entry-state:proxy-check')}`, {
    method: 'PUT',
    body: JSON.stringify({
      type: 'entry-state',
      entryId: ENTRY_ID,
      feedId: subscription.feedId,
      read: true,
      saved: false
    })
  })
  check('客户端经代理写 entry-state 文档被放行（2xx）',
    stateViaProxy.status === 201 || stateViaProxy.status === 202, `HTTP ${stateViaProxy.status}`)

  const subViaProxy = await session.request(`${dbPath}/${encodeURIComponent(`subscription:${subscription.feedId}`)}`)
  check('订阅文档就在这一个库里（聚合读的就是它）', subViaProxy.status === 200, `HTTP ${subViaProxy.status}`)

  // ── 8.2 回写通道：本地写的状态文档自己上去（不经过任何显式推库代码） ──
  await local.put({
    _id: `entry-state:${ENTRY_ID}`,
    type: 'entry-state',
    entryId: ENTRY_ID,
    feedId: subscription.feedId,
    read: true,
    saved: true
  })
  const pushedUp = await waitFor('本地状态文档经回写通道到达服务端', async () => {
    const doc = await couch(`/${timelineDb}/${encodeURIComponent(`entry-state:${ENTRY_ID}`)}`).catch(() => null)
    return doc?.saved === true ? doc : null
  }, 30_000)
  check('本地写的已读/收藏经回写通道同步到了服务端', !!pushedUp)
  check('回写通道只推状态：本地没有 entry 文档被推上去',
    !(await couch(`/${timelineDb}/${encodeURIComponent(`entry:${subscription.feedId}:forged`)}`).catch(() => null)))

  // ── 9. 同一张图：两个账号的附件与源库字节一致（图片只在抓取时压一次，聚合只搬运） ──
  const session2 = makeSession()
  const TEMP_EMAIL_2 = `verify-timeline-b-${stamp}@rssfed.local`
  const signUp2 = await session2.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email: TEMP_EMAIL_2, password: TEMP_PASSWORD, name: '时间线验证 B' })
  })
  if (!signUp2.ok) throw new Error(`注册第二个临时账号失败（HTTP ${signUp2.status}）：${await signUp2.text()}`)
  const second = { userId: (await signUp2.json())?.user?.id ?? null, timelineDb: null }
  resources.accounts.push(second)

  // 第二个账号有自己的设置（窗口），但它改不了附件：图片策略是 per-feed 的
  const patched = await session2.request('/api/timeline/settings', {
    method: 'PATCH',
    body: JSON.stringify({ windowDays: 7 })
  })
  check('第二个账号的时间线设置可改（PATCH 生效）', patched.ok, `HTTP ${patched.status}`)

  const imported2 = await session2.request('/api/feeds/import-opml', {
    method: 'POST',
    body: JSON.stringify({ opml })
  })
  const imported2Body = imported2.ok ? await imported2.json() : {}
  check('第二个账号导入 OPML 成功（没被静默吞掉）',
    imported2.ok && ((imported2Body.imported ?? 0) + (imported2Body.skipped ?? 0) === 1),
    `HTTP ${imported2.status} ${JSON.stringify(imported2Body)}`)
  const refresh2 = await session2.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  const refresh2Body = refresh2.ok ? await refresh2.json() : {}
  check('第二个账号的聚合在请求内跑完', refresh2.status === 200, `HTTP ${refresh2.status} ${JSON.stringify(refresh2Body)}`)

  const subs2 = await (await session2.request('/api/feeds/subscriptions')).json()
  check('第二个账号的订阅落在自己的用户库里（改设置后也不该丢）',
    subs2.some(s => s.feedId === subscription.feedId), `共 ${subs2.length} 条订阅`)

  const targets2 = await (await session2.request('/api/couchdb/sync-targets')).json()
  second.timelineDb = targets2?.timeline ?? null
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
    // 复制器是异步的：新任务要等调度器拉起来才开始搬，`refresh?wait=1` 也可能在首批数据到端前
    // 就报"追平"（判据是派生库安静，不是复制器状态）。所以比字节前先给每个账号留一段等待。
    for (const db of [primary.timelineDb, second.timelineDb]) {
      if (!db) continue
      try {
        await waitFor(`账号库 ${db} 出现 ${ENTRY_ID}`, async () =>
          await couch(`/${db}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null), 60_000)
      } catch {
        // 没等到就走下面的诊断输出（会打印条目/附件状态）
      }
    }
    const bytesA = await attachmentBytes(primary.timelineDb, ENTRY_ID)
    const bytesB = await attachmentBytes(second.timelineDb, ENTRY_ID)
    if (!bytesA || !bytesB) {
      // 失败时把两边的条目状态打出来：区分「条目没聚合出来」/「条目在但没附件」/「源图这次没下下来」
      for (const [label, db] of [['A', primary.timelineDb], ['B', second.timelineDb]]) {
        const doc = db ? await couch(`/${db}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null) : null
        const atts = Object.keys(doc?._attachments ?? {})
        const images = (doc?.images ?? []).map(i => i.attachment ?? '(无附件)')
        console.log(`  · 账号 ${label}：${doc ? `条目存在，_attachments=[${atts}]，images=${JSON.stringify(images)}` : '条目不存在'}`)
      }
    }
    const bytesSource = await attachmentBytes(feedDbName, ENTRY_ID)
    check('两个账号都拿到了同一张图的附件', !!bytesA && !!bytesB, `A=${bytesA}B B=${bytesB}B`)
    check('用户库的附件与源库字节完全一致（聚合只搬运，不重压、不看用户参数）',
      !!bytesSource && bytesA === bytesSource && bytesB === bytesSource,
      `源=${bytesSource}B A=${bytesA}B B=${bytesB}B`)
  } else {
    console.log('  · 跳过附件对比：探针条目没带附件')
  }

  // ── 10. 重建 / v1 → v2 升级：换一个空聚合库重新"修剪"一遍 ──
  //
  // 复制是**变更投递不是投影**：目标端自己删过的 rev，复制器不会再送回来，所以"就地清空再重搬"
  // 做不到（实测）。重建走的是**换库**：另建一个空聚合库、把用户自己写的状态文档搬过去、
  // 旧库删掉，复制器就会按当前窗口从 0 扫源库把内容重搬一遍。
  const jobsBeforeRebuild = await replicationDocs(userId)
  const dbBeforeRebuild = primary.timelineDb
  const rebuilt = await session.request('/api/timeline/rebuild', { method: 'POST' })
  check('重建接口接受请求', rebuilt.status === 202, `HTTP ${rebuilt.status}`)
  // 重建是异步入队的，等新库接上（sync-targets 会给出新库名）
  let dbAfterRebuild = null
  try {
    dbAfterRebuild = await waitFor('聚合库换成了新的', async () => {
      const t = await (await session.request('/api/couchdb/sync-targets')).json()
      return t?.timeline && t.timeline !== dbBeforeRebuild ? t.timeline : null
    }, 30_000)
  } catch {
    dbAfterRebuild = null
  }
  check('重建换了一个新的聚合库（旧库被替换掉）', !!dbAfterRebuild, `${dbBeforeRebuild} → ${dbAfterRebuild}`)
  primary.timelineDb = dbAfterRebuild ?? dbBeforeRebuild
  let rebuiltEntry = null
  if (dbAfterRebuild) {
    try {
      rebuiltEntry = await waitFor('重建后条目被重新搬回来', async () =>
        await couch(`/${dbAfterRebuild}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null), 90_000)
    } catch {
      rebuiltEntry = null
    }
  }
  check('重建后条目被重新搬回来（换库 = 丢 checkpoint = 从 0 重扫）', !!rebuiltEntry, ENTRY_ID)
  const rebuiltState = await couch(`/${primary.timelineDb}/_local/state`).catch(() => null)
  check('重建后状态写成 version 2', rebuiltState?.version === 2, JSON.stringify(rebuiltState?.version))
  const rebuiltSub = await couch(`/${primary.timelineDb}/${encodeURIComponent(`subscription:${subscription.feedId}`)}`).catch(() => null)
  check('重建把用户订阅搬到新库（重建不能等于"订阅全没了"）', !!rebuiltSub, JSON.stringify(rebuiltSub?._id))
  const rebuiltUserState = await couch(`/${primary.timelineDb}/${encodeURIComponent(`entry-state:${ENTRY_ID}`)}`).catch(() => null)
  check('重建把用户写的已读/收藏搬到新库', rebuiltUserState?.saved === true, JSON.stringify(rebuiltUserState?.saved))
  const jobsAfterRebuild = await replicationDocs(userId)
  check('重建后复制任务按新库重建',
    jobsAfterRebuild.length === jobsBeforeRebuild.length
      && jobsAfterRebuild.every(j => String(j.doc?.target ?? '').endsWith(`/${dbAfterRebuild}`)),
    JSON.stringify(jobsAfterRebuild.map(j => j.doc?.target)))
  // 换库重搬是异步的：库名先切过去，之后才搬用户状态、删旧库，所以这里要等一等
  let oldDbGone = false
  try {
    oldDbGone = await waitFor('旧聚合库被删掉', async () =>
      !!(await couch(`/${dbBeforeRebuild}`).catch(() => ({ error: 'network' })))?.error, 20_000).then(() => true)
  } catch {
    oldDbGone = false
  }
  check('旧聚合库被删掉（不再占空间、也不会被误同步）', oldDbGone, dbBeforeRebuild)

  // ── 11. 退订：任务与内容一起清（复制器不会因为过滤变严而删东西，删除归服务端） ──
  //
  // 注意用的是**重建后**的库名：第 10 节换过库，这里必须按新库寻址
  const liveDbPath = `/api/couchdb/proxy/${encodeURIComponent(primary.timelineDb)}`
  const subDoc = await couch(`/${primary.timelineDb}/${encodeURIComponent(`subscription:${subscription.feedId}`)}`)
  await session.request(
    `${liveDbPath}/${encodeURIComponent(`subscription:${subscription.feedId}`)}?rev=${subDoc._rev}`,
    { method: 'DELETE' }
  )
  await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
  check('退订后该源的复制任务被删掉（不会再往用户库搬东西）',
    (await replicationDocs(userId)).length === 0, JSON.stringify((await replicationDocs(userId)).map(j => j.id)))
  check('退订后该源的条目被清掉',
    (await couch(`/${primary.timelineDb}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null)) === null)
  check('退订后 FeedDoc 副本也被清掉',
    (await couch(`/${primary.timelineDb}/${encodeURIComponent(subscription.feedId)}`).catch(() => null)) === null)
  check('退订不会动用户状态文档（订阅之外的已读/收藏仍在）',
    !!(await couch(`/${primary.timelineDb}/${encodeURIComponent(`entry-state:${ENTRY_ID}`)}`).catch(() => null)))

  // ── 清理：本地库 + 各账号的远端库 + 临时账号（探针源库保留，见文件头说明） ──
  const accountRemoved = await cleanup()
  check('临时账号已清理', accountRemoved, `共 ${resources.accounts.length} 个临时账号`)

  console.log(failures.length === 0
    ? '\n全部通过：单库下发 → 复制器搬运（JS filter + 窗口参数 / 附件二进制）→ 拉取/回写两条通道 → 删除跟随 → 退订清理 / 重建换库 → 写方向闸门，链路行为符合设计。'
    : `\n失败 ${failures.length} 项：${failures.join('；')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\n探针异常：', err)
  // 异常路径同样要回收：否则一次失败就在 dev 库里留下临时用户与空库
  await cleanup()
  process.exit(1)
})
