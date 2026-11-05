/**
 * 动态 favicon（ICO）：把当前站点图标打包成浏览器标签页 / 书签栏用的多尺寸 ICO。
 *
 * 为什么还要 ICO：`/favicon.ico` 是浏览器与不少第三方（RSS 阅读器、链接预览、
 * 书签同步）固定探测的根路径，它们不一定解析 HTML 里的 `<link rel="icon">`。
 * 只提供 PNG 时这些请求会落到构建产物里的静态图标，管理员换图标后不会跟随。
 *
 * 复用 `getPwaIcon` 的 192 PNG：普通图标已经按「上传方形图标 → 站点 Logo → 内置
 * 图形」的回退链渲染好，favicon 只是把它缩成 ICO 需要的几个尺寸，不再重复实现
 * 取源与回退逻辑。
 */

import sharp from "sharp"
import pngToIco from "png-to-ico"
import { iconSourceSignature, type PwaSettingsRow } from "./manifest"
import { getPwaIcon } from "./icons"

/** ICO 内打包的尺寸：16/32 给标签页与书签栏，48 给高分屏与旧版 Windows 菜单 */
const ICO_SIZES = [16, 32, 48] as const
/** 进程内缓存条目上限：每条约十几 KB，16 条足够覆盖少量配置变更 */
const MAX_CACHE_ENTRIES = 16

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const

// 与 icons.ts 相同的 LRU 策略：命中后删了重插提升为最近使用，超出上限淘汰最旧。
const icoCache = new Map<string, Buffer>()

function cacheGet(key: string): Buffer | undefined {
  const hit = icoCache.get(key)
  if (!hit) return undefined
  icoCache.delete(key)
  icoCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: Buffer): void {
  if (icoCache.has(key)) icoCache.delete(key)
  icoCache.set(key, value)
  while (icoCache.size > MAX_CACHE_ENTRIES) {
    const oldest = icoCache.keys().next().value
    if (oldest === undefined) break
    icoCache.delete(oldest)
  }
}

/** 仅供测试：清空缓存，避免用例之间互相污染 */
export function clearFaviconCache(): void {
  icoCache.clear()
}

/**
 * 生成多尺寸 ICO。
 *
 * 缓存键只取「图标源 + 底色」签名（与 icons.ts 的 192 PNG 缓存键同源）：favicon 的
 * 内容只取决于实际图标，与站点标题等配置无关，没必要因为它们变化而重新编码。
 */
export async function getFaviconIco(row: PwaSettingsRow): Promise<Buffer> {
  const cacheKey = `ico|${iconSourceSignature(row)}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const base = await getPwaIcon(row, "192")
  const pngs = await Promise.all(
    ICO_SIZES.map(size =>
      sharp(base)
        .resize(size, size, { fit: "contain", background: TRANSPARENT })
        .png()
        .toBuffer()
    )
  )

  const ico = await pngToIco(pngs)
  cacheSet(cacheKey, ico)
  return ico
}
