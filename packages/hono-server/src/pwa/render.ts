/**
 * PWA 图标的纯渲染：输入源图，输出指定规格的方形 PNG。
 *
 * 刻意不依赖数据库与存储层：既能被 pwa/icons.ts 复用，又能在单测里直接验证
 * 「实际输出像素 == manifest 声明的 sizes」这条最容易踩的约束。
 *
 * 三条硬约束（踩过就会「图标装上但显示异常/装不上」）：
 *   1. 输出像素必须与 manifest 声明的 sizes 严格一致 —— Chrome 会校验，不符则该图标
 *      被忽略。故 renderIconPng 结束前有一道尺寸自校验，宁可报错也不下发错尺寸。
 *   2. Apple touch 图标与 maskable 必须不透明 —— iOS 会把透明区域填黑；Android 会按
 *      自己的形状裁切，透明边和贴边图形都会被切掉，所以 maskable 要缩进中心安全区。
 *   3. SVG 源默认按 72dpi 栅格化，缩放后会发虚，需显式提高密度。
 */

import sharp from "sharp"
import { ICON_SPECS, type IconSpecKey, normalizeHexColor, DEFAULT_BACKGROUND_COLOR } from "./manifest"

/** SVG 矢量源的栅格化密度：默认 72dpi 会让 SVG 缩放后发虚，提到 300 足够清晰 */
const ICON_SVG_DENSITY = 300
/** 限制输入像素数，防止超大图耗尽内存（与 rss/entry-images.ts 保持一致） */
const MAX_INPUT_PIXELS = 40_000_000

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const

/** hex → sharp 的 rgb 对象；非法输入回退白色 */
export function parseHexColor(hex: string | null | undefined): { r: number, g: number, b: number } {
  const normalized = normalizeHexColor(hex) ?? DEFAULT_BACKGROUND_COLOR
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  }
}

/**
 * 按底色亮度选前景色（黑或白）。
 * 管理员可以把主题色配成任意 hex，浅色底配白图形会糊成一片，所以内置图标不能写死白色。
 */
export function readableForeground(background: string): string {
  const { r, g, b } = parseHexColor(background)
  // sRGB 感知亮度加权（人眼对绿最敏感、蓝最不敏感）
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? "#1f2937" : "#ffffff"
}

/**
 * 内置默认图标：圆角方底 + RSS 符号，纯几何路径（不用 <text>）。
 *
 * 刻意不用文字：容器镜像里未必装了字体，librsvg 缺字体时文字会整块不渲染，
 * 而图标的渲染失败是静默的 —— 表现只是「主屏图标空白」，极难排查。
 */
export function defaultIconSvg(background: string): string {
  const bg = normalizeHexColor(background) ?? DEFAULT_BACKGROUND_COLOR
  const fg = readableForeground(bg)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="${bg}"/>
  <g fill="none" stroke="${fg}" stroke-width="56" stroke-linecap="round">
    <path d="M144 240 A128 128 0 0 1 272 368"/>
    <path d="M144 112 A256 256 0 0 1 400 368"/>
  </g>
  <circle cx="144" cy="368" r="36" fill="${fg}"/>
</svg>`
}

/**
 * 把源图渲染成指定规格的方形 PNG。
 *
 * - `any`：保持宽高比居中，透明背景（不裁切、不变形）；
 * - `maskable`：缩进中心安全区后铺不透明底色，供 Android 自适应裁切；
 * - `opaque`（apple-touch）：铺底色并 flatten，消除透明通道。
 */
export async function renderIconPng(
  source: Buffer | string,
  specKey: IconSpecKey,
  background: string
): Promise<Buffer> {
  const spec = ICON_SPECS[specKey]
  const bg = parseHexColor(background)
  const inputOptions = { density: ICON_SVG_DENSITY, limitInputPixels: MAX_INPUT_PIXELS }

  // sharp 收到字符串会当成「文件路径」去打开，而不是 SVG 内容；内置默认图标是以
  // SVG 字符串形式传入的，必须先转成 Buffer 让它按内容嗅探格式。
  const input = typeof source === "string" ? Buffer.from(source, "utf8") : source

  let out: Buffer
  if (spec.purpose === "maskable") {
    // 图形缩到安全区（80%），再居中合成到满幅底色画布上
    const inner = Math.round(spec.size * spec.safeZone)
    const scaled = await sharp(input, inputOptions)
      .resize(inner, inner, { fit: "contain", background: TRANSPARENT })
      .png()
      .toBuffer()
    out = await sharp({ create: { width: spec.size, height: spec.size, channels: 4, background: bg } })
      .composite([{ input: scaled, gravity: "center" }])
      .png()
      .toBuffer()
  } else if (spec.opaque) {
    out = await sharp(input, inputOptions)
      .resize(spec.size, spec.size, { fit: "contain", background: bg })
      // 源图自身的透明像素也要压成底色：iOS 对透明区域一律填黑
      .flatten({ background: bg })
      .png()
      .toBuffer()
  } else {
    out = await sharp(input, inputOptions)
      .resize(spec.size, spec.size, { fit: "contain", background: TRANSPARENT })
      .png()
      .toBuffer()
  }

  // 尺寸自校验：manifest 声明与图标实际像素必须一致，否则浏览器会丢弃该图标
  const meta = await sharp(out).metadata()
  if (meta.width !== spec.size || meta.height !== spec.size) {
    throw new Error(
      `PWA 图标尺寸不符：规格 ${specKey} 期望 ${spec.size}x${spec.size}，实际 ${meta.width}x${meta.height}`
    )
  }
  return out
}
