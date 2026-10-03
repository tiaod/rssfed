import { computed, onMounted, watch } from 'vue'
import type { RssEntry } from '~/types/rss'

export interface UseEntryRouteOptions {
  /** 列表页地址（关闭详情后退回这里），如 `/rss/feed/:id` */
  listPath: () => string
  /** 某篇的详情地址；入参是地址里用的那一段 id（见 urlIdOf），如 `/rss/feed/:id/entry/:urlId` */
  entryPath: (urlId: string) => string
  /**
   * 条目 → 地址里用的那一段 id。
   *
   * 地址已经带着源 id 时（单源页），段里不必再重复 `entry:<feedId>:`，留 hash 就够
   * （见 utils/entryUrlId）。列表匹配、翻篇换地址都走它，保证「地址里的 id」只有一处口径。
   */
  urlIdOf: (entry: RssEntry) => string
  /** 当前可见列表（取值函数而非快照：无限滚动加载出的新条目要能继续翻） */
  entries: () => RssEntry[]
  /** 加载下一页（详情滑到列表末尾时的预加载入口） */
  loadMore: () => unknown
  /** 是否还有更多条目（详情停在末条时的提示口径） */
  hasMore: () => boolean
  /** 按地址里的那一段取全文：列表里没有这一篇（深链到没上屏的旧条目）时用 */
  getEntry: (urlId: string) => Promise<RssEntry | null>
  /** 这一篇是否属于本页；地址里的源与条目对不上时按「找不到」处理 */
  belongs?: (entry: RssEntry) => boolean
}

/**
 * 列表页的「地址 ↔ 详情」接线：地址里的 entryId 是唯一真源。
 *
 * **为什么不给详情单开一个路由页面**：页面切换会把列表整块重建（滚动位置、列表快照全丢，
 * 见 useEntryModal 的说明）。所以详情仍由全局的弹窗 / 常驻阅读栏承载，列表原地不动，
 * 这里只补上地址这一层：
 *
 *   1. 路由 → 详情：地址里带着 entryId 就打开它，地址回到列表页就关掉；
 *   2. 详情 → 路由：详情里翻到上/下一篇、点关闭时把地址跟着换掉 ——
 *      否则刷新或分享拿到的还是旧的那一篇。
 *
 * 地址里的 id 与本地库的文档 id 不是同一个字符串（前者可以省掉源前缀），两者的换算由
 * `urlIdOf` / `getEntry` 注入，本 composable 只按「地址里的那一段」比对。
 *
 * 历史记录：从列表点开的那一篇走 push（历史里留下列表页，浏览器返回键＝关闭详情），
 * 关闭时退回去；深链 / 站内跳进来的那篇没有可退的历史，用 replace 直接换回列表页地址
 * （判据是上一条历史记录本身，见 previousPath）。弹窗自己那套「打开时压一条历史」的机制
 * 在地址已经承载条目时必须让位，见 EntryDetailModal。
 */
