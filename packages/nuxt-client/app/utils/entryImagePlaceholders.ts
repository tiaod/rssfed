import type { RssCachedImage } from '~/types/rss'
import { blurhashPlaceholder, TRANSPARENT_PIXEL } from '~/utils/blurhash'

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
 *
 * ## 没有占位的图：骨架兜底
 *
 * 服务端只缓存每篇前 N 张图（默认 6 张 / 1MB，见 hono-server 的 entry-images.ts），
 * 超出的图在 `images` 里没有条目，也就没有占位 —— 它们只能走网络，关掉图片加载或离线时
 * 是整个正文里最显眼的"空白"。老条目还有一批没有 blurhash（占位是 1×1 透明，同样看不见）。
 * 这两类图统一铺一层静态骨架（`applyImageSkeleton`，观感沿用 Nuxt UI 的 `USkeleton`），
 * 加载成功后由 useEntryContent 摘掉；加载失败就一直留着，于是空白变成灰块。
 *
 * 骨架的长宽比不靠猜：优先用正文 HTML 里的尺寸元数据（标准 `width`/`height`、公众号导出的
 * `data-ratio` 等，见 declaredAspect），都没有才退 16:9；加载中若用的是猜的比例，按 `cover`
 * 裁切而不是拉伸。骨架默认不可见、延迟 150ms 淡入，加载快的图全程不会闪灰块
 * （见 SKELETON_REVEAL_* 的说明）。
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

// ── 没有可用占位时的骨架 ──

/**
 * 骨架样式：沿用 Nuxt UI `USkeleton` 的观感（`rounded-md bg-elevated`），但**不带**
 * `animate-pulse`。
 *
 * 正文一屏可能有几十个骨架，逐个呼吸会变成一片闪烁，比"灰块"本身更显眼；静态底色 +
 * 下面那段「延迟淡入」看起来安静得多。想恢复 USkeleton 的动画，把 class 传成
 * `USkeleton` 的 base（`animate-pulse rounded-md bg-elevated`）即可（见 ImagePlaceholderPolicy）。
 */
export const IMAGE_SKELETON_CLASSES = 'rounded-md bg-elevated'
/** 骨架标记：属性值就是套上去的 class 串，摘除时照它移除（换主题也不用改这里） */
export const IMAGE_SKELETON_ATTR = 'data-img-skeleton'
/** 骨架比例的兜底值：正文 HTML 和本地元数据都给不出尺寸时用它（见 declaredAspect） */
const SKELETON_ASPECT_RATIO = '16 / 9'
/**
 * 骨架「延迟淡入」：加载比这快的图根本不显示骨架（否则每张图都会先闪一下灰块，
 * 本地 blob / 强网下这个闪比骨架本身更丑），只有真的要等网络的图才淡出来。
 */
const SKELETON_REVEAL_DELAY_MS = 150
const SKELETON_REVEAL_DURATION_MS = 120
const SKELETON_REVEAL_TRANSITION = `opacity ${SKELETON_REVEAL_DURATION_MS}ms ease ${SKELETON_REVEAL_DELAY_MS}ms`
/** 骨架临时写过的内联样式属性（摘骨架时逐个撤销，不碰源站自己的样式） */
const SKELETON_STYLE_ATTR = 'data-img-skeleton-style'
/** 骨架底色：与 Nuxt UI `bg-elevated` 工具类是同一个 token（内联顶掉源站 transparent 时用） */
const SKELETON_BACKGROUND = 'var(--ui-bg-elevated)'
/** 被骨架顶掉的源站内联 background-color 原值（摘骨架时还原） */
const SKELETON_BG_ATTR = 'data-img-skeleton-bg'
/** 宽高都声明、且短边不超过这个像素数的图（1×1 追踪像素、表情）不值得铺骨架 */
const SKELETON_MIN_DECLARED_SIZE = 2

