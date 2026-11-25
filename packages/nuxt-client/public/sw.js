/**
 * RSSFed Service Worker：让应用真正离线可用。
 *
 * 三件事：
 *   1. 预缓存整个构建产物（/_nuxt/** 的 JS/CSS 等，见构建期生成的 /sw-manifest.json）；
 *   2. 页面导航走「网络优先」，断网时回退到缓存过的同路径 HTML，再回退到离线外壳 /offline；
 *   3. 少量只读接口（条目、站点配置、文件、会话）走「网络优先 + 落缓存」，断网时读缓存。
 *
 * 外加一个 Background Sync 监听（见文件末尾）：断网期间页面登记了 tag，恢复联网后由浏览器
 * 唤醒它催一次服务端抓取。它不碰缓存，也不做数据复制。
 *
 * 缓存名带构建号（__BUILD_ID__ 在构建时被替换）：新版本装好并激活后旧缓存整体删除，
 * 避免旧 HTML 去引用已被删除的旧 chunk。
 *
 * 条目数据、订阅关系、已读/收藏都不依赖这里 —— 它们在浏览器 IndexedDB 的 PouchDB 里，
 * 本文件只负责让页面本身能打开。
 */

/* eslint-env serviceworker */

// 构建期由 build/generate-sw-manifest.ts 替换成时间戳；开发环境保留占位符（此时不注册 SW）
const CACHE_VERSION = '__BUILD_ID__'
const CACHE_NAME = `rssfed-${CACHE_VERSION}`

const MANIFEST_URL = '/sw-manifest.json'
/** 离线外壳：预渲染的静态页，导航断网且没有同路径缓存时返回它 */
const OFFLINE_URL = '/offline'

/** 这些路径的 GET 响应网络优先并落缓存，断网时读缓存 */
const API_CACHE_PATTERNS = [
  /^\/api\/entries/,
  // 站点品牌配置与 logo 走本服务的文件代理，改动极少
  /^\/api\/site-settings/,
  /^\/api\/files\//,
  // 会话：离线时若拿不到它，路由中间件会把用户赶去登录页，离线阅读直接失效
  /^\/api\/auth\/get-session$/,
]

/** 静态资源后缀：命中即缓存优先 */
const STATIC_FILE_RE = /\.(?:js|mjs|css|json|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|txt|xml|webmanifest)$/i

/** 逐批预缓存，避免几十个请求同时打出去 */
async function precache(cache, urls, limit = 6) {
  const queue = [...urls]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      try {
        await cache.add(url)
      } catch (e) {
        // 单个资源失败（例如某个路径没产出）不该让整个预缓存失败
        console.warn('[SW] 预缓存失败', url, e)
      }
    }
  })
  await Promise.all(workers)
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    let assets = []
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
      if (res.ok) assets = (await res.json()).assets ?? []
    } catch {
      // 拿不到清单（例如首次安装时正好断网）也要装出一个可用的 SW：
      // 后续导航仍能缓存访问过的页面，只是没有整站预缓存
    }

    const cache = await caches.open(CACHE_NAME)
    // 除构建产物外，把首页与离线外壳也装上：首页是导航入口，值得离线直达
    await precache(cache, [...assets, OFFLINE_URL, '/'])

    // 首次安装直接接管；更新时先待命，由页面提示用户后发消息激活，
    // 否则新 SW 一上来就清掉旧缓存，正在用旧版页面的标签页会加载不到旧 chunk
    if (!self.registration.active) await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter(key => key.startsWith('rssfed-') && key !== CACHE_NAME)
        .map(key => caches.delete(key)),
    )
    await self.clients.claim()
  })())
})

// 页面确认可以更新后，激活等待中的新 SW（随后页面会收到 controllerchange 并刷新）
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

/**
 * Background Sync：断网期间页面登记了这个 tag，浏览器在恢复联网后把 SW 唤醒。
 *
 * 这里只催服务端抓取（一个 202 就返回的 POST），**不**在 SW 里跑 PouchDB 复制。
 * 不是做不到（PouchDB 的 idb/http 适配器在 SW 里能跑），而是代价不值得：
 *   - 写进 IndexedDB 后页面不知道：PouchDB 的 changes 靠 localStorage 的 storage 事件唤醒，
 *     那个事件不投递给 SW。复制完了开着的列表也不会更新，除非再搭一条 BroadcastChannel 通知链；
 *   - 页面往往也开着，两边各挂一条 live 复制写同一个库的 checkpoint，PouchDB 没有跨上下文互斥；
 *   - sync 事件只给几十秒、可被随时掐断，半路停下时 waitUntil 既不 resolve 也不 reject，
 *     浏览器判断不了成败，重试语义就乱了。
 * 服务端本来就按 FETCH_INTERVAL（默认 15 分钟）调度一轮，这一下只是把用户断网期间
 * 错过的那一轮提前。用户库写好之后，页面下次打开 live 复制一次就补齐。
 *
 * 失败要**抛出去**（= 让 event.waitUntil 的 Promise reject）：那是浏览器自己的重试信号，
 * 它按指数退避再试。吞掉异常等于「这次断网白登记了」，而下次断网可能很久以后。
 */
