import { ref, watch } from 'vue'
import type { RssEntry } from '~/types/rss'
import { entryFeedImages } from '~/utils/entryDisplay'

/** 信息流图片格：能直接塞进 `<img src>` 的一张图 */
export interface FeedImage {
  src: string
  width?: number
  height?: number
}

/**
 * 附件 blob URL 缓存：`条目id:附件名` → blob URL。
 *
 * 与 usePouchDb 里封面那套（entryCoverBlobs）同样的取舍：blob URL 随会话常驻不回收，
 * 换来虚拟列表来回滚动时不用重复读 IndexedDB 与重复解码（回收了反而要重取，滚动会闪）。
 */
const blobCache = new Map<string, string>()

/**
 * 一张动态里所有图片的本地 blob URL（社交动态的相册要铺多张）。
 *
 * 列表投影只让 enrichEntries 解好了**封面**那一张的 blob URL（列表缩略图只需要它），
 * 其余几张按条目懒取：只对真正渲染出来的条目取（虚拟化下同一屏就那几条），
 * 不在 enrichEntries 里一次解完 —— 那样每个视图、每一页的首帧都要为几十条 × 最多 6 张
 * 附件去 getAttachment，等于把「先出字、再出图」的顺序反过来。
 *
 * 取不到的（附件还没同步下来）直接不返回，那格就不画；条目换人时旧结果作废（竞态）。
 * 用取值函数而不是直接传对象：列表刷新时条目对象会被换掉（甚至就地换内容），
 * 取值函数每次都读到当下那一条。
 */
export function useEntryImages(getEntry: () => RssEntry) {
  const pouch = usePouchDb()
  const media = ref<FeedImage[]>([])

  async function resolve() {
    const entry = getEntry()
    const id = entry.id
    const images = entryFeedImages(entry)
    const resolved: FeedImage[] = []
    for (const image of images) {
      if (!image.attachment) continue
      // 封面已经解好（enrichEntries），直接复用，不再读一次附件
      if (image.cover && entry.coverUrl) {
        resolved.push({ src: entry.coverUrl, width: image.width, height: image.height })
        continue
      }
      const key = `${id}:${image.attachment}`
      const hit = blobCache.get(key)
      if (hit) {
        resolved.push({ src: hit, width: image.width, height: image.height })
        continue
      }
      try {
        const blob = await pouch.getEntryAttachment(id, image.attachment)
        if (getEntry().id !== id) return // 竞态：这条已经换成别的条目了
        const url = URL.createObjectURL(blob)
        blobCache.set(key, url)
        resolved.push({ src: url, width: image.width, height: image.height })
      } catch {
        // 附件未同步：这一格不画
      }
    }
    if (getEntry().id === id) media.value = resolved
  }

  watch(
    () => getEntry().images,
    () => {
      void resolve()
    },
    { immediate: true }
  )

  return { media }
}
