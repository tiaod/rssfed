import type { RssEntry } from '~/types/rss'

/**
 * 推进列表无限加载所需的上下文，由列表页随 openEntry 注入。
 * 弹窗滑近列表末尾时用它预加载下一页；hasMore 用来区分「正在路上」和「真没有更多了」。
 */
export interface EntryListLoader {
  /** 拉取下一页数据并入列（列表页自身的单飞保护负责折叠并发调用） */
  loadMore(): unknown
  /** 是否还可能加载出更多条目 */
  hasMore(): boolean
}

/**
 * 条目详情模态弹窗的全局状态。
 *
 * 用模态替代独立路由页面，避免页面切换导致列表滚动状态丢失。
 * 状态通过 useState 在组件间共享，EntryList 触发 openEntry，
 * 在 layout 中全局渲染的 EntryDetailModal 监听 isOpen。
 *
 * 上一篇/下一篇：openEntry 时由列表组件注入「当前可见列表」的取值函数（而非快照）。
 * 这样无限滚动加载出新一批条目后，翻页范围会随列表自动扩大；
 * 关闭弹窗时把列表清空，避免闭包残留已经离开的页面数据。
 * 若打开入口不传列表（未来可能的其他入口），前后翻页自然不可用。
 *
 * 预加载：滑到距列表末尾 TAIL_PRELOAD 条以内且列表还有更多时，按当前列表长度去重触发一次
 * loadMore，让下一页内容「等在路上」；数据返回后翻页范围自动扩大。已加载完毕（hasMore 为假）
 * 或列表来自静态快照（未注入 loader）时不再预载，此时翻过最后一条由界面提示。
 */
export function useEntryModal() {
  const isOpen = useState<boolean>('entry-modal-open', () => false)
  const currentEntry = useState<RssEntry | null>('entry-modal-current', () => null)
  /** 当前条目所属列表的取值函数（最近一次打开时注入）；不注入时为 null */
  const listGetter = useState<(() => RssEntry[]) | null>('entry-modal-list', () => null)
  /** 列表的无限加载上下文（最近一次打开时注入）；不注入时不做预加载与尽头提示 */
  const loader = useState<EntryListLoader | null>('entry-modal-loader', () => null)

  /** 所属列表的响应式视图（取值时触达实际列表，随无限滚动 grow）；无列表上下文时为空数组 */
  const entries = computed(() => listGetter.value?.() ?? [])

  function openEntry(entry: RssEntry, getList?: () => RssEntry[], listLoader?: EntryListLoader) {
    currentEntry.value = entry
    listGetter.value = getList ?? null
    loader.value = listLoader ?? null
    firedAtLength.value = -1
    isOpen.value = true
  }

  function closeEntry() {
    listGetter.value = null
    loader.value = null
    firedAtLength.value = -1
    isOpen.value = false
  }

  /** 当前条目在列表中的下标；不在列表中（或尚无列表上下文）时返回 -1 */
  function entryIndex(): number {
    const curId = currentEntry.value?.id
    if (!curId) return -1
    return (listGetter.value?.() ?? []).findIndex(e => e.id === curId)
  }

  /** 在所属列表中向 dir（-1 上一篇 / +1 下一篇）移动一格；越界时不移动并返回 null */
  function navEntry(dir: -1 | 1): RssEntry | null {
    const list = listGetter.value?.() ?? []
    const idx = entryIndex()
    const next = idx + dir
    if (idx === -1 || next < 0 || next >= list.length) return null
    currentEntry.value = list[next]!
    return currentEntry.value
  }

  // 可达性跟随列表 grow 动态计算：listGetter 取值时会读响应式的 entries，长度变化同样触发
  const canGoPrev = computed(() => isOpen.value && entryIndex() > 0)

  const canGoNext = computed(() => {
    const idx = entryIndex()
    if (!isOpen.value || idx < 0) return false
    return idx < (listGetter.value?.().length ?? 0) - 1
  })

  // ── 尾部预加载：滑到距末端 TAIL_PRELOAD 条内且还有更多时，再拉一批备着 ──
  const TAIL_PRELOAD = 3
  /** 上一次触发预加载时的列表长度：数据未返回、长度未变期间不重复触发 */
  const firedAtLength = ref(-1)

  watch(
    () => entryIndex(),
    (idx) => {
      const ldr = loader.value
      const list = listGetter.value?.() ?? []
      if (!ldr || !isOpen.value || idx < 0 || list.length === 0) return
      if (!ldr.hasMore() || idx < list.length - TAIL_PRELOAD) return
      if (list.length === firedAtLength.value) return
      firedAtLength.value = list.length
      void ldr.loadMore()
    }
  )

  /** 已停在列表最后一条且确认没有更多数据：继续往后翻不应再静默失败，而是提示用户 */
  function isLastWithNoMore(): boolean {
    const list = listGetter.value?.() ?? []
    const idx = entryIndex()
    return isOpen.value && idx >= 0 && idx === list.length - 1 && !!loader.value && !loader.value.hasMore()
  }

  return {
    isOpen,
    currentEntry,
    entries,
    openEntry,
    closeEntry,
    goPrev: () => navEntry(-1),
    goNext: () => navEntry(1),
    canGoPrev,
    canGoNext,
    isLastWithNoMore
  }
}
