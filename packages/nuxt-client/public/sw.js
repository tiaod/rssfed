/**
 * RSSFed Service Worker：让应用真正离线可用。
 *
 * 三件事：
 *   1. 预缓存整个构建产物（/_nuxt/** 的 JS/CSS 等，见构建期生成的 /sw-manifest.json）；
 *   2. 页面导航走「网络优先」，断网时回退到缓存过的同路径 HTML，再回退到离线外壳 /offline；
 *   3. 少量只读接口（条目、站点配置、文件、会话）走「网络优先 + 落缓存」，断网时读缓存。
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

  // 构建产物与其它静态文件
  if (url.pathname.startsWith('/_nuxt/') || STATIC_FILE_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(request))
  }
})
