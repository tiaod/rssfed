import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import EntryList from '../../components/EntryList.vue'
import EntryListSkeleton from '../../components/EntryListSkeleton.vue'
import type { RssEntry } from '../../types/rss'
import type { ListView } from '../../utils/listViews'
import { TABLE_ROW_HEIGHT } from '../../utils/listViewLayout'

/**
 * 首屏骨架的契约只有两条，两条都是「替换上去不跳版」的前提：
 *
 *   1. **单根节点并继承外部 class** —— 页面把它当列表容器本身来排（`min-h-0 flex-1`），
 *      多根节点时 Vue 不再自动继承属性，高度当场丢掉。
 *   2. **单条尺寸与 EntryList.estimateHeight 同源** —— 骨架的高度和随后渲染出来的条目、
 *      以及列表据此估算的滚动总高必须是同一套数字，否则加载完页面会跳一下。
 *
 * 纯配色 / 圆角这类细节不在这里断言（见 AGENTS.md 的 UI 规范）。
 */

const STUBS = {
  USkeleton: { template: '<div class="skeleton" />' },
  // 真实列表的虚拟化外壳：单测里退化成「把 items 全渲染出来」，virtualize 参数仍从 props 读得到
  // （这里只取它的 estimateSize，用来看页尾骨架该有多高）
  UScrollArea: {
    name: 'ScrollArea',
    props: ['items', 'virtualize', 'ui'],
    template: '<div class="scroll-area"><div v-for="(item, index) in items" :key="item.id ?? index"><slot :item="item" :index="index" /></div></div>'
  },
  UBlogPost: {
    name: 'UBlogPost',
    props: ['title', 'description', 'date', 'image', 'authors', 'ui'],
    template: '<div class="blog-post" />'
  },
  /*
   * 条目组件只用来给真实列表凑一条内容（`listItems` 为空时 estimateSize 退化成 72 的兜底值，
   * 就取不到页尾骨架的估算）。它们各自的 composable（usePouchDb / useToast）与本文件无关，
   * 换成空壳即可 —— 这里要的只是「列表里有一条真条目」这个形状。
   */
  EntrySocialItem: { name: 'EntrySocialItem', template: '<div class="entry-item" />' },
  EntryCardItem: { name: 'EntryCardItem', template: '<div class="entry-item" />' },
  EntryBlogItem: { name: 'EntryBlogItem', template: '<div class="entry-item" />' },
  EntryRowItem: { name: 'EntryRowItem', template: '<div class="entry-item" />' },
  EntryImageItem: { name: 'EntryImageItem', template: '<div class="entry-item" />' }
}

/** 单测环境没有 Nuxt 自动导入：EntryList 挂载时会用到的全局这里只需空壳 */
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useEntryModal = () => ({
  openEntry: () => {},
  isOpen: { value: false },
  currentEntry: { value: null },
  navigatedInDetail: { value: false }
})
testGlobals.useIntersectionObserver = () => ({ pause: () => {}, resume: () => {}, stop: () => {} })

function makeEntry(): RssEntry {
  return {
    id: 'entry-1',
    feedId: 'feed-1',
    title: '文章标题',
    url: 'https://a.example/1',
    publishedAt: '2026-07-01T00:00:00.000Z',
    insertedAt: '2026-07-01T00:00:00.000Z',
    feed: {
      id: 'feed-1',
      title: '某科技周刊',
      siteUrl: 'https://a.example',
      feedUrl: 'https://a.example/feed',
      lastFetchedAt: ''
    },
    starred: false,
    read: false,
    readingTime: 0
  }
}

/** 页面就是这么用的：骨架顶替列表本身，高度由外部 class 给 */
function mountSkeleton(props: Record<string, unknown> = {}) {
  return mount(EntryListSkeleton, {
    props,
    attrs: { class: 'min-h-0 flex-1' },
    global: { stubs: STUBS }
  })
}

/** 占位条目：结构统一是「隐藏容器 > 布局容器（flex 列 / grid）> 条目」，按层级取即可 */
function itemWrappers(wrapper: ReturnType<typeof mountSkeleton>) {
  const container = wrapper.get('[aria-hidden="true"]').element.firstElementChild
  return [...(container?.children ?? [])] as HTMLElement[]
}

/**
 * 把同一份 view 交给真实列表，取出它对「页尾骨架」的估算高度 —— 那正是首屏骨架单条该有的尺寸
 * （EntryList.estimateHeight 的 isSkeleton 分支与真条目同一口径）。列表里要塞一条真条目，
 * 否则 `listItems` 为空、估算退化成 72 的兜底值。
 */
function skeletonEstimate(view: ListView): number {
  const list = mount(EntryList, {
    props: { entries: [makeEntry()], view, loadMore: () => {}, hasMore: () => true },
    global: { stubs: STUBS }
  })
  const virtualize = list.findComponent({ name: 'ScrollArea' }).props('virtualize') as {
    estimateSize: (index: number) => number
  }
  return virtualize.estimateSize(1) // 0 是真条目，1 是每列一个的页尾骨架
}

