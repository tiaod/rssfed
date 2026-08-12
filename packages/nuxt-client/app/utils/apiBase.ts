/**
 * 解析后端 API 基础地址。
 *
 * 开发配置里 apiBaseUrl 是 http://localhost:3001——本机访问没问题；
 * 但手机等局域网设备访问时，页面 JS 里的 localhost 指向设备自身，
 * 需要把 host 替换为访问页面的 hostname（同 IP、不同端口）。
 */
export function resolveApiBase(configured: string): string {
  const base = configured.replace(/\/+$/, '')
  if (typeof window === 'undefined') return base
  try {
    const url = new URL(base)
    // 本机访问（localhost/127.0.0.1）保持不变；其余（局域网 IP）替换 host
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = window.location.hostname
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    return base
  }
}
