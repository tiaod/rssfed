const CACHE_NAME = 'rssfed-v1'
// 只预缓存静态资源，不包含动态 SSR 页面
const STATIC_ASSETS = [
  '/favicon.ico'
]

const API_CACHE_PATTERNS = [
  /^\/api\/entries/,
  /^\/api\/subscriptions/
]

self.addEventListener('install', (event) => {
  // 立即激活，不等待旧 SW 终止
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        console.warn('[SW] 部分静态资源缓存失败')
      })
    })
  )
})

self.addEventListener('activate', (event) => {
  // 立即接管所有客户端页面
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      })
    ])
  )
})

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
    return cached || new Response('Offline', { status: 503 })
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // API 请求走网络优先
  if (API_CACHE_PATTERNS.some(pattern => pattern.test(url.pathname))) {
    event.respondWith(networkFirst(request))
    return
  }

  // 导航请求走网络优先（动态 SSR 页面不适合预缓存）
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }
})
