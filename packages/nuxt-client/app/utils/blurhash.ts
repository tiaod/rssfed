/**
 * BlurHash 解码（**客户端**）：把服务端写进 `images[].blurhash` 的字符串还原成一张极低频小图，
 * 作为正文图片在 `src` 换成本地附件 blob **之前**的占位（见 useEntryContent 的管线说明）。
 *
 * 与 hono-server 的 `src/images/blurhash.ts` 是同一套算法的两半：那边只编码、这边只解码。
 * 两端必须字节级互通，所以两边的用例都对齐官方 `blurhash@2.0.5` 的输出
 * （见 `app/__tests__/utils/blurhash.test.ts` 的互通用例）。
 */

/** base83 字母表（与服务端实现一致；标准 base64 之外换掉了 `/` 与 `+`，避免出现在 URL 里） */
const BASE83_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'

/**
 * 占位图解码后的**长边**上限（像素）。
 *
 * 版面位置由注入时补上的 `width`/`height` 属性占住（见 entryImagePlaceholders.ts），
 * 所以这些像素只决定"模糊底色"够不够铺满，与占位图尺寸无关 —— blurhash 本来就是低频色块，
 * 缩到 96px 再被浏览器拉大到正文宽度，看起来与按几百像素解码没有区别，而同步解码耗时
 * 从 10ms/张降到 0.4-1ms/张（实测：320px 10.4ms、96px 1.0ms、64px 0.4ms）。
 * 这一步在注入 DOM 之前同步跑，正文常常十几张图，必须便宜。
 */
const PLACEHOLDER_DEFAULT_WIDTH = 96
const PLACEHOLDER_MIN_WIDTH = 16
const PLACEHOLDER_MAX_WIDTH = 96

/**
 * 占位图的编码格式与质量。
 *
 * 必须用 JPEG：blurhash 解出来是纯渐变，PNG 无损压缩这种图反而吃亏 —— 实测同一张占位图
 * 640px 宽时 PNG 114KB / JPEG 3.5KB，320px 时 PNG 57KB / JPEG 1.5KB。正文常常十几张图，
 * 只有 JPEG 的量级（每张 1KB 上下）才能随 v-html 字符串一起塞进 DOM。
 * 占位图恒定不透明（解码时 alpha 一律 255），不需要 PNG 的透明通道。
 */
const PLACEHOLDER_MIME = 'image/jpeg'
const PLACEHOLDER_QUALITY = 0.7

/** 解不出 blurhash 时用的 1×1 透明 PNG（不显示任何东西，但也不会出现破图图标） */
export const TRANSPARENT_PIXEL
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** sRGB 分量（0-255）→ 线性光，DCT 的反变换必须在线性空间做 */
function sRGBToLinear(value: number): number {
  const v = value / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** 线性光（0-1）→ sRGB 分量（0-255），取整口径与参考实现一致 */
function linearToSRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value))
  return v <= 0.0031308
    ? Math.trunc(v * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(v, 0.4166666666666667) - 0.055) * 255 + 0.5)
}

/** 保符号的幂（AC 系数用 0.5 次幂还原） */
function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp)
}

function decode83(str: string): number {
  let value = 0
  for (const char of str) {
    const digit = BASE83_ALPHABET.indexOf(char)
    if (digit === -1) throw new Error(`非法 base83 字符：${char}`)
    value = value * 83 + digit
  }
  return value
}

/** DC 分量（18 bit）→ 线性光 RGB */
function decodeDC(value: number): [number, number, number] {
  const intR = value >> 16
  const intG = (value >> 8) & 255
  const intB = value & 255
  return [sRGBToLinear(intR), sRGBToLinear(intG), sRGBToLinear(intB)]
}

/** AC 分量 → 线性光 RGB（按最大幅值还原） */
function decodeAC(value: number, maximumValue: number): [number, number, number] {
  const quantR = Math.floor(value / (19 * 19))
  const quantG = Math.floor(value / 19) % 19
  const quantB = value % 19
  return [
    signPow((quantR - 9) / 9, 2.0) * maximumValue,
    signPow((quantG - 9) / 9, 2.0) * maximumValue,
    signPow((quantB - 9) / 9, 2.0) * maximumValue
  ]
}

/**
 * 解码成 RGBA 像素（`width * height` 个像素，4 字节/像素）。
 *
 * 字符串非法或长度与实际分量数不符时返回 null —— 文档可能来自老版本/被手改写脏，
 * 这种时候应该退化成透明占位，而不是抛错把整篇正文的渲染打断。
 */
