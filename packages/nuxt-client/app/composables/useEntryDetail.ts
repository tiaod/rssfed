import { computed, reactive, ref, watch } from 'vue'
import type { RssEntry } from '~/types/rss'
import { errorMessage } from '~/utils/errorMessage'

/**
 * 条目详情的共享状态与动作。
 *
 * 详情有两个展示面：窄屏的模态弹窗（EntryDetailModal）与宽屏右侧的常驻阅读栏
 * （EntryReaderPane，三栏布局的第三栏）。它们要做的事完全一样 —— 打开即标已读、
 * 按 id 懒取全文、上一篇/下一篇、工具栏的已读与收藏切换 —— 所以口径只在这里写一份，
 * 各展示面只负责版式（弹窗尺寸 / 划卡 / 键盘 / 滚动容器）。
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

  /** 手动切换已读 / 未读（工具栏）。与自动标记共用同一个开关，冲突由 markRead 内部重试消化 */
  const readBusy = ref(false)

  async function toggleRead() {
    const entry = currentEntry.value
    if (!entry || readBusy.value) return
    const next = !entry.read
    readBusy.value = true
    try {
      await pouch.markRead(entry.id, entry.feedId, next)
      entry.read = next
    } catch (e: unknown) {
      toast.add({ title: '操作失败', description: errorMessage(e, '标记已读失败'), color: 'error' })
    } finally {
      readBusy.value = false
    }
  }

  /** 收藏 / 取消收藏（工具栏）。切换结果由本地库返回，避免两端状态不一致 */
  const savedBusy = ref(false)

  async function toggleStar() {
    const entry = currentEntry.value
    if (!entry || savedBusy.value) return
    savedBusy.value = true
    try {
      entry.starred = await pouch.toggleSaved(entry.id, entry.feedId)
    } catch (e: unknown) {
      toast.add({ title: '操作失败', description: errorMessage(e, '收藏失败'), color: 'error' })
    } finally {
      savedBusy.value = false
    }
  }

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

  async function loadDetail(id: string | undefined) {
    const cached = id ? details.get(id) : null
    if (cached) {
      // 预取命中：整篇直接切换，不经过「只有标题的投影」那一帧
      detailEntry.value = cached
      detailLoading.value = false
      return
    }
    detailEntry.value = null
    detailLoading.value = !!id
    if (!id) return
    const full = await pouch.getEntry(id)
    if (currentEntry.value?.id !== id) return // 竞态：已切到别的条目，旧结果作废
    // 取不到全文时退回投影（至少能看标题），其余情况用全文
    detailEntry.value = full ?? currentEntry.value
    detailLoading.value = false
  }

  /** 正文区的渲染态：加载中是骨架屏，否则是条目 id；变化即触发淡入淡出 */
  const detailViewKey = computed(() => (detailLoading.value ? 'loading' : detailEntry.value?.id ?? 'empty'))

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
    detailViewKey,
    loadDetail,
    displayOf,
    isLoading,
    navWithHint
  }
}
