import sharp from "sharp"
import { MAX_INPUT_PIXELS } from "./fetch"

/**
 * Wolt BlurHash 编码（**服务端**）：抓取图片时算一次，跟着 entry 的 `images[]` 落库；
 * 客户端在正文图换成本地 blob 之前先用它当占位（见 nuxt-client 的 `utils/blurhash.ts`）。
 *
 * **为什么不直接依赖 npm 的 `blurhash`**：算法本体只是 DCT + base83 编解码，而两端各只用一半
 * （服务端只编码、客户端只解码）。这里按参考实现移植，并用官方 2.0.5 的输出做逐字符对齐的
 * fixtures（见 `__tests__/blurhash.test.ts`）—— 既不多一个运行时依赖，也不靠"看着像"。
 *
 * 两端必须**字节级互通**这点不能含糊：编码端写进库的字符串，解码端要能解出同一张画。
 */

/** base83 字母表（与参考实现一致：标准 base64 之外换掉了 `/` 与 `+`，避免出现在 URL 里） */
const BASE83_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"

/** sRGB 分量（0-255）→ 线性光（0-1）。DCT 必须在线性空间做，否则暗部会有色偏 */
function sRGBToLinear(value: number): number {
  const v = value / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** 线性光（0-1）→ sRGB 分量（0-255），与参考实现的取整口径一致（+0.5 后 trunc） */
function linearToSRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value))
  return v <= 0.0031308
    ? Math.trunc(v * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(v, 0.4166666666666667) - 0.055) * 255 + 0.5)
}

/** 保符号的幂：AC 系数用 0.5 次幂压缩动态范围（负系数不能丢符号） */
function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp)
}

/** base83 解码（本模块只在测试里校验时用得上，保留完整实现便于对照） */
export function decode83(str: string): number {
  let value = 0
  for (const char of str) {
    const digit = BASE83_ALPHABET.indexOf(char)
    if (digit === -1) throw new Error(`非法 base83 字符：${char}`)
    value = value * 83 + digit
  }
  return value
}

/** base83 编码：定长（高位补 0），与参考实现的 encode83 一致 */
export function encode83(value: number, length: number): string {
  let result = ""
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value) / Math.pow(83, length - i) % 83
    result += BASE83_ALPHABET[Math.floor(digit)]
  }
  return result
}

/** 各分量之间的量化上界（参考实现的 19 档） */
const QUANT_MAX = 18
/** AC 量化的压缩系数（参考实现固定 166） */
const AC_QUANT_SCALE = 166

/**
 * 一个 DCT 分量在某条基函数上的加权和（RGB 三通道各自累加，alpha 忽略）。
 *
 * `pixels` 是 RGBA 交错缓冲；坐标为 (x, y)，步长固定 4 字节。
 */
function multiplyBasis(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  basisFor: (x: number, y: number) => number
): [number, number, number] {
  let sumR = 0
  let sumG = 0
  let sumB = 0
  const bytesPerRow = width * 4
  for (let x = 0; x < width; x++) {
    const columnOffset = 4 * x
    for (let y = 0; y < height; y++) {
      const offset = columnOffset + y * bytesPerRow
      const basis = basisFor(x, y)
      sumR += basis * sRGBToLinear(pixels[offset]!)
      sumG += basis * sRGBToLinear(pixels[offset + 1]!)
      sumB += basis * sRGBToLinear(pixels[offset + 2]!)
    }
  }
  const scale = 1 / (width * height)
  return [sumR * scale, sumG * scale, sumB * scale]
}

/** DC 分量编码：线性光转回 sRGB 后压进 18 bit（每通道 6 bit） */
function encodeDC(linear: [number, number, number]): number {
  const r = linearToSRGB(linear[0])
  const g = linearToSRGB(linear[1])
  const b = linearToSRGB(linear[2])
  return (r << 16) + (g << 8) + b
}

/** AC 分量编码：按最大幅值归一化后量化到 19×19×19 */
function encodeAC(linear: [number, number, number], maximumValue: number): number {
  const quant = (channel: number): number => Math.max(
    0,
    Math.min(QUANT_MAX, Math.floor(signPow(channel / maximumValue, 0.5) * 9 + 9.5))
  )
  return quant(linear[0]) * 19 * 19 + quant(linear[1]) * 19 + quant(linear[2])
}

/**
 * 把 RGBA 像素编码成 BlurHash 字符串。
 *
 * 分量数默认 4×3（参考实现的默认值）：再多只是让占位图更"清晰"，而占位图本来就是模糊的，
 * 反而增加字符串长度与解码耗时 —— 每个分量要在客户端做一次 width×height 的余弦累加。
 *
 * @param pixels RGBA 交错缓冲，长度必须等于 `width * height * 4`
 */
export function encodeBlurhash(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  componentX = 4,
  componentY = 3
): string {
  if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
    throw new Error("BlurHash 分量数必须在 1-9 之间")
  }
  if (width < 1 || height < 1 || pixels.length !== width * height * 4) {
    throw new Error("像素缓冲长度必须等于 width * height * 4")
  }

  // 逐分量做 DCT：DC（0,0）权重 1，其余 2（参考实现的约定）
  const colors: Array<[number, number, number]> = []
  for (let y = 0; y < componentY; y++) {
    for (let x = 0; x < componentX; x++) {
      const normalisation = x === 0 && y === 0 ? 1 : 2
      colors.push(multiplyBasis(pixels, width, height, (px, py) =>
        normalisation * Math.cos(Math.PI * x * px / width) * Math.cos(Math.PI * y * py / height)
      ))
    }
  }

  const dc = colors[0]!
  const ac = colors.slice(1)

  const sizeFlag = (componentX - 1) + (componentY - 1) * 9
  let blurhash = encode83(sizeFlag, 1)

  let maximumValue: number
  if (ac.length > 0) {
    let actualMaximumValue = 0
    for (const color of ac) {
      actualMaximumValue = Math.max(actualMaximumValue, color[0], color[1], color[2])
    }
    const quantisedMaximumValue = Math.floor(
      Math.max(0, Math.min(82, Math.floor(actualMaximumValue * AC_QUANT_SCALE - 0.5)))
    )
    maximumValue = (quantisedMaximumValue + 1) / AC_QUANT_SCALE
    blurhash += encode83(quantisedMaximumValue, 1)
  } else {
    maximumValue = 1
    blurhash += encode83(0, 1)
  }

  blurhash += encode83(encodeDC(dc), 4)
  for (const color of ac) blurhash += encode83(encodeAC(color, maximumValue), 2)

  return blurhash
}

/** 解码前的边长上限：BlurHash 只承载极低频信息，32px 足够（也决定了编码耗时上限） */
const BLURHASH_DECODE_SIZE = 32

/**
 * 从一张**已压缩**的图片字节算出 BlurHash；解不出来返回 null（占位图退化为透明像素）。
 *
 * 只解码头部信息、不做完整尺寸解码：先用 sharp 缩到 32px 以内再取原始像素，
 * 于是成本与源图大小无关（1200px 的 AVIF 也只解一次、缩一次）。
 */
export async function blurhashFromImage(
  buffer: Buffer,
  opts: { componentX?: number, componentY?: number } = {}
): Promise<string | null> {
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({
        width: BLURHASH_DECODE_SIZE,
        height: BLURHASH_DECODE_SIZE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return encodeBlurhash(data, info.width, info.height, opts.componentX ?? 4, opts.componentY ?? 3)
  } catch {
    return null // 非图片 / 损坏数据：没有占位图也能渲染，不该让抓取失败
  }
}