describe('EntryListSkeleton 根节点契约', () => {
  it('单根节点：页面传的 class（min-h-0 flex-1）落到根上，高度由外部决定', () => {
    const wrapper = mountSkeleton({ view: 'social' })

    expect(wrapper.classes()).toContain('min-h-0')
    expect(wrapper.classes()).toContain('flex-1')
  })

  it('内边距与 ScrollArea 根节点成对：px-4 sm:px-6（表格例外，它的内边距在单元格上）', () => {
    const social = mountSkeleton({ view: 'social' })
    expect(social.classes()).toContain('px-4')
    expect(social.classes()).toContain('sm:px-6')

    const table = mountSkeleton({ view: 'table' })
    expect(table.classes()).not.toContain('px-4') // 多给一层会让列头比真实表格缩进一格
  })

  it('读屏只报一次「正在加载」，占位树整体对读屏隐藏（几十个 USkeleton 不该念几十遍）', () => {
    const wrapper = mountSkeleton({ view: 'masonry' })

    expect(wrapper.element.getAttribute('aria-busy')).toBe('true')
    expect(wrapper.get('[role="status"]').text()).toContain('正在加载')
    // get() 拿不到会直接抛错，所以「占位树整棵对读屏隐藏」已经是断言本身
    expect(wrapper.get('[aria-hidden="true"]').element).toBeTruthy()
  })

  it('不出现转圈：首屏骨架全程只有 USkeleton', () => {
    for (const view of ['social', 'masonry', 'blog', 'list', 'table', 'image'] as ListView[]) {
      expect(mountSkeleton({ view }).find('[class*="animate-spin"]').exists(), view).toBe(false)
    }
  })

  it('count 决定条目数（默认 6）；表格多一条列头', () => {
    expect(itemWrappers(mountSkeleton({ view: 'list' }))).toHaveLength(6)
    expect(itemWrappers(mountSkeleton({ view: 'list', count: 3 }))).toHaveLength(3)
    expect(itemWrappers(mountSkeleton({ view: 'table', count: 2 }))).toHaveLength(3)
  })
})

describe('EntryListSkeleton 与 estimateHeight 同尺寸', () => {
  it('社交动态：单条补足到 170（文字档），与 EntryList 对页尾骨架的估算一致', () => {
    const wrapper = mountSkeleton({ view: 'social' })

    // 内部块加起来只有 ~118，不补这一档整条就比真条目矮 50px
    expect(itemWrappers(wrapper)[0]!.getAttribute('style')).toContain('min-height: 170px')
    expect(skeletonEstimate('social')).toBe(170)
  })

  it('列表 / 表格的行高与 EntryList 的估算值一致（96 / 37）', () => {
    for (const row of itemWrappers(mountSkeleton({ view: 'list' }))) {
      expect(row.getAttribute('style')).toContain('height: 96px')
    }
    expect(skeletonEstimate('list')).toBe(96)

    const table = mountSkeleton({ view: 'table' })
    const rows = itemWrappers(table).slice(1) // 第一条是列头
    for (const row of rows) {
      expect(row.getAttribute('style')).toContain(`height: ${TABLE_ROW_HEIGHT}px`)
    }
    // 表格不走泳道虚拟化，行高是写死的常数（UTable 不逐行测量）
    expect(TABLE_ROW_HEIGHT).toBe(37)
  })

  it('博客：多列等高 352（EntryBlogItem 的 h-[22rem]），单列放宽到 336', async () => {
    const original = window.innerWidth
    try {
      window.innerWidth = 1024 // happy-dom 默认宽度 → 博客两列 → 写死等高
      const multi = mountSkeleton({ view: 'blog', count: 1 })
      await nextTick()
      expect(itemWrappers(multi)[0]!.getAttribute('style')).toContain('min-height: 352px')

      // 单列没有行要对齐，高度交回内容（与 blogEstimateHeight 的单列有封面档同源）
      window.innerWidth = 390
      const single = mountSkeleton({ view: 'blog', count: 1 })
      await nextTick()
      expect(itemWrappers(single)[0]!.getAttribute('style')).toContain('min-height: 336px')
    } finally {
      window.innerWidth = original
    }
  })

  it('多列视图的列数与 EntryList 的 lanes 同一个断点表（骨架三列、条目两列就是跳版）', async () => {
    const original = window.innerWidth
    try {
      window.innerWidth = 800 // 平板：瀑布流三列、博客两列
      const masonry = mountSkeleton({ view: 'masonry', count: 1 })
      const blog = mountSkeleton({ view: 'blog', count: 1 })
      await nextTick()

      const gridStyleOf = (wrapper: ReturnType<typeof mountSkeleton>) =>
        wrapper.get('[aria-hidden="true"]').element.firstElementChild!.getAttribute('style') ?? ''

      expect(gridStyleOf(masonry)).toContain('repeat(3, minmax(0, 1fr))')
      expect(gridStyleOf(blog)).toContain('repeat(2, minmax(0, 1fr))')
      // 间距也来自共享的 VIEW_GAP，不是模板里另写的 class
      expect(gridStyleOf(masonry)).toContain('gap: 16px')
      expect(gridStyleOf(blog)).toContain('gap: 24px')
    } finally {
      window.innerWidth = original
    }
  })

  it('图片视图：按 4:3 兜底比例占位（与 entryCoverAspect 的兜底同一个数）', () => {
    const tiles = itemWrappers(mountSkeleton({ view: 'image', count: 1 }))
    expect(tiles[0]!.getAttribute('style')).toContain(String(4 / 3))
  })
})
