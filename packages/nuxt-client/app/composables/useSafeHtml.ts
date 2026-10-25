import DOMPurify from 'dompurify'
import type { Config } from 'dompurify'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import {
  buildIframePolicy,
  resolveIframeSrc,
  type IframeEmbedPolicy,
  type IframeSourceContext
} from '~/utils/iframePolicy'
import { applyImagePlaceholder, type PlaceholderMap } from '~/utils/entryImagePlaceholders'

/**
 * RSS 正文的净化（XSS 防御）。
 *
 * 架构：**数据层保持无损，净化只发生在渲染层、且只在客户端**。
 *
 * - 后端不净化：订阅源原始 HTML 原样入库。白名单属于展示策略，以后想放宽或收紧
 *   随时能改，也不会因为某次配置失误在数据层造成不可逆的内容裁剪。
 * - 服务端不净化：DOMPurify 依赖真实 DOM，在 Node 下默认导出是「工厂函数」而非实例，
 *   调用 sanitize 会抛 TypeError。正文只走客户端渲染（见 EntryDetail 里的 ClientOnly），
 *   SSR 阶段根本不输出正文，所以不需要服务端净化 —— 也就不必引入 jsdom。
 * - 客户端必须净化：这是最后一层 sink 防线，覆盖历史脏数据、被直写的 CouchDB 库，
 *   以及任何绕过抓取流程写入的条目。
 *
 * 特别注意：如果哪天要给正文加 SSR（比如条目详情页），服务端那条链就必须补上净化，
 * 否则浏览器解析 SSR 响应时会**先于**任何客户端代码执行其中的脚本。
 */

/**
 * 净化配置。
 *
 * DOMPurify 默认放行的标签已经很宽（含 img/figure/table/details 等 RSS 常见元素），
 * 这里额外收紧几项：
 * - 禁掉表单类标签：正文里出现表单基本只可能是钓鱼/诱导订阅
 * - 禁掉 <style>：避免动到阅读器自身的样式
 * - 放行 <iframe>，但**由 hook 逐条判定**（见下）：只保留与订阅源同源、或命中管理员
 *   地址前缀白名单的嵌入；判定不通过就整块移除。
 * - 禁掉 srcdoc：它是「不联网也能渲染任意 HTML」的口子，绕开一切 src 白名单
 */
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ['form', 'input', 'button', 'select', 'option', 'textarea', 'style'],
  ADD_TAGS: ['iframe'],
  // 播放器需要的属性：allowfullscreen/frameborder/allow 不在 DOMPurify 默认放行表里；
  // referrerpolicy 由本文件的 hook 补写，这里声明出来免得被上游当成未知属性删掉
  ADD_ATTR: ['target', 'allowfullscreen', 'frameborder', 'allow', 'referrerpolicy'],
  FORBID_ATTR: ['srcdoc'],
  ALLOW_ARIA_ATTR: true,
  ALLOW_DATA_ATTR: true
}

/**
 * 本轮 sanitize 的 iframe 策略：DOMPurify 会把调用方传入的 config 作为第三个参数
 * 交给 hook，于是策略随调用走，模块级的 hook 不需要可变状态。
 */
type IframeAwareConfig = Config & {
  iframePolicy?: IframeEmbedPolicy
  /**
   * 正文图片的本地占位策略（见 utils/entryImagePlaceholders.ts）。
   *
   * 必须在**注入 DOM 之前**把命中本地附件的 `<img src>` 换掉：图片元素一进 DOM，
   * 浏览器就开始抓原始 URL 了，之后再换只能取消它（DevTools 里那批 `ERR_ABORTED`）。
   * 净化这一步的输出正是要交给 v-html 的字符串，所以改写放在这里。
   */
  imagePlaceholders?: ImagePlaceholderPolicy
}

/** DOMPurify 的 hook 是全局且会累加，模块级只装一次，避免回调重复叠加 */
let hooksInstalled = false

/**
 * 净化后的收尾处理：
 * - 链接统一新窗口打开并补 rel（防 tabnabbing、防点外链把阅读器跳走）
 * - 图片懒加载 + 不带 referrer（订阅源图片多为第三方图床，少泄露一点浏览行为）
 * - iframe 只补懒加载：referrer 留给浏览器默认值，部分播放器会校验 Referer 放防盗链
 */
