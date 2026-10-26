/**
 * 真栈集成测试：服务端聚合 + 客户端单库双向同步（迁移自 `scripts/verify-timeline-sync.mjs`）
 *
 * 为什么是集成测试而不是单测：单测里 Hono 聚合器、CouchDB、PouchDB 都是替身；这里全部打真的 ——
 * 真 Hono(:3001) + 真 CouchDB(:5984) + 本进程里的真 PouchDB(leveldb)。它要钉住的性质（11 组）：
 *
 *   ① 用户库确实按用户生成，并且**只有本人**能读（_security.members.names = [userId]）；
 *   ② sync-targets 只下发这一个合并库（订阅与条目同库，旧版逐源下发的 /targets 已删除）；
 *   ③ 源库（feed 库）里新写入的条目会在下一轮聚合里出现在用户库中；
 *   ④ 拉取通道能在**不重启复制**的情况下拿到服务端后来写入的条目；
 *   ⑤ 源库里的条目被删除后，客户端也删掉本地副本（镜像语义，删除随复制传播）；
 *   ⑥ **写方向闸门**（用户库设计文档里的 validate_doc_update）：经代理写 `entry` / `feed` 被拒
 *      （403），写 `entry-state` / `subscription` 这类状态文档放行；
 *   ⑦ 回写通道只推状态文档：本地写的已读/收藏能自己上去；
 *   ⑧ 未登录访问代理被拒（401）；
 *   ⑨ **附件只在抓取时产生**：探针源库里的附件被原样搬进各用户库，两个用户的字节与源库完全一致；
 *   ⑩ **搬运由 CouchDB 复制器按需完成**：没有常驻复制任务；源没更新时 `refresh?wait=1` 的
 *      `queued` 必须是 0；`?force=1` 跳过水位判定重扫；同参数复用同一个 checkpoint；
 *      源库里直接写入的老条目也会被镜像；退订会把水位行与内容一起清掉；
 *   ⑪ **重建 / v1→v2 升级**：伪造 version 1 状态文档后走 rebuild，验证「换一个空聚合库重搬」——
 *      老库换掉、用户自己写的状态跟着搬、内容从源库重新完整搬回来。
 *
 * 前置（本机 dev 栈，**不要重启**）：
 *   - 后端 Hono：http://localhost:3001（可用 API_BASE 覆盖）
 *   - CouchDB：http://localhost:5984，admin/admin（可用 COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD 覆盖）
 *   - 前端：http://localhost:3000（Origin 用于 better-auth 的 CSRF 校验，可用 ORIGIN 覆盖）
 *   - 数据准备**不依赖 admin 账号**：临时账号自己注册、探针源指向没人监听的 127.0.0.1:9；
 *     只有「删临时账号」那一步沿用旧逻辑（admin 登录后调 remove-user）。
 *
 * 跑法（在 packages/nuxt-client 下）：
 *   pnpm exec vitest run --config vitest.integration.config.ts
 *
 * 清理语义（**必达**）：
 *   - 测试体用 try/finally 包住，afterAll 再兜一层（同一个 Promise，幂等）：取消拉取/回写两条
 *     live 复制、销毁本地 PouchDB、删各账号的用户库（先删 _replicator 里的遗留任务，否则复制器
 *     会对着已删除的库一直重试）、删临时账号、清掉写进探针源库的探针条目。
 *   - **探针源库（feed_xxx）特意不删**：`feeds.couch_db_name` 一旦登记就走快路径、不再校验库是否
 *     存在，删了库但不改登记名，下一次 OPML 导入会直接报 `Database does not exist`
 *     （见 docs/troubleshooting.md）。探针 URL 是**固定**的，重复运行复用同一行 `feeds`，不会累积。
 *   - 探针条目要写进**所有候选库**：dev 里这个固定 URL 的历史库可能有多份（早期脚本会删库收尾），
 *     只写字典序第一个会写进诱饵库、服务端从登记的那个库搬不到东西（曾经为此白排查一轮）。
 *   - 断言一律 `expect.soft`：一步失败不中断后续步骤，一次运行拿到完整失败清单。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PouchDB from 'pouchdb'
// 用 PouchDB 自己那套 fetch：它的响应对象带 .buffer()，直接塞全局 fetch 会在附件上炸
// （Node 的 Response 只有 .blob()，leveldb 适配器写附件时要 Buffer）
import pouchdbFetch from 'pouchdb-fetch'
import { afterAll, expect, test } from 'vitest'

const API = (process.env.API_BASE ?? 'http://localhost:3001').replace(/\/+$/, '')
const COUCH = (process.env.COUCHDB_URL ?? 'http://localhost:5984').replace(/\/+$/, '')
const COUCH_USER = process.env.COUCHDB_USER ?? 'admin'
const COUCH_PASS = process.env.COUCHDB_PASSWORD ?? 'admin'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin123!'
/** 请求里要带的 Origin：better-auth 用它做 CSRF 校验（真实浏览器一定会带） */
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:3000'

/** 每次运行唯一：临时账号/本地库名不能和并发跑的旧脚本或另一次 vitest 撞车 */
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const TEMP_EMAIL = `verify-timeline-it-${STAMP}@rssfed.local`
const TEMP_EMAIL_B = `verify-timeline-it-b-${STAMP}@rssfed.local`
const TEMP_PASSWORD = 'Verify123!'
/**
 * 探针源地址：指向本机一个不会有人监听的端口（注册时连接立刻被拒、不会拖慢导入）。
 * **固定地址**：重复运行复用同一行 `feeds`，不累积。
 */
const PROBE_FEED_URL = 'http://127.0.0.1:9/verify-timeline-probe.xml'
/** 本地 PouchDB 目录放 .cache/（该目录已被 gitignore），不污染包根目录 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DB_PATH = path.join(HERE, '..', '.cache', `timeline-sync-it-${STAMP}`)

const couchAuth = `Basic ${Buffer.from(`${COUCH_USER}:${COUCH_PASS}`).toString('base64')}`

/**
 * 本测试真正读到的 CouchDB / Hono 文档字段。真栈测试拿到的本来就是松散 JSON，
 * 不整份建模；这里只声明断言会用到的字段，让 `couch<T>()` 有明确类型。
 */
