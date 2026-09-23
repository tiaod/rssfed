import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { usePouchDb } from '~/composables/usePouchDb'
import { highlightCodeBlocks } from '~/composables/useCodeHighlight'

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
 *   1. 把已缓存为 AVIF 附件的 <img> 换成本地 blob URL（离线可用，缺失时保留原 URL 回退）
 *   2. 给 <pre><code class="language-xxx"> 做 shiki 高亮
 *   3. 调用 hooks.onReady（EntryDetail 用它挂图片点击放大）
 *
 * 三步必须串行：放大要基于第 1 步改写后的最终 src。
 * 内容切换/组件卸载时用递增的 runToken 作废进行中的异步任务，避免给旧 DOM 白做功。
 * blob URL 在切换和卸载时统一回收。
 */
export function useEntryContent(
  entryRef: () => RssEntry | null,
  contentEl: Ref<HTMLElement | null | undefined>,
  hooks: EntryContentHooks = {}
) {
  const resolving = ref(false)
  /** 本次处理创建的 blob URL，切换/卸载时回收 */
  const createdUrls: string[] = []

  /** 每次正文重建自增；异步阶段靠它判断本轮是否已作废 */
  let runToken = 0

  watch([entryRef, contentEl], () => {
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

  /** 把命中本地附件的图片换成 blob URL；未缓存/附件缺失的保留原 URL 回退 */
  async function replaceWithCachedImages(entry: RssEntry, el: HTMLElement) {
    if (!entry.images?.length) return

    const imgs = Array.from(el.querySelectorAll('img'))
    if (imgs.length === 0) return

    const { getEntryAttachment } = usePouchDb()
    for (const img of imgs) {
      const raw = img.getAttribute('src')
      if (!raw) continue
      // 后端缓存时基于 entry.url 解析绝对地址，这里保持同一基准匹配
      let abs: string
      try {
        abs = new URL(raw, entry.url).toString()
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
      } catch {
        // 附件尚未同步或缺失：保留原 URL
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