const BACKGROUND_SYNC_TAG = 'rssfed-sync'
const BACKGROUND_SYNC_DONE = 'BACKGROUND_SYNC_DONE'
const TIMELINE_REFRESH_URL = '/api/timeline/refresh'

/**
 * 后台同步的本地日志（与 app/utils/backgroundSyncLog.ts 同一套库名/字段）。
 *
 * 为什么 SW 里要单独写一份而不是 import 那个模块：本文件是 public/ 下的静态 JS，
 * 不经过打包，`import` 一个 TS 模块在运行时根本不存在。两边共用的是**数据形状**
 * （库名、store、kind 字符串），改任一处都要同步改另一处。
 *
 * 为什么要记：Background Sync 的整个生命周期都在页面视野之外 —— 页面关着时浏览器照样会
 * 派发 sync 事件，而「到底有没有派发、POST 拿到几号状态码」用户完全无从得知。
 * 这是唯一能回答「我的后台同步到底有没有触发」的地方。
 */
const SYNC_LOG_DB = 'rssfed-background-sync-log'
const SYNC_LOG_STORE = 'events'
const SYNC_LOG_KEEP = 200

/** 追加一条同步日志。永不抛：写日志失败绝不能影响同步本身 */
async function logBackgroundSync(kind, message, data) {
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(SYNC_LOG_DB, 1)
      request.onupgradeneeded = () => {
        const opened = request.result
        if (!opened.objectStoreNames.contains(SYNC_LOG_STORE)) {
          opened.createObjectStore(SYNC_LOG_STORE, { keyPath: 'id', autoIncrement: true })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('open failed'))
      request.onblocked = () => reject(new Error('blocked'))
    })

    await new Promise((resolve, reject) => {
      const tx = db.transaction(SYNC_LOG_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'))
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'))
      tx.objectStore(SYNC_LOG_STORE).add({
        at: new Date().toISOString(),
        kind,
        message,
        ...(data ? { data } : {}),
      })
    })

    // 裁剪：超过上限就删最旧的。放在写入路径上是因为 SW 里没有可靠的定时器
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(SYNC_LOG_STORE, 'readonly')
      const request = tx.objectStore(SYNC_LOG_STORE).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('count failed'))
    })
    if (count > SYNC_LOG_KEEP) {
      await new Promise((resolve) => {
        const tx = db.transaction(SYNC_LOG_STORE, 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        const request = tx.objectStore(SYNC_LOG_STORE).openCursor()
        let deleted = 0
        const excess = count - SYNC_LOG_KEEP
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor || deleted >= excess) return
          cursor.delete()
          deleted += 1
          cursor.continue()
        }
      })
    }
    db.close()
  } catch {
    // 静默放弃
  }
}

async function runBackgroundSync(lastChance) {
  await logBackgroundSync('sync-start', lastChance ? '浏览器触发了后台同步（最后一次机会）' : '浏览器触发了后台同步')
  const res = await fetch(TIMELINE_REFRESH_URL, { method: 'POST', credentials: 'include' })
  // 401/403 是「没登录 / 登录过期」：重试多少次都是同一个结果，别让浏览器反复唤醒
  if (res.status === 401 || res.status === 403) {
    await logBackgroundSync('sync-failed', `后台同步未登录（HTTP ${res.status}），不再重试`, { status: res.status })
    return
  }
  // 其余非 2xx 一律当作这次没成功，交给浏览器退避重试
  if (!res.ok) {
    await logBackgroundSync(
      'sync-failed',
      lastChance
        ? `后台同步失败（HTTP ${res.status}），浏览器已放弃重试`
        : `后台同步失败（HTTP ${res.status}），浏览器会退避重试`,
      { status: res.status }
    )
    throw new Error(`[SW] 后台同步失败（HTTP ${res.status}）`)
  }

  await logBackgroundSync('sync-ok', '后台同步完成，服务端已抓取一轮')

  // 页面可能开着（被冻结）：告诉它服务端已经抓取过一轮，走与 online 相同的恢复路径
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const client of clients) client.postMessage({ type: BACKGROUND_SYNC_DONE })
}

