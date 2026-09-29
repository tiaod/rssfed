/**
 * 站点 PWA 图标的取源与缓存。
 *
 * 管理员只上传一张方形图（或干脆不传，回退站点 logo，再回退内置默认图形），
 * 这里负责把「源」解析成 Buffer 并交给 pwa/render.ts 渲染成各规格 PNG。
 *
 * 之所以要服务端渲染而不是前端 canvas 画：安装时的图标抓取由浏览器进程独立发起，
 * 不经过页面 JS。渲染本身有 CPU 成本（512 图约几十毫秒）而图标会被反复抓取，
 * 故按「图标源 + 规格」做进程内 LRU 缓存；server 目前必须单副本
 * （见 deploy/Caddyfile 说明），缓存不会出现多副本不一致。
 */

import { eq } from "drizzle-orm"
import { db, attachments } from "../db"
import { storage } from "../storage"
import {
  type IconSpecKey,
  type PwaSettingsRow,
  iconSourceSignature,
  normalizeHexColor,
  DEFAULT_BACKGROUND_COLOR
} from "./manifest"
import { defaultIconSvg, renderIconPng } from "./render"

/** 外链图标源下载超时（毫秒） */
const ICON_FETCH_TIMEOUT = 5_000
/** 外链图标源大小上限：图标不该有这么大，超出基本是误配或攻击 */
const MAX_ICON_SOURCE_BYTES = 5 * 1024 * 1024
/** 进程内图标缓存条目上限（每条约几十 KB，32 条足够覆盖 4 种规格 × 少量配置变更） */
const MAX_CACHE_ENTRIES = 32

/** 从本服务的文件代理路径反解存储 key（`/api/files/<key>`，可带域名前缀） */
export function extractStorageKeyFromUrl(url: string): string | null {
  const marker = "/api/files/"
  const index = url.indexOf(marker)
  if (index === -1) return null
  // 只看路径部分，丢掉 query / hash
  const rest = url.slice(index + marker.length).split(/[?#]/)[0]!
  try {
    const key = decodeURIComponent(rest)
    return key || null
  } catch {
    return null
  }
}

/** 按附件 id 读回原图（附件行拿 storageKey，再取对象） */
async function readAttachment(attachmentId: string | null): Promise<Buffer | null> {
  if (!attachmentId) return null
  try {
    const [row] = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1)
    if (!row?.storageKey) return null
    return await storage.read(row.storageKey)
  } catch (error) {
    console.warn(`[PWA] 读取图标附件失败: ${attachmentId}`, error)
    return null
  }
}

/**
 * 读回 URL 指向的图标源。
 *
 * 本服务自己的文件代理 URL 直接走存储层读取，不做服务端自请求：容器内未必能解析
 * 对外域名（PUBLIC_URL 常是公网地址），自请求会稳定失败。
 * 手填的外链才真正发起远程请求，并限制协议、超时与体积。
 */
async function readRemote(url: string | null): Promise<Buffer | null> {
  if (!url) return null

  const key = extractStorageKeyFromUrl(url)
  if (key) {
    try {
      return await storage.read(key)
    } catch (error) {
      console.warn(`[PWA] 按文件代理路径读取图标失败，回退远程请求: ${key}`, error)
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null

  try {
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT),
      redirect: "follow"
    })
    if (!response.ok) return null
    const declared = Number(response.headers.get("content-length") ?? "0")
    if (declared > MAX_ICON_SOURCE_BYTES) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.length > MAX_ICON_SOURCE_BYTES ? null : buffer
  } catch (error) {
    console.warn(`[PWA] 下载外链图标失败: ${url}`, error)
    return null
  }
}

/** 图标源优先级：独立方形图标（附件 → URL）→ 站点 logo（附件 → URL）→ 内置默认图形 */
async function loadIconSource(row: PwaSettingsRow): Promise<Buffer | string> {
  const fromAttachment = await readAttachment(row.pwaIconAttachmentId)
    ?? await readAttachment(row.logoAttachmentId)
  if (fromAttachment) return fromAttachment

  const fromUrl = await readRemote(row.pwaIconUrl) ?? await readRemote(row.logoUrl)
  if (fromUrl) return fromUrl

  return defaultIconSvg(iconBackground(row))
}

/** 图标底色：PWA 背景色 → 主题主色 → 内置白 */
function iconBackground(row: PwaSettingsRow): string {
  return normalizeHexColor(row.pwaBackgroundColor)
    ?? normalizeHexColor(row.primaryColor)
    ?? DEFAULT_BACKGROUND_COLOR
}

// ── 进程内 LRU 缓存 ────────────────────────────────────────────────────────
// Map 保持插入序：命中后删了重插即完成「最近使用」提升，超出上限淘汰最旧的一条。
const iconCache = new Map<string, Buffer>()

function cacheGet(key: string): Buffer | undefined {
  const hit = iconCache.get(key)
  if (!hit) return undefined
  iconCache.delete(key)
  iconCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: Buffer): void {
  if (iconCache.has(key)) iconCache.delete(key)
  iconCache.set(key, value)
  while (iconCache.size > MAX_CACHE_ENTRIES) {
    const oldest = iconCache.keys().next().value
    if (oldest === undefined) break
    iconCache.delete(oldest)
  }
}

/** 仅供测试：清空缓存，避免用例之间互相污染 */
export function clearIconCache(): void {
  iconCache.clear()
}

/**
 * 取站点图标（带缓存）。源图损坏 / 下载失败 / 渲染异常时一律回退内置默认图形，
 * 保证「装得上」这件事不被一张坏图搞崩。
 */
export async function getPwaIcon(row: PwaSettingsRow, specKey: IconSpecKey): Promise<Buffer> {
  const background = iconBackground(row)
  const cacheKey = `${iconSourceSignature(row)}|${specKey}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  let source: Buffer | string
  try {
    source = await loadIconSource(row)
  } catch (error) {
    console.warn("[PWA] 图标源解析失败，回退内置默认图标", error)
    source = defaultIconSvg(background)
  }

  let rendered: Buffer
  try {
    rendered = await renderIconPng(source, specKey, background)
  } catch (error) {
    // 只有「非默认源」才值得重试一次：默认 SVG 渲染失败说明是 sharp/SVG 层面的问题，
    // 再试一遍没有意义，直接抛出由路由层返回 500。
    if (typeof source === "string") throw error
    console.warn("[PWA] 站点图标渲染失败，回退内置默认图标", error)
    rendered = await renderIconPng(defaultIconSvg(background), specKey, background)
  }

  cacheSet(cacheKey, rendered)
  return rendered
}