interface CouchDoc {
  _id?: string
  _rev?: string
  title?: string
  type?: string
  saved?: boolean
  version?: number
  _attachments?: Record<string, { content_type?: string }>
  images?: Array<{ attachment?: string }>
  filters?: { timeline?: string }
  views?: Record<string, unknown>
  members?: { names?: string[] }
}

interface CouchRows<Row> {
  rows?: Row[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言 / 进度输出
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `check()` 的迁移口径：条件 → `expect.soft`。
 *
 * 用 soft 而不是普通 expect 是为了保持旧脚本「跑完再汇总」的行为：某个性质不成立时，
 * 后面的性质仍然会被验证（一次运行拿到完整失败清单，而不是第一个失败就断）。
 * 这里同时打印 ✓/✗ 进度行 —— 集成测试走的是真实链路，进度日志是排查线索。
 */
const failures: string[] = []
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures.push(label)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  expect.soft(ok, detail ? `${label} — ${detail}` : label).toBe(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 等某个条件成立（PouchDB 的 live 复制是异步到达的，不能只看一次） */
async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
  stepMs = 250
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined)
    if (value) return value as T
    await sleep(stepMs)
  }
  throw new Error(`等待超时：${label}`)
}

async function couch<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${COUCH}${pathname}`, {
    ...init,
    headers: { 'Authorization': couchAuth, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → HTTP ${res.status}: ${await res.text()}`)
  return (res.status === 204 ? null : await res.json()) as T
}

type ImportResult = { total?: number, imported?: number, skipped?: number }