self.addEventListener('sync', (event) => {
  if (event.tag !== BACKGROUND_SYNC_TAG) return
  // lastChance 为真表示浏览器已经决定「这次再失败就不再重试」。只把它作为文案传给
  // runBackgroundSync，**不在这里单独记一条** —— 那样即使这次成功了，面板上也会留下
  // 一条「浏览器将不再重试」，读起来像是失败了
  event.waitUntil(runBackgroundSync(event.lastChance === true))
})

/** 网络优先：成功就顺手更新缓存，失败读缓存；都没有则返回 503 JSON */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) void cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached
    return new Response(JSON.stringify({ offline: true, error: '当前离线且无缓存' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
}

/** 缓存优先：构建产物文件名带内容哈希，内容不会变；未命中再走网络并回填 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  // ignoreSearch：Nuxt 给预渲染页的 _payload.json 带 ?<buildId> 之类的查询串，
  // 预缓存的是不带 query 的路径，离线时要能命中
  const cached = await cache.match(request, { ignoreSearch: true })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) void cache.put(request, response.clone())
  return response
}

/**
 * 取离线外壳。
 *
 * 两个要点：
 *   1. 必须重新包一个 Response。直接返回 cache.match 的结果，响应自带 /offline 这个
 *      source URL，浏览器会当成跨 URL 重定向，地址栏直接跳到 /offline；
 *      包一层之后响应没有 source URL，导航地址保持用户请求的路径。
 *   2. 顺手把用户原本想访问的路径注入外壳，让 /offline 页面在客户端接管后自动导航过去，
 *      省掉「看到离线页 → 再点一下」这一步。
 */
async function offlineShell(requestUrl) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(OFFLINE_URL) || await cache.match(`${OFFLINE_URL}/index.html`)
  if (!cached) return null

  const html = await cached.text()
  const target = requestUrl.pathname + requestUrl.search
  const body = html.replace(
    '</head>',
    `<script>window.__OFFLINE_REQUESTED_PATH__=${JSON.stringify(target)}</script></head>`,
  )

  // body 已被重写：去掉长度与编码声明，交给浏览器按实际内容处理
  const headers = new Headers(cached.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(body, { status: 200, headers })
}

/** 导航：网络优先 → 同路径缓存 HTML → 离线外壳 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    // 缓存成功响应，供下次离线打开同一路径
    if (response.ok) void cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached

    // 没访问过这个路径：返回离线外壳。它的 HTML 在客户端接管后，
    // Nuxt 会按地址栏里的真实 URL 渲染对应路由（相关 chunk 已在预缓存里），
    // 因此通常能直接看到目标页面；渲染不出来时才会停留在外壳的提示界面
    const shell = await offlineShell(new URL(request.url))
    if (shell) return shell

    return new Response('当前处于离线状态，且这个页面还没有被缓存过。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  // 写操作必须联网：直接放行，让调用方拿到真实的失败
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === MANIFEST_URL) return

  // favicon 由后端按站点配置动态生成（见 hono-server 的 routes/favicon.ts），
  // 不能交给下面的静态后缀规则 cache-first：/favicon.ico 固定不变，命中旧缓存后
  // 管理员换图标永远不会生效。响应自身带 no-cache + ETag，放行给浏览器验证即可。
  if (url.pathname === '/favicon.ico') return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }

  if (API_CACHE_PATTERNS.some(pattern => pattern.test(url.pathname))) {
    event.respondWith(networkFirst(request))
    return
  }

  // Nuxt 用它判断是否有新部署，必须走网络，否则永远读到旧值
  if (url.pathname === '/_nuxt/builds/latest.json') {
    event.respondWith(networkFirst(request))
    return
  }

  // 其余 /api/** 一律放行，不碰缓存。
  //
  // 起因是 CouchDB 代理的**附件** URL：PouchDB 复制时先 POST _bulk_get 拿文档，
  // 附件只是 stub，再按文件名逐个 GET 拉取，形如
  //   /api/couchdb/proxy/<库名>/<docId>/feed-image.avif?rev=<rev>
  // 它以 .avif 结尾，会被下面的静态后缀规则当成「文件名带内容哈希、内容不会变」
  // 的构建产物而 cache-first。可附件名不含哈希（feed 图标固定 feed-image.avif），
  // PouchDB 靠 _attachments 的 digest 判断附件是否变化后回源拉取，却会被 SW 挡回
  // 旧缓存 —— 图标/正文图片更新后，同一次部署周期内永远拿不到新内容。
  //
  // 数据通道一律交给 PouchDB 自己管（它有自己的 checkpoint 与本地库），SW 只在
  // 上面几条明确的路径上兜离线，不猜 /api/ 下面的语义。
  if (url.pathname.startsWith('/api/')) return

  // 构建产物与其它静态文件
  if (url.pathname.startsWith('/_nuxt/') || STATIC_FILE_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(request))
  }
})
