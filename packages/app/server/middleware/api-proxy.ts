// 将 /api/* 请求代理到后端服务器，但排除 @nuxt/icon 的 API
// @nuxt/icon 模块注册了自己的服务端路由，需要由 Nuxt 自身处理

const ICON_API_PREFIX = '/api/_nuxt_icon'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // 只代理 /api/ 路径
  if (!path.startsWith('/api/')) return

  // 排除 @nuxt/icon 的 API，由 Nuxt 自身处理
  if (path.startsWith(ICON_API_PREFIX)) return

  const { public: { apiBaseUrl } } = useRuntimeConfig(event)

  // 代理到后端服务器
  try {
    return await proxyRequest(event, apiBaseUrl)
  } catch (err) {
    console.error(`[api-proxy] 代理请求失败: ${path} -> ${apiBaseUrl}`, err)
    throw createError({ statusCode: 502, statusMessage: '后端服务不可用' })
  }
})
