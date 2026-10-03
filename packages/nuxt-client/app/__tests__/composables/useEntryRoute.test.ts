import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref, watch, computed } from 'vue'
import type { Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { useEntryRoute } from '../../composables/useEntryRoute'
import { useEntryModal } from '../../composables/useEntryModal'
import { toEntryDocId, toEntryUrlId } from '../../utils/entryUrlId'
import type { RssEntry } from '../../types/rss'

// 复刻 Nuxt auto-import：useState 按 key 全局单例（详情状态要跨 composable 调用共享），
// useEntryModal 用真实实现而不是桩 —— 本文件测的正是它与路由之间的接线
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
const stateCache = new Map<string, Ref<unknown>>()
nuxtGlobals.useState = vi.fn(<T>(key: string, init: () => T) => {
  if (!stateCache.has(key)) stateCache.set(key, ref<T>(init()) as Ref<unknown>)
  return stateCache.get(key) as Ref<T>
})
nuxtGlobals.useEntryModal = useEntryModal
// useEntryModal（真实实现）里的 ref/computed/watch 依赖 Nuxt 自动导入，测试环境补上
nuxtGlobals.ref = ref
nuxtGlobals.watch = watch
nuxtGlobals.computed = computed

function makeEntry(n: number, feedId = 'feed-1'): RssEntry {
  return {
    id: `entry-${n}`,
    feedId,
    title: `标题 ${n}`,
    url: `https://example.com/${n}`,
    publishedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    insertedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    feed: { id: feedId, title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read: false,
    readingTime: 0
  }
}

const LIST_PATH = '/rss/feed/feed-1'
const entryPath = (id: string) => `${LIST_PATH}/entry/${id}`

/** 路由桩：params 是响应式的，改它等于一次客户端导航 */
let route: { params: { id: string, entryId?: string }, path: string }
const router = { replace: vi.fn(), back: vi.fn() }
const toastAdd = vi.fn()

beforeEach(() => {
  stateCache.clear()
  vi.clearAllMocks()
  route = reactive({ params: { id: 'feed-1', entryId: undefined as string | undefined }, path: LIST_PATH })
  nuxtGlobals.useRoute = () => route
  nuxtGlobals.useRouter = () => router
  nuxtGlobals.useToast = () => ({ add: toastAdd })
  setHistoryBack(null)
})

interface HarnessOptions {
  entries?: RssEntry[]
  fetched?: RssEntry | null
  belongs?: (entry: RssEntry) => boolean
  /** 条目 → 地址段；默认原样用条目 id，传真实口径时见下面「只留 hash」那个用例 */
  urlIdOf?: (entry: RssEntry) => string
  /** 按地址段取全文；默认忽略入参、返回 fetched */
  getEntry?: (urlId: string) => Promise<RssEntry | null>
}

/** 把 composable 放进一个真实组件里（onMounted 只在组件内生效），并交出它返回的接口 */
function harness(options: HarnessOptions = {}) {
  const entries = ref<RssEntry[]>(options.entries ?? [])
  const loadMore = vi.fn()
  const getEntry = vi.fn(options.getEntry ?? (async () => options.fetched ?? null))
  let api!: ReturnType<typeof useEntryRoute>

  const Comp = defineComponent({
    setup() {
      api = useEntryRoute({
        listPath: () => LIST_PATH,
        entryPath,
        urlIdOf: options.urlIdOf ?? (entry => entry.id),
        entries: () => entries.value,
        loadMore,
        hasMore: () => true,
        getEntry,
        belongs: options.belongs
      })
      return () => h('div')
    }
  })

  const wrapper = mount(Comp)
  return { wrapper, entries, getEntry, api }
}

/**
 * 造一条「上一条历史记录」：关闭详情时 composable 据此决定 back() 还是 replace()
 * （vue-router 把上一条地址记在 history.state.back 里）。
 */
function setHistoryBack(back: string | null) {
  Object.defineProperty(window.history, 'state', {
    value: back === null ? null : { back, current: back, forward: null, position: 1, replaced: false, scroll: null },
    configurable: true,
    writable: true
  })
}

describe('useEntryRoute', () => {
  it('深链首帧：地址里有 entryId 就按本地库全文打开详情', async () => {
    route.params.entryId = 'entry-7'
    const { wrapper, getEntry } = harness({ fetched: makeEntry(7) })
    await flushPromises()

    expect(getEntry).toHaveBeenCalledWith('entry-7')
    const modal = useEntryModal()
    expect(modal.isOpen.value).toBe(true)
    expect(modal.currentEntry.value?.id).toBe('entry-7')
    wrapper.unmount()
  })

  it('列表里就有这一篇时带上列表上下文：上/下一篇能沿列表翻', async () => {
    route.params.entryId = 'entry-2'
    const { wrapper } = harness({ entries: [makeEntry(1), makeEntry(2), makeEntry(3)] })
    await flushPromises()

    const modal = useEntryModal()
    expect(modal.currentEntry.value?.id).toBe('entry-2')
    expect(modal.canGoPrev.value).toBe(true)
    expect(modal.canGoNext.value).toBe(true)

    modal.goNext()
    expect(modal.currentEntry.value?.id).toBe('entry-3')
    wrapper.unmount()
  })

  it('详情里翻到下一篇 → 地址用 replace 跟着换（不往历史里压新记录）', async () => {
    route.params.entryId = 'entry-1'
    const { wrapper } = harness({ entries: [makeEntry(1), makeEntry(2)] })
    await flushPromises()

    useEntryModal().goNext()
    await nextTick()

    expect(router.replace).toHaveBeenCalledWith(entryPath('entry-2'))
    expect(router.back).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('从列表点开（历史的上一条就是列表页）：关闭时退回去，而不是再 replace 一条', async () => {
    const { wrapper, api } = harness({ entries: [makeEntry(1), makeEntry(2)] })
    await flushPromises()

    // EntryList 打开条目走这里：只拿地址，详情由路由监听打开
    expect(api.entryLink(makeEntry(2))).toBe(entryPath('entry-2'))

    // 模拟点击后的导航落地：地址变了，历史的上一条正是列表页
    setHistoryBack(LIST_PATH)
    route.params.entryId = 'entry-2'
    await flushPromises()
    const modal = useEntryModal()
    expect(modal.isOpen.value).toBe(true)

    // 关闭按钮 / Esc：地址经由历史退回列表页
    modal.closeEntry()
    await nextTick()
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.replace).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('深链进来的那一篇没有可退的历史：关闭时用 replace 换回列表页地址', async () => {
    setHistoryBack(null)
    route.params.entryId = 'entry-7'
    const { wrapper } = harness({ fetched: makeEntry(7) })
    await flushPromises()

    const modal = useEntryModal()
    expect(modal.isOpen.value).toBe(true)

    modal.closeEntry()
    await nextTick()
    expect(router.replace).toHaveBeenCalledWith(LIST_PATH)
    expect(router.back).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('地址回到列表页（浏览器返回键）→ 关闭详情并清掉列表上下文', async () => {
    route.params.entryId = 'entry-2'
    const { wrapper } = harness({ entries: [makeEntry(1), makeEntry(2)] })
    await flushPromises()

    const modal = useEntryModal()
    expect(modal.isOpen.value).toBe(true)

    route.params.entryId = undefined
    await nextTick()

    expect(modal.isOpen.value).toBe(false)
    expect(modal.entries.value).toEqual([])
    // 地址已由浏览器退好，不该再动历史
    expect(router.back).not.toHaveBeenCalled()
    expect(router.replace).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('本地库没有这一篇 → 提示并退回列表页地址', async () => {
    route.params.entryId = 'entry-404'
    const { wrapper } = harness({ fetched: null })
    await flushPromises()

    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '找不到这篇文章' }))
    expect(router.replace).toHaveBeenCalledWith(LIST_PATH)
    expect(useEntryModal().isOpen.value).toBe(false)
    wrapper.unmount()
  })

  it('条目不属于地址里的订阅源 → 同样按找不到处理', async () => {
    route.params.entryId = 'entry-9'
    const { wrapper } = harness({
      fetched: makeEntry(9, 'feed-2'),
      belongs: entry => entry.feedId === 'feed-1'
    })
    await flushPromises()

    expect(toastAdd).toHaveBeenCalled()
    expect(useEntryModal().isOpen.value).toBe(false)
    wrapper.unmount()
  })

  it('深链先取到全文、列表随后就绪：attachListContext 补上上下文且不重开详情', async () => {
    route.params.entryId = 'entry-2'
    const { wrapper, entries, api } = harness({ fetched: makeEntry(2) })
    await flushPromises()

    const modal = useEntryModal()
    const openedEntry = modal.currentEntry.value
    expect(modal.currentEntry.value?.id).toBe('entry-2')
    expect(modal.canGoNext.value).toBe(false) // 还没有列表上下文

    // 列表加载完成
    entries.value = [makeEntry(1), makeEntry(2), makeEntry(3)]
    api.attachListContext()
    await nextTick()

    expect(modal.currentEntry.value).toBe(openedEntry) // 同一个对象：详情没有被重开
    expect(modal.canGoPrev.value).toBe(true)
    expect(modal.canGoNext.value).toBe(true)
    wrapper.unmount()
  })

  it('父级页面重建（地址里的源换了）时不重开同一篇：只把列表上下文换成新页的', async () => {
    route.params.entryId = 'entry-2'
    const first = harness({ entries: [makeEntry(1), makeEntry(2), makeEntry(3)] })
    await flushPromises()

    const modal = useEntryModal()
    const openedEntry = modal.currentEntry.value
    expect(modal.canGoNext.value).toBe(true)
    first.wrapper.unmount()

    // 新页面实例（同一地址、新的列表）：详情已经在显示这一篇，只换上下文、不再取一次全文
    const second = harness({ entries: [] })
    await flushPromises()

    expect(second.getEntry).not.toHaveBeenCalled()
    expect(modal.currentEntry.value).toBe(openedEntry)
    expect(modal.isOpen.value).toBe(true)

    second.entries.value = [makeEntry(2)]
    second.api.attachListContext()
    await nextTick()
    expect(modal.currentEntry.value).toBe(openedEntry)
    expect(modal.canGoNext.value).toBe(false) // 新列表只有这一条
    second.wrapper.unmount()
  })

  it('地址里没有条目时挂载：关掉上一页留下的详情（跨页切换的兜底）', async () => {
    // 上一页（另一个源 / 另一个列表）在读一篇
    route.params.entryId = 'entry-2'
    const first = harness({ entries: [makeEntry(1), makeEntry(2)] })
    await flushPromises()
    const modal = useEntryModal()
    expect(modal.isOpen.value).toBe(true)
    first.wrapper.unmount()

    // 换到地址里没有条目的页：旧页面卸载时排队的监听会被 Vue 作废，只能由新页面兜底关掉，
    // 否则它会以弹窗形式落到这一页上（三栏阅读栏里切到另一个源就是这个现象）
    route.params.entryId = undefined
    const second = harness({ entries: [makeEntry(5)] })
    await flushPromises()

    expect(modal.isOpen.value).toBe(false)
    expect(modal.entries.value).toEqual([]) // 列表上下文也清掉，阅读栏回到空态
    second.wrapper.unmount()
  })

  it('地址段只留 hash：文档 id 的 `entry:<feedId>:` 前缀不写进地址，取全文时再拼回去', async () => {
    const feedId = 'feed-1'
    const docA = `entry:${feedId}:aaaa11112222`
    const docB = `entry:${feedId}:bbbb33334444`
    // 还没上屏的旧条目：只存在于「本地库」里，不在当前列表窗口
    const docC = `entry:${feedId}:cccc55556666`
    const list = [{ ...makeEntry(1), id: docA }, { ...makeEntry(2), id: docB }]
    const db = [...list, { ...makeEntry(3), id: docC }]

    // 与单源页同一套口径：段里只留 hash，取文档时用 toEntryDocId 还原
    const getEntry = vi.fn(async (urlId: string) =>
      db.find(entry => entry.id === toEntryDocId(urlId, feedId)) ?? null)
    const { wrapper, api } = harness({
      entries: list,
      urlIdOf: entry => toEntryUrlId(entry.id, feedId),
      getEntry
    })
    await flushPromises()

    // 列表点开：地址是短 id
    expect(api.entryLink(list[1]!)).toBe(`${LIST_PATH}/entry/bbbb33334444`)

    // 深链到一篇没上屏的旧条目：把短 id 交给页面去取全文
    route.params.entryId = 'cccc55556666'
    await flushPromises()
    expect(getEntry).toHaveBeenCalledWith('cccc55556666')
    expect(useEntryModal().currentEntry.value?.id).toBe(docC)
    expect(router.replace).not.toHaveBeenCalled() // 地址里的段本来就是短 id，不必再规范化

    // 再从列表点开一篇（带上列表上下文）：翻到上一篇时地址换成那一篇的短 id
    route.params.entryId = 'bbbb33334444'
    await flushPromises()
    expect(useEntryModal().currentEntry.value?.id).toBe(docB)
    useEntryModal().goPrev()
    await nextTick()
    expect(router.replace).toHaveBeenCalledWith(`${LIST_PATH}/entry/aaaa11112222`)
    wrapper.unmount()
  })
})
