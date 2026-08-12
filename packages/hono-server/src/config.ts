/**
 * 从环境变量解析允许的跨域来源列表。
 *
 * 优先使用 CORS_ORIGINS（逗号分隔，支持多域名），
 * 向后兼容 CORS_ORIGIN（单值）。
 */
export const allowedOrigins: string[] = (() => {
  const raw = process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? "http://localhost:3000"
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
})()

/**
 * 是否允许该跨域来源。
 *
 * 在 allowedOrigins 白名单基础上，开发场景额外允许局域网私有网段访问
 * （手机通过 http://192.168.x.x:3000 调试时 origin 为局域网 IP）。
 */
export function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true
  try {
    const host = new URL(origin).hostname
    if (host === "localhost" || host === "127.0.0.1") return true
    // 私有网段：192.168.*、10.*、172.16-31.*
    return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  } catch {
    return false
  }
}