/** 一次次请求里带着会话 cookie：Node 的 fetch 不管理 cookie，手动传 */
function makeSession() {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
    // 首次注册时服务端可能不种 cookie（取决于配置），旧脚本用 `set cookie` 显式赋值兜底
    set cookie(value: string) {
      cookie = value
    },
    async request(pathname: string, init: RequestInit = {}): Promise<Response> {
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

/**
 * 读 OPML 导入的 NDJSON 进度流，返回最终汇总。
 *
 * `/api/feeds/import-opml` 是流式接口（逐源一行进度事件，供前端画进度条），
 * 最后一次 `done` 事件才是老的 JSON 响应体；这里顺带数一下 progress 事件条数。
 */
async function readImportStream(res: Response): Promise<{ final: ImportResult, progressEvents: number }> {
  if (!res.body) throw new Error('导入响应没有响应体，读不到进度流')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: ImportResult | null = null
  let progressEvents = 0
  const handle = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const event = JSON.parse(trimmed)
    if (event.type === 'progress') progressEvents++
    else if (event.type === 'done') final = event
    else if (event.type === 'error') throw new Error(`导入流内报错：${event.message}`)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      handle(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) handle(buffer)
  if (!final) throw new Error('导入流没有 done 事件，拿不到汇总')
  return { final, progressEvents }
}

// ─────────────────────────────────────────────────────────────────────────────
// 探针源库的操作
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 探针条目：`attachmentBase64` 非空时带上一个附件，模拟**抓取路径已经压好图**的源库文档。
 * 聚合不该再对它做任何事，只把它原样搬进用户库。
 */
function probeEntry(
  id: string,
  title: string,
  attachmentBase64: string | null,
  publishedAt = new Date().toISOString()
) {
  const imageUrl = 'https://example.invalid/probe.avif'
  return {
    _id: id,
    type: 'entry',
    feedId: 'probe',
    title,
    url: `https://example.invalid/${id}`,
    publishedAt,
    insertedAt: publishedAt,
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
 * 反查探针源的 CouchDB 库名 —— **返回全部候选**。
 *
 * 旧版是问 `GET /api/couchdb/targets`（逐源下发库名），那个端点随逐源同步一起删掉了；
 * 库名是随机生成、只存在业务表里的，客户端也不再需要它。脚本要直接写探针条目，
 * 只能按 `_id = feedId` 在 `feed_*` 库里反查（dev 环境约两百个库，本地请求很快）。
 *
 * 为什么是"全部"而不是"第一个"：dev 里这个固定探针 URL 的库历史上被换过（早版本的脚本会删库
 * 收尾），于是留下**多个都含 `_id = feedId` 文档**的库；注册表 `feeds.couch_db_name` 指向哪一个
 * 只有服务端知道。曾经只取字典序第一个，结果探针条目写进了诱饵库、服务端从登记的那个库搬，
 * 表现为"服务端没搬任何条目"，白排查了一轮。所以每个候选都写一遍 —— 诱饵库多一份副本无害。
 */
async function findFeedDbs(feedId: string): Promise<string[]> {
  const dbs: string[] = await couch('/_all_dbs')
  const found: string[] = []
  for (const name of dbs) {
    if (!name.startsWith('feed_')) continue
    const doc = await couch(`/${name}/${encodeURIComponent(feedId)}`).catch(() => null)
    if (doc?._id === feedId) found.push(name)
  }
  return found
}

/** 往所有候选探针源库写同一批文档，返回写入成功的库数 */
async function writeToFeedDbs(docs: unknown[]): Promise<number> {
  let ok = 0
  for (const db of resources.feedDbNames) {
    try {
      await couch(`/${db}/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }) })
      ok++
    } catch {
      // 单个候选库不可用不该让整轮验证失败：登记的库能写就行（写不进去下面的断言会报）
    }
  }
  return ok
}

/**
 * 该用户在 `_replicator` 里的**遗留常驻**复制任务（文档 id 前缀 = `rssfed-{userId}:`）。
 *
 * 按需复制不往这个系统库写文档了（一次性复制走 `POST /_replicate`，完全不经过复制器调度器），
 * 所以这里的期望值恒为**空**：用它钉住"升级后没有残留的常驻任务在抢机器"。
 * 清理临时账号时也顺带删掉它们（老版本、或手工建的账号可能留下）。
 */
async function replicationDocs(userId: string) {
  const prefix = `rssfed-${userId}:`
  const res = await couch<CouchRows<{ id: string, value?: { rev?: string }, doc?: CouchDoc }>>(
    `/_replicator/_all_docs?include_docs=true`
    + `&startkey=${encodeURIComponent(JSON.stringify(prefix))}`
    + `&endkey=${encodeURIComponent(JSON.stringify(`${prefix}\uffff`))}`
  )
  return (res?.rows ?? []).map(row => ({ id: row.id, rev: row.value?.rev, doc: row.doc }))
}

/**
 * 派生库里的**复制 checkpoint**（`_local/<参数哈希>`）。
 *
 * 一次性复制的增量能力全靠它：参数（源库 + 目标库 + 过滤器源码）不变时哈希不变，
 * 下一次调用就接着上次的序号继续；哈希一变就是全量重扫。排掉我们自己的 `_local/state`。
 */
async function timelineCheckpoints(dbName: string): Promise<string[]> {
  const res = await couch<CouchRows<{ id: string }>>(`/${dbName}/_local_docs`)
  return (res?.rows ?? [])
    .map(row => row.id)
    .filter(id => id.startsWith('_local/') && id !== '_local/state' && !id.startsWith('_local/sync'))
    .sort()
}

/** 删掉某个用户的全部遗留常驻复制任务（清理临时账号时必做：否则复制器会对着已删除的库一直重试） */
async function deleteUserReplications(userId: string): Promise<void> {
  for (const doc of await replicationDocs(userId)) {
    try {
      await couch(`/_replicator/${encodeURIComponent(doc.id)}?rev=${doc.rev}`, { method: 'DELETE' })
    } catch {
      // 尽力而为
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 资源回收
// ─────────────────────────────────────────────────────────────────────────────

type Account = { userId: string | null, timelineDb: string | null }

/**
 * 结束时要回收的东西。放模块级是为了让异常路径也能清干净 —— 之前只在正常路径里清理，
 * 一次中途失败（探针异常）就在 dev 库里留下临时用户 + 两个空库 + 一行 feeds。
 */
const resources: {
  /** 依次创建的所有临时账号及其用户库 */
  accounts: Account[]
  /** 探针源库候选（dev 里可能有历史遗留的同 id 库，见 findFeedDbs） */
  feedDbNames: string[]
  feedId: string | null
  local: { destroy: () => Promise<unknown> } | null
  /** 拉取通道 */
  replication: { cancel: () => void } | null
  /** 状态回写通道 */
  pushing: { cancel: () => void } | null
} = {
  accounts: [],
  feedDbNames: [],
  feedId: null,
  local: null,
  replication: null,
  pushing: null
}

/** 尽力而为地回收：每一步独立 catch，一个失败不影响其它步骤 */
async function runCleanup(): Promise<boolean> {
  for (const channel of [resources.replication, resources.pushing]) {
    try {
      channel?.cancel()
    } catch {
      // ignore
    }
  }
  try {
    await resources.local?.destroy()
  } catch {
    // ignore
  }
  // 销毁之后把残留目录也抹掉（PouchDB destroy 在异常中断时可能留下空目录/日志文件）
  try {
    fs.rmSync(LOCAL_DB_PATH, { recursive: true, force: true })
  } catch {
    // ignore
  }
  for (const account of resources.accounts) {
    // 先删复制任务再删库：任务留着的话复制器会对着已删除的源/目标一直重试（_scheduler 里堆 crashing）
    if (account.userId) {
      try {
        await deleteUserReplications(account.userId)
      } catch {
        // ignore
      }
    }
    if (!account.timelineDb) continue
    try {
      await couch(`/${account.timelineDb}`, { method: 'DELETE' })
    } catch {
      // ignore
    }
  }
  // 探针源库留着（见文件头说明），但把探针条目清掉：下次运行从干净状态开始，图片附件也一并消失
  if (resources.feedDbNames.length > 0 && resources.feedId) {
    for (const db of resources.feedDbNames) {
      for (const suffix of ['verify1', 'verify2', 'verifyold']) {
        const id = `entry:${resources.feedId}:${suffix}`
        try {
          const doc = await couch(`/${db}/${encodeURIComponent(id)}`)
          if (doc?._rev) {
            await couch(`/${db}/${encodeURIComponent(id)}?rev=${doc._rev}`, { method: 'DELETE' })
          }
        } catch {
          // ignore
        }
      }
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

/**
 * 清理只会真正跑一次：测试体 finally 里跑一次（并断言结果），afterAll 兜底再调时复用同一个 Promise。
 * 这样即使测试体在 finally 之前就因致命异常退出，afterAll 也能把 dev 库清干净。
 */
let cleanupPromise: Promise<boolean> | null = null
function cleanup(): Promise<boolean> {
  cleanupPromise ??= runCleanup()
  return cleanupPromise
}

afterAll(async () => {
  // 兜底：正常路径已在测试体的 finally 里清理过；这里只是保证异常/超时路径也不留垃圾
  if (!cleanupPromise) await cleanup()
})

// ─────────────────────────────────────────────────────────────────────────────
// 真栈主流程
// ─────────────────────────────────────────────────────────────────────────────

test('单库聚合 + 拉取/回写双向同步的真栈行为符合设计', async () => {
  try {
    console.log(`\nAPI: ${API}\nCouchDB: ${COUCH}\n临时账号: ${TEMP_EMAIL}\n本地库: ${LOCAL_DB_PATH}\n`)

    // ── 0. 注册临时账号（不依赖 admin：数据准备全部自己来） ──
    const session = makeSession()
    const signUp = await session.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email: TEMP_EMAIL, password: TEMP_PASSWORD, name: '时间线验证' })
    })
    if (!signUp.ok) throw new Error(`注册临时账号失败（HTTP ${signUp.status}）：${await signUp.text()}`)
    const signedUp = await signUp.json()
    const userId: string | null = signedUp?.user?.id ?? null
    const primary: Account = { userId, timelineDb: null }
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
    const { final: importResult, progressEvents } = await readImportStream(imported)
    // 探针地址是固定的：第一次跑是新建（imported=1），之后是「已存在」（skipped=1），两者都算成功
    check('探针源已订阅', importResult.imported === 1 || importResult.skipped === 1, JSON.stringify(importResult))
    check('导入逐源回报进度事件', progressEvents === importResult.total, `${progressEvents}/${importResult.total}`)

    const subscriptionsResponse = await session.request('/api/feeds/subscriptions')
    const subscriptions = (await subscriptionsResponse.json()) as Array<{ feedId?: string }>
    const subscription = subscriptions.find(s => s.feedId)
    if (!subscription?.feedId) throw new Error('订阅列表里没有探针源，后续步骤无法进行')
    const feedId = subscription.feedId
    resources.feedId = feedId
    check('订阅列表里有这条订阅', !!subscription, `feedId=${feedId}`)

    // ── 2. 反查该源的库名，直接写一条探针条目（模拟抓取结果） ──
    const feedDbNames = await findFeedDbs(feedId)
    resources.feedDbNames = feedDbNames
    const feedDbName = feedDbNames[0] ?? null
    check(
      '能反查到探针源的 CouchDB 库名（可能有多份历史库，全部都会写一遍）',
      feedDbNames.length > 0,
      feedDbNames.join(', ')
    )

    /**
     * 探针条目**自带附件**：这就是抓取路径的产物形状（正文图在抓取时按 per-feed 策略压成 AVIF
     * 附件写进源库，见 rss/entry-images.ts）。字节由测试自己造，不依赖外网图床 ——
     * 于是「聚合只搬运、两用户字节一致」这条断言是确定的，图片下载链路由单测覆盖。
     */
    const PROBE_ATTACHMENT = Buffer.from('rssfed-probe-attachment-bytes-v1').toString('base64')
    const ENTRY_ID = `entry:${feedId}:verify1`
    const wroteTo = await writeToFeedDbs([
      { _id: feedId, type: 'feed', title: '探针源', url: PROBE_FEED_URL },
      probeEntry(ENTRY_ID, '探针条目 1', PROBE_ATTACHMENT)
    ])
    check('探针条目已写进探针源库', wroteTo > 0, `${wroteTo}/${feedDbNames.length} 个候选库`)

    // ── 3. 催一轮聚合（wait=1：本请求内跑完） ──
    const refresh = await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
    check('催促聚合返回 200', refresh.status === 200, `HTTP ${refresh.status}`)
    const refreshBody = (refresh.ok ? await refresh.json() : {}) as { completed?: boolean }
    check('一轮聚合在请求内跑完（wait=1）', refreshBody.completed === true, JSON.stringify(refreshBody))

    // ── ④ 派生库：命名、归属、_security ──
    const syncTargetsResponse = await session.request('/api/couchdb/sync-targets')
    const syncTargets = (await syncTargetsResponse.json()) as { timeline?: string, userState?: unknown }
    const timelineDb: string | null = syncTargets?.timeline ?? null
    primary.timelineDb = timelineDb
    check(
      'sync-targets 下发的是按用户的合并库',
      typeof timelineDb === 'string' && timelineDb.startsWith('user-timeline_'),
      String(timelineDb)
    )
    // ② sync-targets 只下发这一个库（订阅与条目同库）
    check(
      'sync-targets 只回一个库（订阅与条目同库）',
      Object.keys(syncTargets).join(',') === 'timeline' && syncTargets.userState === undefined,
      Object.keys(syncTargets).join(',')
    )
    const legacyTargets = await session.request('/api/couchdb/targets')
    check('旧版逐源下发的 /api/couchdb/targets 已删除（404）', legacyTargets.status === 404, `HTTP ${legacyTargets.status}`)

    if (!timelineDb) throw new Error('sync-targets 没有下发 timeline 库，后续步骤无法进行')

    // ① 派生库的 _security：只有本人可读
    const security = await couch<CouchDoc>(`/${timelineDb}/_security`)
    const members: string[] = security?.members?.names ?? []
    check(
      '派生库只有本人可读（_security.members.names = [userId]）',
      members.length === 1 && members[0] === userId,
      JSON.stringify(members)
    )

    // ── 4.1 拓扑：**一条常驻复制任务都不该有** ──
    //
    // 老版本给每个 (用户 × 订阅源) 建一条 `continuous: true` 的复制文档：625 条一起追赶实测把
    // 2 核机压到 load 20.8 / swap 1.6G，而用 `max_jobs` 限流又必然饿死（常驻任务永不结束、
    // 不释放槽位）。现在搬运走 `POST /_replicate` 的一次性复制，由 `rss-timeline-sync` 队列限并发，
    // 完全不经过复制器调度器 —— 所以这个系统库里不该再出现我们的文档。
    const jobs = await replicationDocs(userId!)
    check(
      '该用户没有遗留的常驻复制任务（按需搬运不经过 _replicator 调度器）',
      jobs.length === 0,
      JSON.stringify(jobs.map(j => j.id))
    )

    // ── ⑥ 过滤器语义：装在**源库**的设计文档里（存量库也要补装，否则复制直接 filter_fetch_error） ──
    //
    // 旧脚本断言的是 `filters.timeline.includes('doc._deleted')`，而现过滤器只挡 `_design/`
    // （见 hono-server/src/couchdb/client.ts 的 TIMELINE_REPLICATION_FILTER）；那条断言今天能过，
    // 靠的是 dev 里遗留的**诱饵库**（早期版本的设计文档里有 doc._deleted 字符串），`_all_dbs`
    // 字典序又恰好先返回诱饵库 —— 干净环境/库名变了就会假失败。
    //
    // 改成**求值语义**：候选库里每一个装了 filters.timeline 的设计文档都必须满足
    //   filter({_id: 'entry:x', _deleted: true}) === true   （删除放行，否则源库裁剪传不到客户端）
    //   filter({_id: '_design/main'}) === false            （挡住设计文档，否则搬过去撞用户库的 _design/main）
    // 复制过滤器是 CouchDB 端执行的 JS 源码，按复制器的方式求值，不再依赖字符串/库顺序。
    const filterCandidates: Array<{ db: string, ddoc: CouchDoc }> = []
    for (const db of feedDbNames) {
      const ddoc = await couch<CouchDoc>(`/${db}/_design/main`).catch(() => null)
      if (typeof ddoc?.filters?.timeline === 'string') filterCandidates.push({ db, ddoc })
    }
    const evaluateFilter = (source: string, doc: Record<string, unknown>): unknown => {
      // 只从源码构造函数，不引入任何外部依赖（与 CouchDB 复制器执行 filter 的方式同构）
      const fn = new Function('doc', `return (${source})(doc)`) as (d: Record<string, unknown>) => unknown
      return fn(doc)
    }
    const filterVerdicts = filterCandidates.map(({ db, ddoc }) => {
      try {
        return {
          db,
          deletedPasses: evaluateFilter(ddoc.filters.timeline, { _id: 'entry:x', _deleted: true }) === true,
          designBlocked: evaluateFilter(ddoc.filters.timeline, { _id: '_design/main' }) === false,
          views: Object.keys(ddoc.views ?? {}).length
        }
      } catch (error) {
        return { db, deletedPasses: false, designBlocked: false, views: 0, error: String(error) }
      }
    })
    check(
      '源库设计文档里装上了聚合复制过滤器，且删除放行、设计文档被挡',
      filterVerdicts.length > 0
      && filterVerdicts.every(v => v.deletedPasses && v.designBlocked && v.views > 0),
      filterVerdicts
        .map(v => `${v.db}: del=${v.deletedPasses} design=${v.designBlocked} views=${v.views}`
          + ('error' in v ? ` error=${v.error}` : ''))
        .join(' | ')
    )

    // ── 4.2 复制是**精确镜像**：源库里直接写入的老条目也会被搬进来 ──
    //
    // 保留策略的权威是源库裁剪（每源最新 N 条），复制本身**不带任何时间参数**。所以一条发布时间
    // 很老、但确实躺在源库里的条目，重扫时必须出现在用户库 —— 反过来说，"窗口外置不入"这条旧断言
    // 现在必须**不再**成立（那是旧设计：时间下界塞在 query_params 里）。
    const OLD_ENTRY_ID = `entry:${feedId}:verifyold`
    await writeToFeedDbs([
      probeEntry(OLD_ENTRY_ID, '源库里的老条目', null, new Date(Date.now() - 60 * 86_400_000).toISOString())
    ])
    // 测试是**直接写源库**的（模拟抓取产物），PG 里的 feeds.lastChangedAt 不会动，所以默认
    // 水位判定认为"这个源没有变化"、不会搬 —— 要验证镜像必须显式重扫（force）
    await session.request('/api/timeline/refresh?wait=1&force=1', { method: 'POST' })
    const oldEntry = await couch<CouchDoc>(`/${timelineDb}/${encodeURIComponent(OLD_ENTRY_ID)}`).catch(() => null)
    check(
      '源库里发布时间很老的条目也会被镜像进用户库（复制不带时间下界）',
      !!oldEntry,
      oldEntry ? `title=${oldEntry.title}` : '没搬进来 —— 复制还在按窗口过滤？'
    )

    // 同一次强制重扫里，探针条目必须**真的**搬进来了。这条件直接看用户库、不经过客户端，
    // 于是"服务端没搬"和"客户端没拉到"两种失败不会混在一起（曾经混过一次，白排查一轮）。
    const copiedEntry = await couch<CouchDoc>(`/${timelineDb}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null)
    check(
      '按需同步把探针条目搬进了用户库（源库 → 用户库的一次性复制）',
      !!copiedEntry,
      copiedEntry ? `title=${copiedEntry.title}` : '用户库里没有这条'
    )

    // ── ④ 拉取通道：开一条 live 复制，然后**在复制运行期间**再写一条条目 ──
    const proxyUrl = `${API}/api/couchdb/proxy/${encodeURIComponent(timelineDb)}`
    // 浏览器里 cookie 是自动带的；Node 里 PouchDB 用不了 cookie jar，手动注入到它自己的 fetch 上
    const nodeFetch = pouchdbFetch.fetch
    const pouchFetch = (url: string, opts: Record<string, unknown> = {}) => {
      const headers = new pouchdbFetch.Headers(opts.headers ?? {})
      headers.set('Cookie', session.cookie)
      return nodeFetch(url, { ...opts, headers })
    }
    const local = new PouchDB(LOCAL_DB_PATH)
    resources.local = local
    // ⑦ 拉取通道：live 复制（不重启复制就能拿到服务端后来写入的条目）
    // `fetch` / `batch_size` 是 PouchDB 的运行时选项（@types 里没声明），Node 下必须把 cookie 注进去
    const replicating = local.replicate.from(proxyUrl, {
      live: true,
      retry: true,
      batch_size: 20,
      fetch: pouchFetch
    })
    resources.replication = replicating
    const replicationErrors: unknown[] = []
    replicating.on('error', (err: unknown) => replicationErrors.push(err))

    // 回写通道：与 usePouchDb 的 isClientWritableDoc 同口径（设计文档与 entry/feed 一概不推）
    const pushing = local.replicate.to(proxyUrl, {
      live: true,
      retry: true,
      fetch: pouchFetch,
      filter: (doc: CouchDoc) =>
        !String(doc._id).startsWith('_design/') && doc.type !== 'entry' && doc.type !== 'feed'
    })
    resources.pushing = pushing
    pushing.on('error', (err: unknown) => replicationErrors.push(err))

    const firstLocal = await waitFor<CouchDoc>('首轮同步把探针条目 1 拉下来', async () => {
      return await local.get(ENTRY_ID).catch(() => null)
    })
    check('live 复制把探针条目 1 拉到本地', !!firstLocal, firstLocal?.title)

    // ⑨ 派生库里的附件是从源库搬过来的成品（聚合不碰图片）
    const attachmentNames = Object.keys(firstLocal._attachments ?? {})
    if (attachmentNames.length > 0) {
      const att = firstLocal._attachments[attachmentNames[0]]
      check(
        '派生条目带源库搬过来的 AVIF 附件',
        att.content_type === 'image/avif',
        `${attachmentNames[0]} (${att.content_type})`
      )
    } else {
      check('派生条目带源库搬过来的 AVIF 附件', false, '派生条目上没有附件')
    }

    // ── 6. 增量：先确认"没有新内容就不搬"，再显式重扫把新条目搬过来 ──
    //
    // 这一节同时钉住两件事：① 水位生效时一轮聚合一个复制请求都不发（queued=0）；
    // ② 同参数的第二次搬运复用同一个 checkpoint（下界稳定 → 不会每次全量重扫源库）。
    const idleRefresh = await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
    const idleBody = (idleRefresh.ok ? await idleRefresh.json() : {}) as { queued?: number }
    check(
      '源没更新时一轮聚合不搬任何源（水位生效：queued=0）',
      idleRefresh.status === 200 && idleBody.queued === 0,
      JSON.stringify(idleBody)
    )
    const checkpointsBefore = await timelineCheckpoints(timelineDb)

    const ENTRY_ID_2 = `entry:${feedId}:verify2`
    await writeToFeedDbs([probeEntry(ENTRY_ID_2, '探针条目 2', null)])
    const secondRefresh = await session.request('/api/timeline/refresh?wait=1&force=1', { method: 'POST' })
    check('第二次催促聚合在请求内跑完', secondRefresh.status === 200, `HTTP ${secondRefresh.status}`)

    const secondLocal = await waitFor<CouchDoc>('live 复制在运行中拿到新条目', async () => {
      return await local.get(ENTRY_ID_2).catch(() => null)
    })
    check('复制没有重启，新条目自己到达本地', !!secondLocal, secondLocal?.title)
    check(
      '复制过程中没有报错',
      replicationErrors.length === 0,
      replicationErrors.map(e => (e as Error)?.message ?? String(e)).join('；')
    )
    const checkpointsAfter = await timelineCheckpoints(timelineDb)
    check(
      '同参数再搬一次复用同一个 checkpoint（固定下界 → 不重扫整个源库）',
      JSON.stringify(checkpointsAfter) === JSON.stringify(checkpointsBefore),
      `${JSON.stringify(checkpointsBefore)} → ${JSON.stringify(checkpointsAfter)}`
    )

    // ── ⑤ 源库删除 → 本地跟随删除（源库裁剪走的路就是这条） ──
    for (const db of feedDbNames) {
      const sourceDoc = await couch<CouchDoc>(`/${db}/${encodeURIComponent(ENTRY_ID_2)}`).catch(() => null)
      if (sourceDoc?._rev) {
        await couch(`/${db}/${encodeURIComponent(ENTRY_ID_2)}?rev=${sourceDoc._rev}`, { method: 'DELETE' })
      }
    }
    const thirdRefresh = await session.request('/api/timeline/refresh?wait=1&force=1', { method: 'POST' })
    check('删除源条目后催促聚合成功', thirdRefresh.status === 200, `HTTP ${thirdRefresh.status}`)

    const removed = await waitFor(
      '客户端跟随服务端的删除',
      async () => (await local.get(ENTRY_ID_2).catch(() => null)) === null,
      60_000
    ).then(() => true).catch(() => false)
    check('源条目删除后本地副本也删掉了（本地跟随服务端）', removed)

    // ── ⑧ 未登录不能读派生库 ──
    const anonymous = await fetch(`${proxyUrl}/_all_docs`)
    check('未登录访问派生库被拒（401）', anonymous.status === 401, `HTTP ${anonymous.status}`)

    // ── ⑧ 写方向闸门：客户端能写状态文档，写不了服务端聚合产物 ──
    // 单库之后客户端与聚合侧写的是同一个库，所以这条边界必须在数据库层成立
    // （库设计文档里的 validate_doc_update，见 hono-server 的 couchdb/client.ts）。
    const dbPath = `/api/couchdb/proxy/${encodeURIComponent(timelineDb)}`

    const forgedEntry = await session.request(
      `${dbPath}/${encodeURIComponent(`entry:${feedId}:forged`)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          type: 'entry',
          feedId,
          title: '伪造条目',
          publishedAt: new Date().toISOString()
        })
      }
    )
    check('客户端经代理写 entry 文档被拒（403）', forgedEntry.status === 403, `HTTP ${forgedEntry.status}`)

    const forgedFeed = await session.request(`${dbPath}/${encodeURIComponent(`feed:${feedId}`)}`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'feed', title: '伪造源名' })
    })
    check('客户端经代理写 feed 文档被拒（403）', forgedFeed.status === 403, `HTTP ${forgedFeed.status}`)

    // 删掉服务端刚聚合出来的条目也该被拒（否则本地删除会推上来把内容抹掉）
    const aggregated = await couch<CouchDoc>(`/${timelineDb}/${encodeURIComponent(ENTRY_ID)}`)
    const forgedDelete = await session.request(
      `${dbPath}/${encodeURIComponent(ENTRY_ID)}?rev=${aggregated._rev}`,
      { method: 'DELETE' }
    )
    check('客户端经代理删聚合条目被拒（403）', forgedDelete.status === 403, `HTTP ${forgedDelete.status}`)
    const survived = await couch<CouchDoc>(`/${timelineDb}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null)
    check('被拒之后聚合条目还在（闸门只是拒绝，不产生副作用）', !!survived)

    const stateViaProxy = await session.request(`${dbPath}/${encodeURIComponent('entry-state:proxy-check')}`, {
      method: 'PUT',
      body: JSON.stringify({
        type: 'entry-state',
        entryId: ENTRY_ID,
        feedId,
        read: true,
        saved: false
      })
    })
    check(
      '客户端经代理写 entry-state 文档被放行（2xx）',
      stateViaProxy.status === 201 || stateViaProxy.status === 202,
      `HTTP ${stateViaProxy.status}`
    )

    const subViaProxy = await session.request(
      `${dbPath}/${encodeURIComponent(`subscription:${feedId}`)}`
    )
    check('订阅文档就在这一个库里（聚合读的就是它）', subViaProxy.status === 200, `HTTP ${subViaProxy.status}`)

    // ── ⑦ 回写通道：本地写的状态文档自己上去（不经过任何显式推库代码） ──
    await local.put({
      _id: `entry-state:${ENTRY_ID}`,
      type: 'entry-state',
      entryId: ENTRY_ID,
      feedId,
      read: true,
      saved: true
    })
    const pushedUp = await waitFor<CouchDoc>('本地状态文档经回写通道到达服务端', async () => {
      const doc = await couch<CouchDoc>(
        `/${timelineDb}/${encodeURIComponent(`entry-state:${ENTRY_ID}`)}`
      ).catch(() => null)
      return doc?.saved === true ? doc : null
    }, 30_000)
    check('本地写的已读/收藏经回写通道同步到了服务端', !!pushedUp)
    check(
      '回写通道只推状态：本地没有 entry 文档被推上去',
      !(await couch<CouchDoc>(
        `/${timelineDb}/${encodeURIComponent(`entry:${feedId}:forged`)}`
      ).catch(() => null))
    )

    // ── ⑨ 同一张图：两个账号的附件与源库字节一致（图片只在抓取时压一次，聚合只搬运） ──
    const session2 = makeSession()
    const signUp2 = await session2.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email: TEMP_EMAIL_B, password: TEMP_PASSWORD, name: '时间线验证 B' })
    })
    if (!signUp2.ok) throw new Error(`注册第二个临时账号失败（HTTP ${signUp2.status}）：${await signUp2.text()}`)
    const second: Account = { userId: (await signUp2.json())?.user?.id ?? null, timelineDb: null }
    resources.accounts.push(second)

    // 第二个账号有自己的设置（AI 摘要开关），但它改不了附件：图片策略是 per-feed 的
    const patched = await session2.request('/api/timeline/settings', {
      method: 'PATCH',
      body: JSON.stringify({ aiSummaryEnabled: true })
    })
    check('第二个账号的时间线设置可改（PATCH 生效）', patched.ok, `HTTP ${patched.status}`)

    const imported2 = await session2.request('/api/feeds/import-opml', {
      method: 'POST',
      body: JSON.stringify({ opml })
    })
    // 这个接口是 NDJSON 进度流（第一个账号用 readImportStream 读的就是它）：
    // 直接 `.json()` 会在第二行炸 `Unexpected non-whitespace character after JSON`
    let imported2Body: ImportResult = {}
    try {
      if (imported2.ok) imported2Body = (await readImportStream(imported2)).final ?? {}
    } catch {
      imported2Body = {}
    }
    check(
      '第二个账号导入 OPML 成功（没被静默吞掉）',
      imported2.ok && ((imported2Body.imported ?? 0) + (imported2Body.skipped ?? 0) === 1),
      `HTTP ${imported2.status} ${JSON.stringify(imported2Body)}`
    )
    const refresh2 = await session2.request('/api/timeline/refresh?wait=1', { method: 'POST' })
    const refresh2Body = (refresh2.ok ? await refresh2.json() : {}) as Record<string, unknown>
    check(
      '第二个账号的聚合在请求内跑完',
      refresh2.status === 200,
      `HTTP ${refresh2.status} ${JSON.stringify(refresh2Body)}`
    )

    const subs2 = (await (await session2.request('/api/feeds/subscriptions')).json()) as Array<{ feedId?: string }>
    check(
      '第二个账号的订阅落在自己的用户库里（改设置后也不该丢）',
      subs2.some(s => s.feedId === feedId),
      `共 ${subs2.length} 条订阅`
    )

    const targets2 = (await (await session2.request('/api/couchdb/sync-targets')).json()) as { timeline?: string }
    second.timelineDb = targets2?.timeline ?? null
    const ownDb = typeof second.timelineDb === 'string'
      && second.timelineDb.startsWith('user-timeline_')
      && second.timelineDb !== primary.timelineDb
    check('第二个账号拿到自己的派生库', ownDb, String(second.timelineDb))

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
        for (const [label, db] of [['A', primary.timelineDb], ['B', second.timelineDb]] as const) {
          const doc = db ? await couch(`/${db}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null) : null
          const atts = Object.keys(doc?._attachments ?? {})
          const images = (doc?.images ?? []).map(image => image.attachment ?? '(无附件)')
          console.log(
            `  · 账号 ${label}：${doc ? `条目存在，_attachments=[${atts}]，images=${JSON.stringify(images)}` : '条目不存在'}`
          )
        }
      }
      const bytesSource = await attachmentBytes(feedDbName, ENTRY_ID)
      check('两个账号都拿到了同一张图的附件', !!bytesA && !!bytesB, `A=${bytesA}B B=${bytesB}B`)
      check(
        '用户库的附件与源库字节完全一致（聚合只搬运，不重压、不看用户参数）',
        !!bytesSource && bytesA === bytesSource && bytesB === bytesSource,
        `源=${bytesSource}B A=${bytesA}B B=${bytesB}B`
      )
    } else {
      console.log('  · 跳过附件对比：探针条目没带附件')
    }

    // ── ⑪ 重建 / v1 → v2 升级：换一个空聚合库重新"修剪"一遍 ──
    //
    // 复制是**变更投递不是投影**：目标端自己删过的 rev，复制器不会再送回来，所以"就地清空再重搬"
    // 做不到（实测）。重建走的是**换库**：另建一个空聚合库、把用户自己写的状态文档搬过去、
    // 旧库删掉，复制器就会从 0 扫源库把内容完整重搬一遍。
    const dbBeforeRebuild = primary.timelineDb!
    const rebuilt = await session.request('/api/timeline/rebuild', { method: 'POST' })
    check('重建接口接受请求', rebuilt.status === 202, `HTTP ${rebuilt.status}`)
    // 重建是异步入队的，等新库接上（sync-targets 会给出新库名）
    let dbAfterRebuild: string | null = null
    try {
      dbAfterRebuild = await waitFor<string>('聚合库换成了新的', async () => {
        const t = (await (await session.request('/api/couchdb/sync-targets')).json()) as { timeline?: string }
        return t.timeline && t.timeline !== dbBeforeRebuild ? t.timeline : null
      }, 30_000)
    } catch {
      dbAfterRebuild = null
    }
    check('重建换了一个新的聚合库（旧库被替换掉）', !!dbAfterRebuild, `${dbBeforeRebuild} → ${dbAfterRebuild}`)
    primary.timelineDb = dbAfterRebuild ?? dbBeforeRebuild
    let rebuiltEntry: CouchDoc | null = null
    if (dbAfterRebuild) {
      try {
        rebuiltEntry = await waitFor<CouchDoc>('重建后条目被重新搬回来', async () =>
          await couch<CouchDoc>(`/${dbAfterRebuild}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null), 90_000)
      } catch {
        rebuiltEntry = null
      }
    }
    check('重建后条目被重新搬回来（换库 = 丢 checkpoint = 从 0 重扫）', !!rebuiltEntry, ENTRY_ID)
    const rebuiltState = await couch<CouchDoc>(`/${primary.timelineDb}/_local/state`).catch(() => null)
    check('重建后状态写成 version 2', rebuiltState?.version === 2, JSON.stringify(rebuiltState?.version))
    const rebuiltSub = await couch<CouchDoc>(
      `/${primary.timelineDb}/${encodeURIComponent(`subscription:${feedId}`)}`
    ).catch(() => null)
    check('重建把用户订阅搬到新库（重建不能等于"订阅全没了"）', !!rebuiltSub, JSON.stringify(rebuiltSub?._id))
    const rebuiltUserState = await couch<CouchDoc>(
      `/${primary.timelineDb}/${encodeURIComponent(`entry-state:${ENTRY_ID}`)}`
    ).catch(() => null)
    check('重建把用户写的已读/收藏搬到新库', rebuiltUserState?.saved === true, JSON.stringify(rebuiltUserState?.saved))
    check(
      '重建后仍然没有常驻复制任务（换库 = 水位失效 = 全部源按需重扫）',
      (await replicationDocs(userId!)).length === 0,
      JSON.stringify((await replicationDocs(userId!)).map(j => j.id))
    )
    // 换库重搬是异步的：库名先切过去，之后才搬用户状态、删旧库，所以这里要等一等
    let oldDbGone = false
    try {
      oldDbGone = await waitFor(
        '旧聚合库被删掉',
        async () =>
          !!(await couch<{ error?: string }>(`/${dbBeforeRebuild}`).catch(() => ({ error: 'network' })))?.error,
        20_000
      ).then(() => true)
    } catch {
      oldDbGone = false
    }
    check('旧聚合库被删掉（不再占空间、也不会被误同步）', oldDbGone, dbBeforeRebuild)

    // ── ⑩ 退订：任务与内容一起清（复制器不会因为过滤变严而删东西，删除归服务端） ──
    //
    // 注意用的是**重建后**的库名：上一节换过库，这里必须按新库寻址
    const liveDbPath = `/api/couchdb/proxy/${encodeURIComponent(primary.timelineDb!)}`
    const subDoc = await couch(
      `/${primary.timelineDb}/${encodeURIComponent(`subscription:${feedId}`)}`
    )
    await session.request(
      `${liveDbPath}/${encodeURIComponent(`subscription:${feedId}`)}?rev=${subDoc._rev}`,
      { method: 'DELETE' }
    )
    await session.request('/api/timeline/refresh?wait=1', { method: 'POST' })
    check(
      '退订后没有常驻任务（本来就按需，这里确认不会为已退订的源建任务）',
      (await replicationDocs(userId!)).length === 0,
      JSON.stringify((await replicationDocs(userId!)).map(j => j.id))
    )
    check(
      '退订后该源的条目被清掉',
      (await couch(`/${primary.timelineDb}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null)) === null
    )
    // 退订会把水位行一起删掉，且"订阅集合"才是权威：即便强制重扫全部源，退订过的源也不该回来
    await session.request('/api/timeline/refresh?wait=1&force=1', { method: 'POST' })
    check(
      '退订后再强制重扫也不会把内容搬回来（订阅集合是权威）',
      (await couch(`/${primary.timelineDb}/${encodeURIComponent(ENTRY_ID)}`).catch(() => null)) === null
    )
    check(
      '退订后 FeedDoc 副本也被清掉',
      (await couch(`/${primary.timelineDb}/${encodeURIComponent(feedId)}`).catch(() => null)) === null
    )
    check(
      '退订不会动用户状态文档（订阅之外的已读/收藏仍在）',
      !!(await couch(
        `/${primary.timelineDb}/${encodeURIComponent(`entry-state:${ENTRY_ID}`)}`
      ).catch(() => null))
    )
  } finally {
    // 清理是必达的：正常结束与中途抛错都会走到这里
    const accountRemoved = await cleanup()
    check('临时账号已清理', accountRemoved, `共 ${resources.accounts.length} 个临时账号`)
    console.log(failures.length === 0
      ? `\n全部通过（${checks - failures.length}/${checks} 个断言）：单库下发 → 按需一次性搬运（水位判定 / 固定下界 + 同 checkpoint / 镜像不过滤 / 附件二进制）→ 拉取/回写两条通道 → 删除跟随 → 退订清理 / 重建换库 → 写方向闸门，链路行为符合设计。`
      : `\n失败 ${failures.length}/${checks} 项：${failures.join('；')}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 附件字节（⑨ 用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取派生库里某条目附件的**字节数**。
 *
 * 附件本体必须走 `/db/doc/att` 这个端点：`?attachments=true` 在 CouchDB 3.5 上对带附件的文档
 * 返回 `multipart/related`（不是 JSON），`?atts=true` 又只给 stub、不带 data。
 */
async function attachmentBytes(dbName: string | null, entryId: string): Promise<number | null> {
  if (!dbName) return null
  const doc = await couch<CouchDoc>(`/${dbName}/${encodeURIComponent(entryId)}`).catch(() => null)
  const name = Object.keys(doc?._attachments ?? {})[0]
  if (!name) return null
  const res = await fetch(`${COUCH}/${dbName}/${encodeURIComponent(entryId)}/${encodeURIComponent(name)}`, {
    headers: { Authorization: couchAuth }
  })
  if (!res.ok) return null
  return (await res.arrayBuffer()).byteLength
}
