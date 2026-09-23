import DOMPurify from 'dompurify'
import type { Config } from 'dompurify'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

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
 * - <iframe> 默认不放行（YouTube 等嵌入会被移除），确有需要时再把它加进 ADD_TAGS，
 *   并在 hook 里按 host 做白名单，不要无条件放开
 */
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ['form', 'input', 'button', 'select', 'option', 'textarea', 'style'],
  ADD_ATTR: ['target'],
  ALLOW_ARIA_ATTR: true,
  ALLOW_DATA_ATTR: true
}

/** DOMPurify 的 hook 是全局且会累加，模块级只装一次，避免回调重复叠加 */
let hooksInstalled = false

/**
 * 净化后的收尾处理：
 * - 链接统一新窗口打开并补 rel（防 tabnabbing、防点外链把阅读器跳走）
 * - 图片懒加载 + 不带 referrer（订阅源图片多为第三方图床，少泄露一点浏览行为）
 */
function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    } else if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy')
      el.setAttribute('decoding', 'async')
      el.setAttribute('referrerpolicy', 'no-referrer')
    }
  })
}

/**
 * 把任意 HTML 净化成可安全注入 DOM 的字符串。
 *
 * 只在浏览器里真正工作；服务端返回空串（正文不参与 SSR，见文件头注释）。
 */
export function sanitizeEntryHtml(raw: string | null | undefined): string {
  if (!raw) return ''
  // 服务端没有 DOM：DOMPurify 在 Node 下是工厂函数，直接调 sanitize 会抛 TypeError。
  // 正文只由客户端的 EntryDetail 渲染，这里安全地降级为空串。
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return ''

  installHooks()
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG)
}

/**
 * 响应式版本的净化：entry.content 变化时自动重算。
 * 返回值直接交给 v-html（已在 sanitizeEntryHtml 里过完白名单）。
 */
export function useSafeHtml(source: MaybeRefOrGetter<string | null | undefined>) {
  return computed(() => sanitizeEntryHtml(toValue(source)))
}
