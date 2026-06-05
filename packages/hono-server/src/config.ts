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
