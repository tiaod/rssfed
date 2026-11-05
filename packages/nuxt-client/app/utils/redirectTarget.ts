/**
 * 把 URL 里的 redirect 归一成站内路径。
 *
 * 只接受以单个 "/" 开头的绝对路径：`//example.com` 与 `/\example.com` 会被浏览器
 * 当作协议相对地址跳到外站，登录成功后的回跳不能变成开放重定向。
 */
export function resolveInternalPath(raw: unknown, fallback = '/timeline'): string {
  if (typeof raw !== 'string') return fallback
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  return raw
}
