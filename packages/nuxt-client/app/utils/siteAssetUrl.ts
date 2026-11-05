/**
 * 站点图片资源 URL 归一化。
 *
 * 上传类文件（站点 logo / 图标）默认由后端返回同源的 `/api/files/<key>`；但配置了
 * `STORAGE_S3_PUBLIC_DOMAIN` 时会是 CDN 的绝对地址。跨源图片不在 Service Worker
 * 的控制范围内（sw.js 只处理同源请求），断网时只能指望浏览器的 HTTP 缓存，
 * 而文件代理本身没有显式缓存头，因此离线表现不可靠。
 *
 * 文件代理路由（`/api/files/*`）无论如何都在反代的 `/api/*` 规则内，所以把绝对
 * 地址里的这段路径取出来、改走同源即可让 SW 缓存兜住。站点 logo 只有一张小图，
 * 放弃 CDN 直连的收益可以忽略；非文件代理的外链（管理员手填的 URL）保持原样。
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
