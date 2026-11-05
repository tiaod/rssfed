/**
 * 清理 Service Worker 缓存里的会话响应。
 *
 * 会话接口（`/api/auth/get-session`）走 network-first + 落缓存，断网时读缓存，
 * 这是离线仍能显示登录状态的原因之一。但 Cache API 按 URL 存，**没有账号维度**：
 * 登出后如果不清，旧的会话 JSON 会继续留在缓存里，之后断网（或后端不可达）打开
 * 应用就会命中它，把已登出的账号显示成「已登录」。
 *
 * 只删这一条会话响应，不动构建产物与页面壳（删掉它们会永久破坏离线能力，
 * 见 public/sw.js 的 activate 逻辑）。
 */

const SESSION_REQUEST_PATH_SUFFIX = '/api/auth/get-session'

export async function clearCachedSessionResponses(): Promise<void> {
  // Cache API 只在安全上下文（HTTPS / localhost）可用；SSR 与测试环境没有
  if (typeof caches === 'undefined') return

  try {
    const names = await caches.keys()
    await Promise.all(
      names
        .filter(name => name.startsWith('rssfed-'))
        .map(async (name) => {
          const cache = await caches.open(name)
          const requests = await cache.keys()
          await Promise.all(
            requests
              .filter(request => new URL(request.url).pathname.endsWith(SESSION_REQUEST_PATH_SUFFIX))
              .map(request => cache.delete(request))
          )
        })
    )
  } catch {
    // 缓存清理失败不该阻塞登出：本地快照与内存状态已经清掉了
  }
}
