const CACHE_NAME = 'rssfed-v1'
const STATIC_ASSETS = [
  '/',
  '/timeline',
  '/notifications',
  '/profile'
]

// API 路径模式 - 这些请求会被缓存以备离线使用
const API_CACHE_PATTERNS = [
  /^\/api\/cached-entries/,
  /^\/api\/miniflux\/entries\/\d+$/
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS)
    })
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    })
  )
})

// 网络优先，离线时回退到缓存
async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) {
      return cached
    }
    return new Response(JSON.stringify({ error: '离线模式', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// 缓存优先（用于已缓存的 API 响应）
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) {
    return cached
  }
  return networkFirst(request)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // 只处理同源请求
  if (url.origin !== self.location.origin) return

  // 静态资源或导航请求 - 缓存优先
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  // API 缓存条目 - 缓存优先
  if (API_CACHE_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    event.respondWith(cacheFirst(request))
    return
  }

  // 其他 API 请求 - 网络优先
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request))
    return
  }
})