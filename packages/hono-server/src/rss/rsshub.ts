/**
 * 本地自建 RSSHub 支持。
 *
 * 用户常以公共实例地址（如 https://rsshub.app/smzdm/haowen/1）订阅 RSS 源，
 * 但实际抓取时希望打到本地自建的 RSSHub。此模块在「抓取时」把公共实例主机
 * 改写为本地地址，从而无需改动已存储的订阅 URL 与 feedId。
 *
 * 配置：环境变量 RSSHUB_BASE_URL（如 http://localhost:1200），留空则不改写。
 */

/** 订阅源中常见的公共 RSSHub 实例主机（改写目标） */
const PUBLIC_RSSHUB_HOST = "rsshub.app"

/**
 * 本地自建 RSSHub 基础地址（去掉末尾斜杠）；未配置时为空字符串，表示不改写。
 * 在服务启动时从环境变量读取一次。
 */
export const rssHubBaseUrl = (process.env.RSSHUB_BASE_URL ?? "").replace(/\/+$/, "")

/**
 * 将订阅 URL 中的公共 RSSHub 主机（rsshub.app）改写为本地自建地址。
 *
 * - 未配置 RSSHUB_BASE_URL，或 URL 主机不是 rsshub.app，或 URL 非法时返回原样；
 * - 改写保留原 URL 的路径、查询串与 hash，仅替换协议/主机/端口，并拼接
 *   本地基础地址可能自带的子路径（如部署在反代子目录下）。
 */
export function rewriteRssHubUrl(url: string): string {
  if (!rssHubBaseUrl) return url

  let remote: URL
  let base: URL
  try {
    remote = new URL(url)
    base = new URL(rssHubBaseUrl)
  } catch {
    return url
  }

  // 只改写公共 RSSHub 实例，其它 URL 不受影响
  if (remote.hostname !== PUBLIC_RSSHUB_HOST) return url

  // 以原 URL 为基础的副本，替换协议/主机/端口为本地地址
  const rewritten = new URL(remote.toString())
  rewritten.protocol = base.protocol
  rewritten.hostname = base.hostname
  rewritten.port = base.port
  // 本地基础地址的路径（若有）作为前缀叠加到原 URL 路径之前
  const basePath = base.pathname.replace(/\/+$/, "")
  rewritten.pathname = `${basePath}${remote.pathname}`
  return rewritten.toString()
}
