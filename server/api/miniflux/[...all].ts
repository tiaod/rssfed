import { auth } from '~/lib/auth'
import { proxyRequest, getRequestURL } from 'h3'
import { posix } from 'node:path'

export default defineEventHandler(async (event) => {
  // 验证登录，从Better Auth session中获取Miniflux密钥
  const session = await auth.api.getSession({ headers: event.headers })
  const apiKey = (session?.user as { miniflux?: { minifluxApiKey: string } }).miniflux?.minifluxApiKey

  if (!session?.user || !apiKey) {
    throw createError({
      statusCode: 401,
      message: '未登录或Miniflux账号未初始化'
    })
  }

  // 拼接目标地址，去掉/api/miniflux前缀，转发到Miniflux /v1路径
  const url = getRequestURL(event)
  let path = url.pathname.replace(/^\/api\/miniflux/, '')

  // 安全处理：规范化路径，防止路径遍历攻击
  // 先解码URL编码字符，再规范化路径（自动处理所有../ ./等路径遍历序列）
  path = posix.normalize(decodeURIComponent(path))

  // 确保路径不会跳出 /v1 前缀，也没有路径遍历残留
  if (path.includes('..') || !path.startsWith('/')) {
    throw createError({
      statusCode: 400,
      message: '无效的请求路径'
    })
  }

  const targetUrl = `${process.env.MINIFLUX_BASE_URL!.replace(/\/$/, '')}/v1${path}${url.search}`

  // 自动转发所有请求，注入密钥
  return proxyRequest(event, targetUrl, {
    headers: {
      'X-Auth-Token': apiKey
    },
    fetchOptions: {
      // 禁止自动跟随重定向，防止SSRF漏洞
      redirect: 'manual'
    }
  })
})
