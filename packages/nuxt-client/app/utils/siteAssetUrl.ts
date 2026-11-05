/**
 * 站点图片资源 URL 归一化。
 *
 * 现行约定：服务端下发 logo / PWA 图标时已改写成同源 `/api/files/*`（见
 * hono-server 的 routes/site-settings.ts），因此在线路径通常无需再处理。
 *
 * 这里保留一层兜底，处理两类历史数据：
 *   1. localStorage 快照（utils/siteSettingsSnapshot）里旧版本存下的绝对地址 ——
 *      离线首屏优先读快照，此时请求还没回来；
 *   2. 早于该约定部署的公开配置响应（浏览器 / Service Worker 里仍有旧缓存）。
 *
 * 跨源图片不在 Service Worker 的控制范围内（sw.js 只处理同源请求），断网时只能
 * 指望浏览器的 HTTP 缓存，而文件代理本身没有显式缓存头，离线表现不可靠；文件代理
 * 路由（`/api/files/*`）无论前后端分端口还是反代都在 `/api/*` 规则内，所以把绝对
 * 地址里的这段路径取出来、改走同源即可让 SW 缓存兜住。非文件代理的外链（管理员
 * 手填的 URL）保持原样。
 */

const FILE_PROXY_MARKER = '/api/files/'

/** 取同源文件代理路径；不是 `/api/files/` 资源时原样返回 */
export function sameOriginAssetUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const value = url.trim()
  if (!value) return null

  const markerIndex = value.indexOf(FILE_PROXY_MARKER)
  if (markerIndex === -1) return value

  // 只处理「绝对地址 / 协议相对地址」；已经是相对路径的直接用
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//')
  if (!isAbsolute) return value
  return value.slice(markerIndex)
}
