import type { RssCachedImage } from '~/types/rss'
import { blurhashPlaceholder } from '~/utils/blurhash'

/**
 * 正文图片「注入 DOM 之前」的占位替换。
 *
 * ## 为什么必须先换再插
 *
 * 正文用 `v-html` 注入。只要 `<img src="原始 URL">` 进过 DOM，浏览器就已经开始抓那张图了；
 * 之后再换 `src`（无论多快）都只是**取消**这个请求 —— 在 DevTools 里表现为每打开一篇文章
 * 就向源站发一批图片请求（全部 `net::ERR_ABORTED`），看起来像"离线缓存没生效"。
 *
 * 而最终要换上的 `blob:` URL 必须先异步读出附件字节（IndexedDB），注入时拿不到。
 * 所以流程拆成两段：
 *
 *   1. **注入前（本文件，同步）**：正文里命中本地附件的图，`src` 换成占位
 *      （有 blurhash 就用它解出的 data URL，否则 1×1 透明），原始绝对地址存进
 *      `data-orig-src`；顺带按原图尺寸补上 `width`/`height`，把版面位置先占住。
 *   2. **注入后（useEntryContent，异步）**：读出附件字节换成 `blob:` URL；
 *      读失败就把 `data-orig-src` 填回去（保持"附件缺失回退原地址"的旧行为）。
 *
 * 占位图是同步可得的（`entry.images` 与正文一起来自同一篇文档），所以这一步不阻塞正文上屏 ——
 * 「先出字、再出图」的顺序不变。
 */

/** 原始图片地址挂在这个属性上（占位期间它就是这个 `<img>` 的"真身"） */
export const ORIGINAL_SRC_ATTR = 'data-orig-src'

/** 命中本地附件的一张图：占位地址 + 之后要读的附件名 */
export interface CachedImagePlaceholder {
  /** 附件名（如 img-0.avif），注入后由管线用它读 blob */
  attachment: string
  /** 占位 data URL（blurhash 解出的图，或 1×1 透明） */
  src: string
  width?: number
  height?: number
}

/** 「绝对图片 URL → 占位信息」表；同一条 entry 构建一次即可 */
export type PlaceholderMap = Map<string, CachedImagePlaceholder>

/**
 * 用 entry 的 `images` 元数据构建占位表。
 *
 * 键是**绝对地址**（服务端抓取时已按 entry.url 解析过，见 hono-server 的 extractImageUrls），
 * 与正文里 `<img src>` 解析后的绝对地址是同一套口径 —— 两边任一处换了解析基准，
 * 都会表现为"占位一直不换成真图"，所以口径必须一致。
 */
export function buildPlaceholderMap(images: RssCachedImage[] | undefined): PlaceholderMap {
  const map: PlaceholderMap = new Map()
  for (const image of images ?? []) {
    if (!image.url || !image.attachment) continue
    map.set(image.url, {
      attachment: image.attachment,
      src: blurhashPlaceholder(image.blurhash, image.width, image.height),
      width: image.width,
      height: image.height
    })
  }
  return map
}

/**
 * 把一张命中本地附件的 `<img>` 换成本地占位（同步）。
 *
 * @param baseUrl 正文里相对地址的解析基准（entry.url），与抓取端一致
 * @returns 是否替换过（false = 这张图不在本地缓存里，保持原样走网络）
 */
export function applyImagePlaceholder(
  img: Element,
  baseUrl: string | undefined,
  placeholders: PlaceholderMap
): boolean {
  if (placeholders.size === 0) return false
  const raw = img.getAttribute('src')
  if (!raw) return false

  let absolute: string
  try {
    absolute = new URL(raw, baseUrl).toString()
  } catch {
    return false // 非法地址：交给净化后的原样渲染
  }
  const cached = placeholders.get(absolute)
  if (!cached) return false

  img.setAttribute(ORIGINAL_SRC_ATTR, absolute)
  img.setAttribute('src', cached.src)

  // 版面先占住：图按内在尺寸排版，只给 1×1 或一张小占位图的话，真图到位时整页会跳一下。
  // 仅当正文自己没有声明尺寸时才补 —— 源站声明的尺寸（小图标等）是内容的一部分，不该覆盖。
  // Tailwind Preflight 的 `img { max-width: 100%; height: auto }` 保证补上尺寸也不会被拉伸变形。
  const hasOwnSize = img.hasAttribute('width') || img.hasAttribute('height')
  if (!hasOwnSize && cached.width && cached.height) {
    img.setAttribute('width', String(cached.width))
    img.setAttribute('height', String(cached.height))
  }
  return true
}

/**
 * 占位还原：把 `data-orig-src` 写回 `src`（附件读失败时用），并摘掉标记。
 *
 * 摘标记是必须的：它同时是"这张图还是占位"的判据（图片放大镜靠它排除占位图）。
 */
export function restoreOriginalSrc(img: Element): boolean {
  const original = img.getAttribute(ORIGINAL_SRC_ATTR)
  if (!original) return false
  img.setAttribute('src', original)
  img.removeAttribute(ORIGINAL_SRC_ATTR)
  return true
}

/** 这张图是否还停在占位状态（管线换成功后要摘标记） */
export function isPlaceholder(img: Element): boolean {
  return img.hasAttribute(ORIGINAL_SRC_ATTR)
}
