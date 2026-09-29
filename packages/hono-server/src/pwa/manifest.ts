/**
 * PWA Web App Manifest 的动态构造。
 *
 * 为什么由服务端渲染而不是前端拼：`<link rel="manifest">` 必须是 HTML 里静态存在的
 * 同源 URL —— iOS Safari 不认页面加载后 JS 注入的 manifest，blob:/data: URL 也不被接受，
 * 且安装时的图标抓取由浏览器进程独立发起，不经过页面 JS。所以这里是「URL 固定、
 * 内容按站点配置动态生成」。
 *
 * 本文件只做纯数据变换（便于单测），不碰数据库与文件系统。
 * 图标规格表 ICON_SPECS 是唯一真源：manifest 里声明的 sizes 与图标路由实际输出的
 * 像素必须由同一份定义推导 —— Chrome 会校验二者，声明 512 却输出别的尺寸会导致
 * 该图标被直接忽略、进而无法安装。
 */

import { createHash } from "node:crypto"

/** site_settings 行里参与 PWA 渲染的字段 */
export interface PwaSettingsRow {
  siteTitle: string | null
  description: string | null
  primaryColor: string | null
  pwaShortName: string | null
  pwaDisplay: string | null
  pwaThemeColor: string | null
  pwaBackgroundColor: string | null
  pwaIconUrl: string | null
  pwaIconAttachmentId: string | null
  logoUrl: string | null
  logoAttachmentId: string | null
  updatedAt: Date
}

/** 全空配置下的兜底品牌（与 app.vue 的默认标题一致） */
export const DEFAULT_APP_NAME = 'RSSFed'
export const DEFAULT_APP_DESCRIPTION = '支持 ActivityPub 的 RSS 阅读器'
/** 与 app.config.ts 的 primary: 'green' + main.css 的 green-500 对齐 */
export const DEFAULT_THEME_COLOR = '#00c16a'
/** 无主题色时的启动画面底色：白色最稳，不会出现大面积品牌色闪屏 */
export const DEFAULT_BACKGROUND_COLOR = '#ffffff'

/** 主屏幕短名的兜底截断长度：siteTitle 最长 200 字符，直接当 short_name 会被系统截得很难看 */
const SHORT_NAME_MAX = 12
/**
 * 显式配置的短名放宽一些，但仍设上限防止塞进整段话。
 * 导出给 routes/site-settings.ts 的写入校验用：读写两侧共用同一个上限，
 * 否则「按旧上限能存进去、读取时被截断」这种不一致只能靠人记住。
 */
export const SHORT_NAME_MAX_EXPLICIT = 30

/** manifest 的 display 合法取值（写入时已校验，读取时再防御一次） */
export const DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'browser'] as const
export type DisplayMode = (typeof DISPLAY_MODES)[number]

/** 图标路由的路径前缀（挂在公开的 /api/site-settings 下，反代无需额外放行） */
export const ICON_PATH_PREFIX = '/api/site-settings/icon'
export const MANIFEST_PATH = '/api/site-settings/manifest.webmanifest'

/**
 * 图标规格表 —— manifest 声明与图标路由输出的共同真源。
 *
 * - `any`：普通图标，保持原始宽高比居中，透明背景；
 * - `maskable`：Android 自适应图标，图形须落在中心 80% 安全区内，且必须是不透明底，
 *   否则系统按自己的形状裁切时会把边缘切掉（不能拿普通方图直接复用）；
 * - `apple-touch-*`：iOS 主屏幕图标。iOS 不读 manifest 的 icons，只认
 *   `<link rel="apple-touch-icon">`，且不支持透明（透明区域会被填黑），故强制不透明底。
 */
export const ICON_SPECS = {
  '192': { size: 192, purpose: 'any', opaque: false, safeZone: 1 },
  '512': { size: 512, purpose: 'any', opaque: false, safeZone: 1 },
  'maskable-512': { size: 512, purpose: 'maskable', opaque: true, safeZone: 0.8 },
  'apple-touch-180': { size: 180, purpose: 'any', opaque: true, safeZone: 1 }
} as const

export type IconSpecKey = keyof typeof ICON_SPECS

/** 允许通过 URL 请求的规格 key（供路由校验，拒绝任意值） */
export function isIconSpecKey(value: string): value is IconSpecKey {
  return Object.hasOwn(ICON_SPECS, value)
}

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * 归一化为 #rrggbb 小写；非法或空值返回 null（调用方据此回退默认色）。
 * 与 routes/site-settings.ts 的写入校验、前端 utils/siteTheme.ts 保持一致。
 */
export function normalizeHexColor(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!HEX_COLOR_RE.test(value)) return null
  if (value.length === 7) return value.toLowerCase()
  const [r, g, b] = value.slice(1).toLowerCase()
  return `#${r}${r}${g}${g}${b}${b}`
}

/** 截断到指定字符数（按 Unicode 码点切，避免把 emoji / 代理对劈成半个字符） */
function truncate(value: string, max: number): string {
  const chars = [...value]
  return chars.length <= max ? value : chars.slice(0, max).join('')
}

/**
 * 图标来源签名：参与缓存键。
 * 换了图标（附件 id 变化）或换了底色都要重新渲染，不能沿用旧缓存。
 */
export function iconSourceSignature(row: PwaSettingsRow): string {
  return [
    // 独立方形图标优先，其次站点 logo，都没有则是内置默认图形
    row.pwaIconAttachmentId ?? `url:${row.pwaIconUrl ?? ''}`,
    row.logoAttachmentId ?? `url:${row.logoUrl ?? ''}`,
    normalizeHexColor(row.pwaBackgroundColor) ?? normalizeHexColor(row.primaryColor) ?? DEFAULT_BACKGROUND_COLOR
  ].join('|')
}

