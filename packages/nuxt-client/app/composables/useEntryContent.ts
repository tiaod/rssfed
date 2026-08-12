import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { usePouchDb } from '~/composables/usePouchDb'

/**
 * 渲染 entry 正文：把已缓存为 AVIF 附件的 <img> 替换为本地 blob URL 直接展示。
 *
 * - 直接在 DOM 上改 src（不重建整个 v-html 区域），未缓存/附件缺失的图片保留原 URL 回退
 * - 附件随 PouchDB 同步到本地库，离线时 getAttachment 同样可用
 * - 组件卸载或正文切换时统一回收 blob URL
 */
export function useEntryContent(
  entryRef: () => RssEntry | null,
  contentEl: Ref<HTMLElement | null | undefined>,
) {
  const resolving = ref(false)
  /** 本次处理创建的 blob URL，切换/卸载时回收 */
  const createdUrls: string[] = []

  watch([entryRef, contentEl], () => {
    void replaceWithCachedImages()
  }, { flush: 'post' })

  async function replaceWithCachedImages() {
    const entry = entryRef()
    const el = contentEl.value
    revokeCreated()
    resolving.value = false
    if (!entry || !el || !entry.content || !entry.images?.length) return

    await nextTick() // 等待 v-html 渲染完成（正文切换时 DOM 已重建）
    const imgs = Array.from(el.querySelectorAll('img'))
    if (imgs.length === 0) return

    resolving.value = true
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
    resolving.value = false
  }

  function revokeCreated() {
    for (const url of createdUrls) URL.revokeObjectURL(url)
    createdUrls.length = 0
  }

  onScopeDispose(revokeCreated)

  return { resolving }
}