export function decodeBlurhash(
  blurhash: string,
  width: number,
  height: number,
  punch = 1
): Uint8ClampedArray<ArrayBuffer> | null {
  try {
    if (!blurhash || blurhash.length < 6) return null
    if (width < 1 || height < 1) return null

    const sizeFlag = decode83(blurhash[0]!)
    const numY = Math.floor(sizeFlag / 9) + 1
    const numX = (sizeFlag % 9) + 1
    if (blurhash.length !== 4 + 2 * numX * numY) return null

    const quantisedMaximumValue = decode83(blurhash[1]!)
    const maximumValue = (quantisedMaximumValue + 1) / 166

    const colors: Array<[number, number, number]> = new Array(numX * numY)
    for (let i = 0; i < colors.length; i++) {
      if (i === 0) {
        colors[0] = decodeDC(decode83(blurhash.substring(2, 6)))
      } else {
        colors[i] = decodeAC(decode83(blurhash.substring(4 + i * 2, 6 + i * 2)), maximumValue * punch)
      }
    }

    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0
        let g = 0
        let b = 0
        for (let j = 0; j < numY; j++) {
          for (let i = 0; i < numX; i++) {
            const basis = Math.cos(Math.PI * x * i / width) * Math.cos(Math.PI * y * j / height)
            const color = colors[i + j * numX]!
            r += color[0] * basis
            g += color[1] * basis
            b += color[2] * basis
          }
        }
        const offset = 4 * x + y * width * 4
        pixels[offset] = linearToSRGB(r)
        pixels[offset + 1] = linearToSRGB(g)
        pixels[offset + 2] = linearToSRGB(b)
        pixels[offset + 3] = 255
      }
    }
    return pixels
  } catch {
    return null
  }
}

/** 解码结果 → data URL 的缓存（同一篇文章重渲染、上下篇来回翻都不必重算） */
const dataUrlCache = new Map<string, string>()
/** 缓存条数上限：一张占位图 1KB 上下，只留最近 100 张，避免长会话里无界增长 */
const DATA_URL_CACHE_LIMIT = 100

/**
 * 占位图的解码尺寸：按原图宽高比缩放，**长边**落在 `PLACEHOLDER_MAX_WIDTH` 以内。
 *
 * 限长边而不是限宽：竖长图（如 1200×9000）按宽度缩放会解出 96×720 那样的位图，
 * 解码耗时与像素数成正比，一张图就能吃掉十几毫秒 —— 而这一步是同步的，会推迟正文上屏。
 * 限住长边之后，单张解码像素数恒定不超过约 96×96。
 */
export function placeholderSize(width?: number, height?: number): { width: number, height: number } {
  const known = typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
  if (!known) return { width: PLACEHOLDER_DEFAULT_WIDTH, height: PLACEHOLDER_DEFAULT_WIDTH }
  const longSide = Math.max(width, height)
  const target = Math.max(PLACEHOLDER_MIN_WIDTH, Math.min(PLACEHOLDER_MAX_WIDTH, longSide))
  const scale = target / longSide
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/**
 * blurhash → data URL（JPEG，见 PLACEHOLDER_MIME 的说明）。解不出来或环境没有 canvas
 * （SSR/单测）时返回 null。
 *
 * 用 canvas 而不是手写编码器：`putImageData` + `toDataURL` 是浏览器现成的路径，
 * 几百像素的图一次只要零点几毫秒。
 */
export function blurhashToDataUrl(
  blurhash: string,
  width: number,
  height: number
): string | null {
  const key = `${blurhash}|${width}x${height}`
  const cached = dataUrlCache.get(key)
  if (cached) return cached

  // 先看有没有 canvas：SSR 下不必为一张用不到的占位图白算一遍解码
  if (typeof document === 'undefined') return null

  const pixels = decodeBlurhash(blurhash, width, height)
  if (!pixels) return null

  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
    const url = canvas.toDataURL(PLACEHOLDER_MIME, PLACEHOLDER_QUALITY)
    if (dataUrlCache.size >= DATA_URL_CACHE_LIMIT) {
      // 简单的 FIFO 淘汰：占位图是纯展示性的，淘汰谁都不影响正确性
      const oldest = dataUrlCache.keys().next().value
      if (oldest !== undefined) dataUrlCache.delete(oldest)
    }
    dataUrlCache.set(key, url)
    return url
  } catch {
    return null // canvas 被禁用（隐私模式/无 GPU）时退化为透明占位
  }
}

/**
 * 一张图在正文里的占位地址：有 blurhash 就用它，否则 1×1 透明。
 *
 * **这个函数必须是同步的**：它要在 HTML 注入 DOM 之前算好（见 useEntryContent），
 * 任何 await 都会让浏览器抢先按原始 URL 发一次请求 —— 那正是要消掉的浪费。
 */
export function blurhashPlaceholder(
  blurhash: string | undefined,
  width?: number,
  height?: number
): string {
  if (!blurhash) return TRANSPARENT_PIXEL
  const size = placeholderSize(width, height)
  return blurhashToDataUrl(blurhash, size.width, size.height) ?? TRANSPARENT_PIXEL
}