/**
 * 配置版本号：写进 manifest 的图标 URL（`?v=`）与 ETag。
 * 站点配置一变，版本号就变 —— 图标 URL 随之变化，绕开浏览器对旧图标的长期缓存；
 * 同时让 manifest 自身可用条件请求判定是否需要重新下发。
 *
 * 用「更新时间戳 + 图标源签名」的哈希而非直接拼接原始串：图标 URL 可能很长且含
 * 任意字符，清理后截断会让不同配置产生相同前缀（版本号碰撞 = 图标永远不刷新）。
 * 时间戳放前面是为了排障时一眼看出配置新旧。
 */
export function settingsVersion(row: PwaSettingsRow): string {
  const stamp = row.updatedAt instanceof Date && !Number.isNaN(row.updatedAt.getTime())
    ? row.updatedAt.getTime()
    : 0
  const digest = createHash("sha1").update(`${stamp}|${iconSourceSignature(row)}`).digest("hex")
  return `${stamp}-${digest.slice(0, 12)}`
}

export interface ResolvedPwaConfig {
  name: string
  shortName: string
  description: string
  themeColor: string
  backgroundColor: string
  display: DisplayMode
  version: string
  /** 是否配置了独立的方形图标（否则图标路由回退到站点 logo 裁剪） */
  hasDedicatedIcon: boolean
  /** 图标源：附件 key 或外链 URL；都没有则由图标路由渲染内置默认图形 */
  iconSource: { attachmentId: string | null, url: string | null }
}

/**
 * 把站点配置归一化为「所有字段都有确定值」的 PWA 配置。
 * 每个字段的优先级：PWA 专项配置 → 站点通用品牌配置 → 内置默认。
 */
export function resolvePwaConfig(row: PwaSettingsRow): ResolvedPwaConfig {
  const siteTitle = row.siteTitle?.trim() || ''
  const name = siteTitle || DEFAULT_APP_NAME

  // 短名优先取显式配置；回退 siteTitle 时收紧截断长度
  const explicitShort = row.pwaShortName?.trim() || ''
  const shortName = explicitShort
    ? truncate(explicitShort, SHORT_NAME_MAX_EXPLICIT)
    : truncate(name, SHORT_NAME_MAX)

  const primary = normalizeHexColor(row.primaryColor)

  // display 非法值一律回退 standalone：宁可独立窗口，也不要因脏数据退化成带地址栏
  const display = (DISPLAY_MODES as readonly string[]).includes(row.pwaDisplay ?? '')
    ? (row.pwaDisplay as DisplayMode)
    : 'standalone'

  // 有独立方形图标就用它，否则用站点 logo 裁剪
  const hasDedicatedIcon = Boolean(row.pwaIconUrl)

  return {
    name,
    shortName,
    description: row.description?.trim() || DEFAULT_APP_DESCRIPTION,
    // theme_color 没有 primaryColor 时用内置绿；不像 background 那样用白色 ——
    // 白色主题色会让 Android 状态栏在浅色页面上失去对比
    themeColor: normalizeHexColor(row.pwaThemeColor) ?? primary ?? DEFAULT_THEME_COLOR,
    backgroundColor: normalizeHexColor(row.pwaBackgroundColor) ?? primary ?? DEFAULT_BACKGROUND_COLOR,
    display,
    version: settingsVersion(row),
    hasDedicatedIcon,
    iconSource: {
      attachmentId: row.pwaIconAttachmentId,
      url: row.pwaIconUrl
    }
  }
}

/** manifest 的 icons 条目 */
interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose: string
}

/** Web App Manifest 的最小可用结构（只列本站在用的字段） */
export interface WebAppManifest {
  id: string
  name: string
  short_name: string
  description: string
  start_url: string
  scope: string
  display: DisplayMode
  theme_color: string
  background_color: string
  lang: string
  dir: string
  icons: ManifestIcon[]
}

/**
 * 组装 manifest。
 *
 * 图标 URL 用绝对路径（而非相对 manifest 的路径），并带 `?v=<版本>`：
 * 相对路径虽也能解析，但 manifest 一旦换位置就会静默失效；带版本则是让配置改动
 * 立刻生效的关键（图标路由对带 v 的请求回 immutable 长缓存，不带 v 的只短缓存）。
 *
 * 不输出 maskable 之外的 purpose 组合：`any maskable` 是常见误区 ——
 * 同一张图同时声明两种用途会让 Android 把它当 maskable 裁切，普通图标就会显得过小。
 */
export function buildManifest(config: ResolvedPwaConfig): WebAppManifest {
  const v = encodeURIComponent(config.version)
  const icons = (Object.keys(ICON_SPECS) as IconSpecKey[])
    // apple-touch 是 iOS 专用 link，不属于 manifest 的 icons
    .filter(key => !key.startsWith('apple-touch'))
    .map((key): ManifestIcon => {
      const spec = ICON_SPECS[key]
      return {
        src: `${ICON_PATH_PREFIX}/${key}.png?v=${v}`,
        sizes: `${spec.size}x${spec.size}`,
        type: 'image/png',
        purpose: spec.purpose
      }
    })

  return {
    id: '/',
    name: config.name,
    short_name: config.shortName,
    description: config.description,
    start_url: '/',
    scope: '/',
    display: config.display,
    theme_color: config.themeColor,
    background_color: config.backgroundColor,
    lang: 'zh-CN',
    dir: 'ltr',
    icons
  }
}

/** iOS 主屏幕图标尺寸（<link rel="apple-touch-icon"> 用） */
export const APPLE_TOUCH_ICON_SIZE = ICON_SPECS['apple-touch-180'].size
export const APPLE_TOUCH_ICON_PATH = `${ICON_PATH_PREFIX}/apple-touch-180.png`
