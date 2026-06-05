// 将 /api/* 请求代理到后端服务器，但排除 @nuxt/icon 的 API
// @nuxt/icon 模块注册了自己的服务端路由，需要由 Nuxt 自身处理

const ICON_API_PREFIX = '/api/_nuxt_icon'

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  const path = url.pathname

  // 只代理 /api/ 路径
  if (!path.startsWith('/api/')) return

  // 排除 @nuxt/icon 的 API，由 Nuxt 自身处理
  if (path.startsWith(ICON_API_PREFIX)) return

  const { public: { apiBaseUrl } } = useRuntimeConfig(event)

  // 构造完整的目标 URL（保留请求路径和查询参数）
  const target = `${apiBaseUrl.replace(/\/+$/, '')}${url.pathname}${url.search}`

  // 代理到后端服务器
  try {
    return await proxyRequest(event, target)
  } catch (err) {
    console.error(`[api-proxy] 代理请求失败: ${path} -> ${target}`, err)
    throw createError({ statusCode: 502, statusMessage: '后端服务不可用' })
  }
})