function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true

  /**
   * iframe 逐条判定。放在 uponSanitizeElement：此时元素刚被读出、属性还没过白名单，
   * 既能改写 src，也能在判定不通过时把整块（含子节点）删掉，不留空壳。
   */
  DOMPurify.addHook('uponSanitizeElement', (node, data, config) => {
    if (data.tagName !== 'iframe') return
    const el = node as Element
    const policy = (config as IframeAwareConfig).iframePolicy
    const resolved = policy
      ? resolveIframeSrc(el.getAttribute('src'), policy)
      : null

    if (!resolved) {
      el.parentNode?.removeChild(el)
      return
    }
    // 相对/协议相对地址改写成绝对地址：浏览器只会拿阅读器自身 origin 补全它们，
    // 不改写就等于把阅读器自己嵌进来（见 utils/iframePolicy.ts 的文件头说明）
    el.setAttribute('src', resolved)
  })

  DOMPurify.addHook('afterSanitizeAttributes', (node, _data, config) => {
    const el = node as Element
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    } else if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy')
      el.setAttribute('decoding', 'async')
      el.setAttribute('referrerpolicy', 'no-referrer')
      // 命中本地缓存就换成本地占位（原始地址留在 data-orig-src）；没命中的铺骨架占位。
      // 两者都必须在注入前做完，见 entryImagePlaceholders
      const placeholders = (config as IframeAwareConfig).imagePlaceholders
      if (placeholders) applyImagePlaceholder(el, placeholders.baseUrl, placeholders.map, placeholders.skeletonClasses)
    } else if (el.tagName === 'IFRAME') {
      el.setAttribute('loading', 'lazy')
    }
  })
}

/**
 * 正文图片的本地占位策略：命中表里的图在注入前被换成占位 data URL；
 * 没命中的图（本地没缓存）铺骨架占位，关掉图片加载 / 离线时不会剩一块空白。
 * `baseUrl` 是相对地址的解析基准（entry.url），与抓取端解析图片地址的口径一致。
 */
export interface ImagePlaceholderPolicy {
  baseUrl?: string
  map: PlaceholderMap
  /**
   * 骨架用的 class；默认取 Nuxt UI `USkeleton` 的观感类（静态、不带 animate-pulse，
   * 见 entryImagePlaceholders 的 IMAGE_SKELETON_CLASSES）
   */
  skeletonClasses?: string
}

/**
 * 把任意 HTML 净化成可安全注入 DOM 的字符串。
 *
 * `iframeContext` 给出来源条目与其订阅源的地址（同源判定 + 相对地址解析）以及管理员
 * 维护的地址前缀白名单。**不传 = 不放行任何 iframe**，与历史行为一致。
 *
 * `imagePlaceholders` 是「已缓存到本地附件的图片」表：**在输出字符串里**就把这些图的
 * `src` 换成占位（blurhash / 透明像素），原始地址存进 `data-orig-src`，由 useEntryContent
 * 注入后再异步换成 blob URL —— 顺序不能反，见 utils/entryImagePlaceholders.ts 的文件头。
 * 表里没有的图（本地没缓存、服务端没算 blurhash）会铺一层骨架占位，等图加载成功后摘掉。
 *
 * 只在浏览器里真正工作；服务端返回空串（正文不参与 SSR，见文件头注释）。
 */
export function sanitizeEntryHtml(
  raw: string | null | undefined,
  iframeContext?: IframeSourceContext,
  imagePlaceholders?: ImagePlaceholderPolicy
): string {
  if (!raw) return ''
  // 服务端没有 DOM：DOMPurify 在 Node 下是工厂函数，直接调 sanitize 会抛 TypeError。
  // 正文只由客户端的 EntryDetail 渲染，这里安全地降级为空串。
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return ''

  installHooks()
  const policy = iframeContext
    ? buildIframePolicy(iframeContext, window.location.origin)
    : undefined
  const config: IframeAwareConfig = {
    ...SANITIZE_CONFIG,
    ...(policy ? { iframePolicy: policy } : {}),
    // 表可以是空的（这篇一张图都没缓存）：骨架不依赖缓存，照样要铺
    ...(imagePlaceholders ? { imagePlaceholders } : {})
  }

  return DOMPurify.sanitize(raw, config)
}

/**
 * 响应式版本的净化：entry.content（以及订阅源上下文、白名单、已缓存图片表）变化时自动重算。
 * 返回值直接交给 v-html（已在 sanitizeEntryHtml 里过完白名单）。
 */
export function useSafeHtml(
  source: MaybeRefOrGetter<string | null | undefined>,
  iframeContext?: MaybeRefOrGetter<IframeSourceContext | undefined>,
  imagePlaceholders?: MaybeRefOrGetter<ImagePlaceholderPolicy | undefined>
) {
  return computed(() => sanitizeEntryHtml(
    toValue(source),
    iframeContext ? toValue(iframeContext) : undefined,
    imagePlaceholders ? toValue(imagePlaceholders) : undefined
  ))
}