/** 读尺寸类属性里的像素数（缺省、非数字、≤0 都当没声明） */
function declaredSize(img: Element, name: string): number | undefined {
  const raw = img.getAttribute(name)
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 加载前能确定的宽高比（宽/高），拿不到返回 undefined。
 *
 * 两个来源，按可靠性排序：
 *   1. 标准 `width` + `height` 属性 —— 浏览器就是按它们占位的，直接用；
 *   2. 富文本导出常见的尺寸元数据：公众号正文图的 `data-ratio`（**高/宽**，微信编辑器写入）
 *      以及部分导出器写的 `data-width` + `data-height`（原始像素）。
 *
 * 第 2 条是「占位比例明显不对」的主因：这类文章 99% 的图没有 width/height 属性，
 * 却有 data-ratio —— 只认标准属性的话它们会全部落到 16:9 兜底，横幅图（如 2440×560）
 * 就会被估成一块接近正方形的灰块。这些数据只是估算兜底，加载成功后骨架会被摘掉，
 * 不影响真实排版。
 */
function declaredAspect(img: Element): string | undefined {
  const width = declaredSize(img, 'width')
  const height = declaredSize(img, 'height')
  if (width !== undefined && height !== undefined) return `${width} / ${height}`

  // 公众号：data-ratio 是「高/宽」，例如 0.2287 → 宽高比 1 / 0.2287 ≈ 4.37
  const ratio = Number(img.getAttribute('data-ratio'))
  if (Number.isFinite(ratio) && ratio > 0) return `1 / ${ratio}`

  const dataWidth = declaredSize(img, 'data-width')
  const dataHeight = declaredSize(img, 'data-height')
  if (dataWidth !== undefined && dataHeight !== undefined) return `${dataWidth} / ${dataHeight}`
  return undefined
}

/**
 * 给一张「暂时没有可显示内容」的 `<img>` 铺骨架（同步，注入前调用）。
 *
 * 适用于两种图：
 *   1. 本地没有附件的图 —— 只能走网络，关掉图片/离线时会是一块空白；
 *   2. 老条目的本地占位是 1×1 透明像素（没有 blurhash）—— 有附件但占位看不见。
 *
 * 加载成功的图由管线的 `settleImageSkeletons` 摘掉骨架；一直加载失败的图保留骨架，
 * 于是"空白"变成"灰块"。
 */
export function applyImageSkeleton(img: Element, classes: string = IMAGE_SKELETON_CLASSES): void {
  if (img.hasAttribute(IMAGE_SKELETON_ATTR)) return

  const width = declaredSize(img, 'width')
  const height = declaredSize(img, 'height')
  if (width !== undefined && height !== undefined && Math.min(width, height) <= SKELETON_MIN_DECLARED_SIZE) return

  img.setAttribute(IMAGE_SKELETON_ATTR, classes)
  for (const token of classes.split(/\s+/)) {
    if (token) img.classList.add(token)
  }

  const el = img as HTMLElement
  /** 骨架临时写过的内联样式属性；摘骨架时照它撤销 */
  const applied: string[] = []

  // 延迟淡入：先藏起来，管线确认「这张图真的还没加载出来」后再让它淡入（见
  // revealImageSkeleton）。加载很快的图会在淡入开始前就被摘掉 —— 全程不出现灰块，
  // 打开文章时不会整屏闪一下灰。
  if (!el.style.opacity) {
    el.style.opacity = '0'
    applied.push('opacity')
  }
  if (!el.style.transition) {
    el.style.transition = SKELETON_REVEAL_TRANSITION
    applied.push('transition')
  }

  // 源站常给正文图内联 `background-color: transparent`（公众号富文本导出就是这样），
  // 内联样式压过 `bg-elevated` 工具类，灰底会整个看不见 —— 用内联 !important 顶掉它，
  // 摘骨架时把原值还回去。其它图走工具类就够，不必多写内联样式。
  const previousBackground = el.style.getPropertyValue('background-color')
  if (previousBackground) {
    img.setAttribute(SKELETON_BG_ATTR, previousBackground)
    el.style.setProperty('background-color', SKELETON_BACKGROUND, 'important')
  }

  // 宽高都声明过的图，浏览器自己就能按比例占位；其余情况加载前高度是 0，骨架会缩成一条
  // 看不见的线 —— 先按「能拿到的比例」（见 declaredAspect）占满一行，拿不到才退 16:9，
  // 等图到了再由 clearImageSkeleton 撤销。
  if (width === undefined || height === undefined) {
    const aspect = declaredAspect(img)
    if (!el.style.width) {
      el.style.width = '100%'
      applied.push('width')
    }
    if (!el.style.aspectRatio) {
      el.style.aspectRatio = aspect ?? SKELETON_ASPECT_RATIO
      applied.push('aspect-ratio')
    }
    // 比例是**猜**出来的（HTML 和元数据里都没有尺寸信息）：真实比例可能差很远，而浏览器
    // 会按骨架这个盒子铺图 —— 默认 `object-fit: fill` 会把图横向拉扁/纵向压扁，加载过程中
    // 一眼就能看出来。改成 cover：图按盒子裁掉溢出部分（保留顶部，即"把下面的截掉"），
    // 不变形；加载完成后摘骨架、图按真实比例完整显示。
    if (aspect === undefined) {
      if (!el.style.objectFit) {
        el.style.objectFit = 'cover'
        applied.push('object-fit')
      }
      if (!el.style.objectPosition) {
        el.style.objectPosition = 'center top'
        applied.push('object-position')
      }
    }
  }
  if (applied.length > 0) img.setAttribute(SKELETON_STYLE_ATTR, applied.join(' '))
}

/**
 * 让骨架淡入（管线确认「还没加载出来」后调用）。
 *
 * 内联的 `transition` 带 150ms 延迟：调用只是把 opacity 从 0 改成 1，真正的淡入在
 * 150ms 后才开始 —— 这段时间内加载完成的图会走 clearImageSkeleton，骨架一次都不显示。
 */
export function revealImageSkeleton(img: Element): void {
  if (!img.hasAttribute(IMAGE_SKELETON_ATTR)) return
  const el = img as HTMLElement
  if (el.style.opacity === '0') el.style.opacity = '1'
}

/** 摘掉骨架（图加载成功时由管线调用）；没铺过骨架的图直接返回 */
export function clearImageSkeleton(img: Element): void {
  const classes = img.getAttribute(IMAGE_SKELETON_ATTR)
  if (classes === null) return
  for (const token of classes.split(/\s+/)) {
    if (token) img.classList.remove(token)
  }
  img.removeAttribute(IMAGE_SKELETON_ATTR)

  const style = (img as HTMLElement).style
  // 还原被顶掉的源站内联底色（见 applyImageSkeleton）
  const previousBackground = img.getAttribute(SKELETON_BG_ATTR)
  if (previousBackground !== null) {
    img.removeAttribute(SKELETON_BG_ATTR)
    if (previousBackground) style.setProperty('background-color', previousBackground)
    else style.removeProperty('background-color')
  }

  const applied = img.getAttribute(SKELETON_STYLE_ATTR)
  if (applied === null) return
  img.removeAttribute(SKELETON_STYLE_ATTR)
  for (const prop of applied.split(/\s+/)) {
    if (prop) style.removeProperty(prop)
  }
}

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
 * 把一张命中本地附件的 `<img>` 换成本地占位（同步）；没命中的图铺骨架占位。
 *
 * @param baseUrl 正文里相对地址的解析基准（entry.url），与抓取端一致
 * @returns 是否替换过（false = 这张图不在本地缓存里，保持原样走网络）
 */
export function applyImagePlaceholder(
  img: Element,
  baseUrl: string | undefined,
  placeholders: PlaceholderMap,
  skeletonClasses: string = IMAGE_SKELETON_CLASSES
): boolean {
  const raw = img.getAttribute('src')
  if (!raw) return false
  // 内联 data:/blob: 图不联网、瞬间就有内容，既不需要占位也不需要骨架
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return false

  let absolute: string
  try {
    absolute = new URL(raw, baseUrl).toString()
  } catch {
    return false // 非法地址：交给净化后的原样渲染
  }
  const cached = placeholders.get(absolute)
  if (!cached) {
    // 本地没有附件：这张图只能走网络。关掉图片加载 / 离线时它原本就是一块空白，
    // 先铺骨架占位，加载成功后由 useEntryContent 的 settleImageSkeletons 摘掉。
    applyImageSkeleton(img, skeletonClasses)
    return false
  }

  img.setAttribute(ORIGINAL_SRC_ATTR, absolute)
  img.setAttribute('src', cached.src)
  // 老条目没有 blurhash，占位是 1×1 透明像素 —— 等附件读出来的这段时间里什么都看不见，
  // 补一块骨架，至少让人知道"这里有一张图正在来"。
  if (cached.src === TRANSPARENT_PIXEL) applyImageSkeleton(img, skeletonClasses)

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