export function useEntryRoute(options: UseEntryRouteOptions) {
  const route = useRoute()
  const router = useRouter()
  const toast = useToast()
  const { isOpen, currentEntry, openEntry, closeEntry, setListContext } = useEntryModal()

  const routeEntryId = computed(() => (route.params.entryId as string | undefined) ?? '')

  /** 当前正在读的那篇在地址里的那一段 id；没在读 / 无条目时为空串 */
  function currentUrlId(): string {
    const cur = currentEntry.value
    return cur ? options.urlIdOf(cur) : ''
  }

  /** 列表里找地址段对应的那一篇（找不到返回 undefined） */
  function findInList(urlId: string): RssEntry | undefined {
    return options.entries().find(entry => options.urlIdOf(entry) === urlId)
  }

  /** EntryList 打开条目时调用的地址构造：先导航，详情由下面的路由监听打开 */
  function entryLink(entry: RssEntry): string {
    return options.entryPath(options.urlIdOf(entry))
  }

  /** 列表上下文：详情滑到列表末尾时的预加载入口与尽头提示都靠它 */
  function listLoader() {
    return { loadMore: options.loadMore, hasMore: options.hasMore }
  }

  /**
   * 上一条历史记录的地址（vue-router 记在 `history.state.back` 里的路径）。
   *
   * 关闭详情时据它决定怎么退回列表页：上一条就是列表页 → `back()` 退回去（从列表点开的情形，
   * 历史里干干净净）；否则（深链冷加载、从别的页面跳进来）→ `replace()` 换掉当前地址，
   * 免得把用户甩出应用。**不看「是不是我们 push 的」标志位**：点击与导航之间可能什么都没发生
   * （例如重复点当前这一篇），标志位会留着假信息。
   */
  function previousPath(): string {
    if (typeof window === 'undefined') return ''
    const state = window.history.state as { back?: string | null } | null
    return state?.back ?? ''
  }

  /** 详情关闭后回到列表页：能退就退，退不了就换 */
  function exitDetail() {
    if (previousPath() === options.listPath()) {
      router.back()
      return
    }
    void router.replace(options.listPath())
  }

  /** 列表里找得到这一篇就把列表上下文注入进去（找不到则不动，保留原来的上下文） */
  function attachListContext() {
    const urlId = routeEntryId.value
    if (!urlId || !isOpen.value || currentUrlId() !== urlId) return
    if (!findInList(urlId)) return
    setListContext(options.entries, listLoader())
  }

  /** 按地址打开某一篇 */
  async function openFromRoute(urlId: string) {
    const inList = findInList(urlId)

    if (isOpen.value && currentUrlId() === urlId) {
      // 详情已经是这一篇（页内重复点、父级页面重建后重新入列）：只把列表上下文换成当前列表，
      // 不重开详情 —— 重开会把正文重新加载一遍、阅读位置也丢
      if (inList) setListContext(options.entries, listLoader())
      return
    }

    if (inList) {
      // 列表里就有：连列表上下文一起注入，上/下一篇沿当前列表走
      openEntry(inList, options.entries, listLoader())
      return
    }

    // 列表里没有（深链到尚未上屏的旧条目）：直接取本地库全文，此时没有上/下篇可翻
    const full = await options.getEntry(urlId)
    if (routeEntryId.value !== urlId) return // 等待期间地址又变了，旧结果作废
    if (full && (options.belongs ? options.belongs(full) : true)) {
      openEntry(full)
      return
    }

    // 本地库没有这一篇（链接来自别的设备 / 还没同步到本地）：说清楚并退回列表页
    toast.add({
      title: '找不到这篇文章',
      description: '它可能还没有同步到这台设备',
      color: 'error'
    })
    void router.replace(options.listPath())
  }

  /**
   * 深链首帧：地址里带着某篇时把它打开；地址里没有条目时，确保没有详情留在展示面上。
   *
   * 放在 onMounted 而不是 setup 里的 immediate watch：服务端拿不到本地库（条目全在 PouchDB），
   * 也不该让 SSR 产物先渲染出一个打开的弹窗再让客户端对不上。
   *
   * 关闭这一半是**跨页切换**的兜底：离开某一页时，它自己的路由监听（`watch(routeEntryId)`）
   * 不可靠 —— 组件卸载会让已排队的 pre 监听一起作废，于是上一页在读的那篇留在共享状态里，
   * 到新页面上以弹窗形式冒出来（三栏阅读栏里切到另一个源就是这个现象）。详情是这一页地址的
   * 一部分，地址里没有它就等于没打开。
   */
  onMounted(() => {
    const urlId = routeEntryId.value
    if (urlId) {
      void openFromRoute(urlId)
      return
    }
    closeEntry()
  })

  // 路由 → 详情：地址里的 entryId 变了就跟着开关（首帧由上面的 onMounted 负责）
  watch(routeEntryId, (urlId, prev) => {
    if (!urlId) {
      // 地址回到列表页（浏览器返回键、关闭后的地址回退）→ 关掉详情并清掉列表上下文。
      // 首帧（prev 为 undefined）不关：那时可能是从别的页面带着弹窗跳过来的，保持原行为。
      if (prev) closeEntry()
      return
    }
    void openFromRoute(urlId)
  })

  // 详情 → 路由：上/下一篇改的是当前条目，地址要跟着换。
  // 用 replace：翻十篇不该在历史里压十条，返回键永远只描述「列表 ↔ 这一篇」。
  watch(() => currentEntry.value?.id, (id) => {
    if (!isOpen.value || !id) return
    const urlId = currentUrlId()
    // 地址里已经是这一段就什么都不用做；旧地址（段里带前缀）会在这一步被顺手规范化
    if (!urlId || routeEntryId.value === urlId) return
    void router.replace(options.entryPath(urlId))
  })

  // 详情关闭（关闭按钮 / Esc / 划卡到尽头 / 阅读栏的 X）：地址退回列表页，否则刷新会把它又打开
  watch(isOpen, (open) => {
    if (open || !routeEntryId.value) return
    exitDetail()
  })

  return { routeEntryId, entryLink, attachListContext }
}
