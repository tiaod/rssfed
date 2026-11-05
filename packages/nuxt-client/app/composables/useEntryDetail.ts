import { computed, reactive, ref, watch } from 'vue'
import type { RssEntry } from '~/types/rss'
// 显式导入：单测环境没有 Nuxt 自动导入，裸调 useEntryActions 会直接 ReferenceError
import { useEntryActions } from '~/composables/useEntryActions'

/**
 * 条目详情的共享状态与动作。
 *
 * 详情有两个展示面：窄屏的模态弹窗（EntryDetailModal）与宽屏右侧的常驻阅读栏
 * （EntryReaderPane，三栏布局的第三栏）。它们要做的事完全一样 —— 打开即标已读、
 * 按 id 懒取全文、上一篇/下一篇、工具栏的已读与收藏切换（单条的写入口径见 useEntryActions，
 * 信息流条目的操作栏也用那一份）—— 所以口径只在这里写一份，各展示面只负责版式
 * （弹窗尺寸 / 划卡 / 键盘 / 滚动容器）。
 *
 * 两个展示面由断点互斥，同时只有一个是挂载的（见 useReaderPaneWide）。
 */
export function useEntryDetail() {
  const {
    isOpen,
    currentEntry,
    goPrev,
    goNext,
    canGoPrev,
    isLastWithNoMore
  } = useEntryModal()
  const pouch = usePouchDb()
  const toast = useToast()

  // ── 已读 / 收藏（都写用户状态库的 entry-state 文档） ──

  /**
   * 打开详情、以及「上一篇 / 下一篇」翻到某篇时，就地标为已读。
   *
   * 打开即已读是本项目的既定口径：点进来就是要读它。就地改列表里那个对象
   * （openEntry 传进来的就是列表元素本身，共用引用），列表立刻淡显，不必重查；
   * 写库失败则回退，避免界面显示一个并没落盘的状态。已经是已读的直接跳过。
   */
  watch(
    [isOpen, () => currentEntry.value?.id],
    ([open]) => {
      if (!open) return
      const entry = currentEntry.value
      if (!entry || entry.read) return
      entry.read = true
      void pouch.markRead(entry.id, entry.feedId, true).catch(() => {
        entry.read = false
      })
    },
    // 组件可能是在详情已打开的状态下挂载的（断点切换、切页后重新渲染），首帧同样要标记
    { immediate: true }
  )

  /**
   * 工具栏的两个手动动作（标为已读 / 未读、收藏）：写库与就地改条目的口径在 useEntryActions，
   * 信息流条目的操作栏用的是同一份，这里只是把它接到「当前这篇」上。
   */
  const { readBusy, savedBusy, toggleRead, toggleStar } = useEntryActions(
    () => currentEntry.value
  )

  // ── 全文懒取：按 id 缓存，命中的直接复用 ──

  const details = reactive(new Map<string, RssEntry | null>())
  const loadingIds = reactive(new Set<string>())

  /**
   * 正文区当前渲染的条目。
   *
   * 列表行来自 map view 投影（为省内存刻意不携带正文全文 content），只有标题与元信息：
   * 直接把它当正文上屏的话，切篇瞬间框体会先塌成一小条、等全文到位再弹回原高度——就是那一下闪烁。
   * 因此全文没到位前 detailEntry 保持 null（正文区显示骨架屏），只认真正取到的全文。
   */
  const detailEntry = ref<RssEntry | null>(null)
  /** 全文是否还在取：true 时正文区渲染骨架屏 */
  const detailLoading = ref(false)
  /** 单篇展示面的全文读取最终失败（404 或重试后仍报错）：模板据此显示重试入口 */
  const detailFailed = ref(false)
  /** 三槽划卡路径各槽的读取失败集合（手机全屏档用，见 EntryDetailModal） */
  const detailFailures = reactive(new Set<string>())

  /** 全文读取失败后的重试间隔（毫秒）：本地库短暂不可用（切库、IndexedDB 抖动）时重试两次 */
  const DETAIL_RETRY_DELAYS_MS = [300, 900]

  function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
  }

  /**
   * 按 id 取全文：404 返回 null（本地确实没有这篇），其余读取错误重试后仍失败则抛出。
   *
   * 不能把「读失败」当成「没有这篇」——那会让界面退回只有标题的投影（正文空白），
   * 而且一次瞬时故障之后就再也不重试。失败要交给调用方显示重试入口。
   */
  async function fetchFullEntry(id: string): Promise<RssEntry | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await pouch.getEntry(id)
      } catch (err) {
        if (attempt >= DETAIL_RETRY_DELAYS_MS.length) throw err
        await delay(DETAIL_RETRY_DELAYS_MS[attempt]!)
      }
    }
  }

  async function loadDetail(id: string | undefined) {
    const cached = id ? details.get(id) : null
    if (cached) {
      // 预取命中：整篇直接切换，不经过「只有标题的投影」那一帧
      detailEntry.value = cached
      detailLoading.value = false
      detailFailed.value = false
      return
    }
    detailEntry.value = null
    detailLoading.value = !!id
    detailFailed.value = false
    if (!id) return

    let full: RssEntry | null = null
    let failed = false
    try {
      full = await fetchFullEntry(id)
      failed = !full
    } catch {
      failed = true
    }
    if (currentEntry.value?.id !== id) return // 竞态：已切到别的条目，旧结果作废
    detailEntry.value = failed ? null : full
    detailFailed.value = failed
    detailLoading.value = false
    if (failed) detailFailures.add(id)
    else detailFailures.delete(id)
  }

  /** 单篇展示面的「重试」：重新按当前条目取一次全文 */
  function retryDetail() {
    const id = currentEntry.value?.id
    if (!id) return
    void loadDetail(id)
  }

  /** 正文区的渲染态：加载中是骨架屏，失败是重试块，否则是条目 id；变化即触发淡入淡出 */
  const detailViewKey = computed(() => {
    if (detailLoading.value) return 'loading'
    if (detailFailed.value) return `failed:${currentEntry.value?.id ?? ''}`
    return detailEntry.value?.id ?? 'empty'
  })

  /** 展示用条目：全文取到后换全文，否则先用列表投影的标题/元信息顶着（弹窗的三槽预取用它） */
  function displayOf(raw: RssEntry | null): RssEntry | null {
    if (!raw) return null
    return details.get(raw.id) ?? raw
  }

  function isLoading(raw: RssEntry | null): boolean {
    return !!raw && !details.has(raw.id) && loadingIds.has(raw.id)
  }

  // ── 上一篇 / 下一篇 ──

  /**
   * 到达列表尽头时不再无声失败：无更多数据（hasMore 为假）提示结尾，开头则提示已到首篇。
   * 返回是否真的翻过去了，调用方据此决定要不要做自己的收尾动作（如弹窗亮出页码）。
   */
  function navWithHint(dir: -1 | 1): boolean {
    const moved = dir === 1 ? !!goNext() : !!goPrev()
    if (moved || !isOpen.value) return moved
    if (dir === 1) {
      if (isLastWithNoMore()) toast.add({ title: '没有下一篇了', color: 'neutral' })
    } else if (!canGoPrev.value) {
      toast.add({ title: '已经是第一篇了', color: 'neutral' })
    }
    return moved
  }

  return {
    readBusy,
    savedBusy,
    toggleRead,
    toggleStar,
    details,
    loadingIds,
    detailEntry,
    detailLoading,
    detailFailed,
    detailFailures,
    detailViewKey,
    loadDetail,
    retryDetail,
    fetchFullEntry,
    displayOf,
    isLoading,
    navWithHint
  }
}
