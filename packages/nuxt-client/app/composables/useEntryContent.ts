import { nextTick, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref, type WatchSource } from 'vue'
import type { RssEntry } from '~/types/rss'
import { usePouchDb } from '~/composables/usePouchDb'
import { highlightCodeBlocks } from '~/composables/useCodeHighlight'
import { ORIGINAL_SRC_ATTR, restoreOriginalSrc } from '~/utils/entryImagePlaceholders'

/** 管线完成后挂载/清理附加交互（如图片点击放大）的钩子 */
export interface EntryContentHooks {
  /** 图片已换成本地地址、代码已高亮之后调用，此时 DOM 是最终形态 */
  onReady?: (el: HTMLElement) => void
  /** 正文切换或组件卸载时调用，用于摘掉上一轮挂上的监听 */
  onTeardown?: () => void
}

/**
 * 渲染 entry 正文后的统一增强管线。正文由 v-html 注入（HTML 已由 useSafeHtml 净化），
 * 注入的是「死」DOM，所以这里在 nextTick 之后按顺序补三件事：
 *
 *   1. 把**已占位**的图（本地有 AVIF 附件）换成本地 blob URL —— 离线可用；
 *      附件缺失时回填原始地址（占位与回填的约定见 utils/entryImagePlaceholders.ts）
 *   2. 给 `<pre><code class="language-xxx">` 做 shiki 高亮
 *   3. 调用 hooks.onReady（EntryDetail 用它挂图片点击放大）
 *
 * 三步必须串行：放大要基于第 1 步改写后的最终 src。
 * 内容切换/组件卸载时用递增的 runToken 作废进行中的异步任务，避免给旧 DOM 白做功。
 * blob URL 在切换和卸载时统一回收。
 *
 * **图片占位必须发生在注入之前**（useSafeHtml 的 hook 里做），不能挪到这里：
 * `<img src="原始 URL">` 一进 DOM，浏览器就开始抓那张图了，之后再换 src 只是取消它。
 * 这里只负责"占位 → 真身"这一段（异步读 IndexedDB）。
 *
 * `htmlRef` 是净化后的正文 HTML：它不只随 entry 变，还会随**运行时拉取的站点设置**
 * （iframe 白名单）二次变化，届时 v-html 会整块重写 DOM，之前换上的 blob URL 与代码
 * 高亮都会丢。所以把它也作为依赖，重写之后重跑一遍管线。
 */
export function useEntryContent(
  entryRef: () => RssEntry | null,
  contentEl: Ref<HTMLElement | null | undefined>,
  hooks: EntryContentHooks = {},
  htmlRef?: MaybeRefOrGetter<string>
) {
  const resolving = ref(false)
  /** 本次处理创建的 blob URL，切换/卸载时回收 */
  const createdUrls: string[] = []

  /** 每次正文重建自增；异步阶段靠它判断本轮是否已作废 */
  let runToken = 0

  const sources: WatchSource<unknown>[] = [entryRef, contentEl]
  if (htmlRef) sources.push(() => toValue(htmlRef))
  watch(sources, () => {
    void enhance()
  }, { flush: 'post' })

  async function enhance() {
    const token = ++runToken
    revokeCreated()
    hooks.onTeardown?.()
    resolving.value = false

    const entry = entryRef()
    const el = contentEl.value
    if (!entry || !el || !entry.content?.trim()) return

    await nextTick() // 等待 v-html 渲染完成（正文切换时 DOM 已重建）
    if (token !== runToken) return

    resolving.value = true
    try {
      await replaceWithCachedImages(entry, el)
      if (token !== runToken) return

      await highlightCodeBlocks(el, () => token !== runToken)
      if (token !== runToken) return

      hooks.onReady?.(el)
    } finally {
      if (token === runToken) resolving.value = false
    }
  }

  /**
   * 把命中本地附件的图片换成 blob URL。
   *
   * 两种来源统一处理：
   *   - **已在净化阶段占位**的图（`data-orig-src` 才是真身）：用它做匹配基准；
   *   - 未占位的图（本地没有附件、或正文里是解析不上原始地址的写法）：按当前 `src` 匹配。
   *
   * 读附件失败时把 `data-orig-src` 填回 `src`，保持"附件缺失就用原地址"的旧行为；
   * 未占位也没有原地址可回填的，原样留着（本来就在走网络）。
   */
  async function replaceWithCachedImages(entry: RssEntry, el: HTMLElement) {
    if (!entry.images?.length) return

    const imgs = Array.from(el.querySelectorAll('img'))
    if (imgs.length === 0) return

    const { getEntryAttachment } = usePouchDb()
    for (const img of imgs) {
      const original = img.getAttribute(ORIGINAL_SRC_ATTR)
      const current = img.getAttribute('src')
      if (!original && !current) continue
      // 后端缓存时基于 entry.url 解析绝对地址，这里保持同一基准匹配
      let abs: string
      try {
        abs = original ?? new URL(current!, entry.url).toString()
      } catch {
        continue
      }
      const cached = entry.images.find(i => i.url === abs)
      if (!cached) continue
      try {
        const blob = await getEntryAttachment(entry.id, cached.attachment)
        const url = URL.createObjectURL(blob)
        createdUrls.push(url)
        img.setAttribute('src', url)
        // 换成本地 blob 之后它不再是"占位图"（放大镜据此排除尚未换好的图）
        img.removeAttribute(ORIGINAL_SRC_ATTR)
      } catch {
        // 附件尚未同步或缺失：回填原始地址；没有原始地址（未占位）就保持原样
        restoreOriginalSrc(img)
      }
    }
  }

  function revokeCreated() {
    for (const url of createdUrls) URL.revokeObjectURL(url)
    createdUrls.length = 0
  }

  onScopeDispose(() => {
    runToken++ // 作废进行中的异步增强
    revokeCreated()
    hooks.onTeardown?.()
  })

  return { resolving }
}
