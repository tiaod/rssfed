import { resolveApiBase } from './apiBase'

/**
 * Bot 的联邦地址：`@用户名@域名`（仅用于展示 / 复制）。
 *
 * 域名取自后端 API 基址 —— Bot 的 ActivityPub actor 就挂在后端域名上；经 resolveApiBase
 * 处理，手机等局域网设备访问时显示的也是当前实际可达的域名，而不是写死的 localhost。
 */
export function botHandle(preferredUsername: string, apiBaseUrl: string): string {
  const base = resolveApiBase(apiBaseUrl ?? '')
  let host: string
  try {
    // 只取 host（含端口）：基址带路径 /、/api 之类的后缀时别把路径拼进联邦地址
    host = new URL(base).host
  } catch {
    // 基址不是绝对地址（少见）：退回按原样去协议
    host = base.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  }
  return `@${preferredUsername}@${host}`
}
