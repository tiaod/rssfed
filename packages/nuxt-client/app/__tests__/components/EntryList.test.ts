import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import EntryList from '../../components/EntryList.vue'
import type { RssEntry } from '../../types/rss'
import type { ListView } from '../../utils/listViews'

/**
 * 时间线和分类页（跨多个源的聚合视图）显示「订阅源名 + 源图标」，
 * 单源页保持显示条目作者（源已经在页面标题里）。
 *
 * 图标必须走自定义渲染：UBlogPost 的 authors 数组会渲染 UUser，头像默认 32px
 * 且带 hover 放大动画。这里断言的是「showFeed 分支渲染 UAvatar（3xs）+ 源名」，
 * 「单源分支仍渲染 UUser 的作者名」。
 */

/** 详情状态（宽屏阅读栏 / 窄屏弹窗共用）：列表据此给当前那篇高亮 */
const modalState = { isOpen: ref(false), currentEntry: ref<RssEntry | null>(null) }
/** 打开详情：表格视图的行点击 / Enter 也要走到这里 */
const openEntryMock = vi.fn()

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useEntryModal = () => ({
  openEntry: openEntryMock,
  isOpen: modalState.isOpen,
  currentEntry: modalState.currentEntry
})
// EntryList 用 IntersectionObserver 观察页尾骨架（骨架可见即触底加载）
testGlobals.useIntersectionObserver = vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }))

/**
 * 表格视图的 UTable 退化成「按 columns 渲染列头 + 按 data 渲染行」：
 * slot context 只造出组件真实给的 `row`（EntryList 的单元格只用得到 `row.original`），
 * 行级 class 仍走 UTable 自己的 meta 口径（已读淡显挂在那里），点击也照它转发 onSelect。
 */
const UTableStub = {
  name: 'Table',
  props: ['data', 'columns', 'meta', 'virtualize', 'sticky', 'ui', 'onSelect', 'empty'],
  template: `
    <table class="table">
      <thead>
        <tr><th v-for="col in columns" :key="col.id">{{ col.header }}</th></tr>
      </thead>
      <tbody>
        <slot name="body-top" />
        <tr
          v-for="item in data"
          :key="item.id"
          class="table-row"
          :class="meta?.class?.tr?.({ original: item }) ?? ''"
          @click="onSelect?.($event, { original: item })"
        >
          <td v-for="col in columns" :key="col.id" :class="'col-' + col.id">
            <slot :name="col.id + '-cell'" :row="{ original: item }" />
          </td>
        </tr>
        <slot name="body-bottom" />
      </tbody>
    </table>
  `
}

const STUBS = {
  // ScrollArea（虚拟化）在单测里退化成「把 items 全渲染出来」
  UScrollArea: {
    name: 'ScrollArea',
    props: ['items', 'virtualize', 'ui'],
    template: '<div class="scroll-area"><div v-for="(item, index) in items" :key="item.id ?? index" class="cell"><slot :item="item" :index="index" /></div></div>'
  },
  USkeleton: { template: '<div class="skeleton" />' },
  UBlogPost: {
    name: 'UBlogPost',
    props: ['title', 'description', 'date', 'image', 'authors', 'ui'],
    template: '<div class="blog-post"><slot name="badge" /><slot name="header" /><slot name="authors" /></div>'
  },
  ULink: {
    name: 'ULink',
    props: ['to'],
    template: '<a class="feed-link" :href="to"><slot /></a>'
  },
  UAvatar: {
    name: 'UAvatar',
    props: ['src', 'alt', 'text', 'size'],
    template: '<span class="avatar" :data-src="src" :data-text="text" :data-size="size"></span>'
  },
  UUser: {
    name: 'UUser',
    props: ['name', 'to'],
    template: '<span class="user">{{ name }}</span>'
  },
  UTable: UTableStub
}

function makeEntry(over: Partial<RssEntry> = {}): RssEntry {
  return {
    id: 'entry-1',
    feedId: 'feed-1',
    title: '文章标题',
    url: 'https://a.example/1',
    author: '张三',
    publishedAt: '2026-07-01T00:00:00.000Z',
    insertedAt: '2026-07-01T00:00:00.000Z',
    feed: {
      id: 'feed-1',
      title: '某科技周刊',
      siteUrl: 'https://a.example',
      feedUrl: 'https://a.example/feed',
      image: 'blob:feed-icon',
      lastFetchedAt: ''
    },
    starred: false,
    read: false,
    readingTime: 0,
    ...over
  }
}

function mountList(entries: RssEntry[], showFeed?: boolean, view?: ListView) {
  return mount(EntryList, {
    props: { entries, ...(showFeed === undefined ? {} : { showFeed }), ...(view ? { view } : {}) },
    global: { stubs: STUBS }
  })
}

beforeEach(() => {
  modalState.isOpen.value = false
  modalState.currentEntry.value = null
})

/** 单测里 ScrollArea 退化成把 items 全渲染，虚拟化参数仍从 props 里读得到 */
function virtualizeOf(wrapper: ReturnType<typeof mountList>) {
  return wrapper.findComponent({ name: 'ScrollArea' }).props('virtualize') as {
    lanes: number
    gap: number
    estimateSize: (index: number) => number
  }
}

describe('EntryList 卡片署名', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('时间线（showFeed）：显示订阅源名与源图标，并链接到源站点', () => {
    const wrapper = mountList([makeEntry()], true)

    expect(wrapper.find('.user').exists()).toBe(false)
    expect(wrapper.get('.feed-link').attributes('href')).toBe('https://a.example')
    expect(wrapper.text()).toContain('某科技周刊')

    const avatar = wrapper.get('.avatar')
    expect(avatar.attributes('data-src')).toBe('blob:feed-icon')
    expect(avatar.attributes('data-size')).toBe('3xs') // 与文字同高，不用 UUser 默认的 md(32px)
  })

  it('时间线：源没有图标时退回名字首字母，头像位不留空', () => {
    const entry = makeEntry()
    entry.feed.image = undefined
    const avatar = mountList([entry], true).get('.avatar')

    expect(avatar.attributes('data-src')).toBeUndefined()
    expect(avatar.attributes('data-text')).toBe('某')
  })

  it('单源页（不传 showFeed）：保持显示条目作者，不渲染源图标', () => {
    const wrapper = mountList([makeEntry()])

    expect(wrapper.get('.user').text()).toBe('张三')
    expect(wrapper.find('.avatar').exists()).toBe(false)
  })

  it('单源页：条目无作者时仍回退到源名', () => {
    const wrapper = mountList([makeEntry({ author: undefined })])

    expect(wrapper.get('.user').text()).toBe('某科技周刊')
  })
})

describe('EntryList 页尾加载骨架', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('还有更多时把骨架排在列表末尾（虚拟化靠它触发加载）', () => {
    const wrapper = mount(EntryList, {
      props: { entries: [makeEntry()], loadMore: vi.fn(), hasMore: () => true },
      global: { stubs: STUBS }
    })

    // 真实条目 + 页尾骨架：骨架排在最后
    const cells = wrapper.findAll('.cell')
    expect(cells.length).toBeGreaterThan(1)
    expect(wrapper.find('.skeleton').exists()).toBe(true)
    expect(cells.at(-1)!.find('.skeleton').exists()).toBe(true)
  })

  it('没有更多时不渲染骨架', () => {
    const wrapper = mount(EntryList, {
      props: { entries: [makeEntry()], loadMore: vi.fn(), hasMore: () => false },
      global: { stubs: STUBS }
    })

    expect(wrapper.find('.skeleton').exists()).toBe(false)
  })

  it('静态列表（不传 loadMore）时不渲染骨架', () => {
    const wrapper = mount(EntryList, {
      props: { entries: [makeEntry()] },
      global: { stubs: STUBS }
    })

    expect(wrapper.find('.skeleton').exists()).toBe(false)
  })
})

describe('EntryList 视图切换', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('不传 view 时保持瀑布流（默认视图不改变现有行为）', () => {
    const wrapper = mountList([makeEntry({ coverUrl: 'blob:cover' })])

    expect(wrapper.find('.blog-post').exists()).toBe(true)
    expect(virtualizeOf(wrapper).gap).toBe(16)
  })

  it('瀑布流：手机（390px）也铺两列，与博客视图的单列区分开', async () => {
    // 列数在 onMounted 里按 window.innerWidth 解析，读之前要等一次渲染
    async function lanesAt(width: number, view?: ListView) {
      const original = window.innerWidth
      window.innerWidth = width
      try {
        const wrapper = mountList([makeEntry()], undefined, view)
        await nextTick()
        return virtualizeOf(wrapper).lanes
      } finally {
        window.innerWidth = original
      }
    }

    expect(await lanesAt(390)).toBe(2) // 手机：瀑布流两列
    expect(await lanesAt(390, 'blog')).toBe(1) // 同一屏宽下博客仍是单列
    expect(await lanesAt(800)).toBe(3) // 平板
    expect(await lanesAt(800, 'blog')).toBe(2)
  })

  it('博客视图：多列时卡片等高（封面带 + 固定卡片高 + 行数截断），间距比瀑布流大', async () => {
    // 列数在 onMounted 里解析，等高样式与估算都依赖它
    const wrapper = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'blog')
    await nextTick()

    const post = wrapper.findComponent(STUBS.UBlogPost)
    const ui = post.props('ui') as { title: string, description: string, header: string }
    expect(ui.title).toContain('line-clamp-2')
    expect(ui.description).toContain('line-clamp-2')
    // 高度写在插槽子元素上（封面条 / 占位带），header 自己不写死高度：
    // 单列时占位带一 hidden，header 就自然塌成 0 高
    expect(ui.header).not.toContain('h-36')
    // happy-dom 默认 1024px → 博客两列 → 强制等高
    expect(post.classes()).toContain('h-[22rem]')

    const virtualize = virtualizeOf(wrapper)
    expect(virtualize.gap).toBe(24)
    // 多列：估算值 = 写死的真实高度（泳道按估算分配，估不准就会参差）
    expect(virtualize.estimateSize(0)).toBe(352)
  })

  it('博客视图：单列（含 640~767 这段）不强制等高，没有封面的条目不留占位带', async () => {
    // 单列只由「列数」决定：博客断点表 <768px 就是单列，而 640~767 也 ≥sm，
    // 之前用 sm: 控制占位带，这段就会「已是单列却还留着 144px 占位带」。
    for (const width of [390, 700]) {
      const original = window.innerWidth
      window.innerWidth = width
      try {
        const withoutCover = mountList([makeEntry()], undefined, 'blog')
        const withCover = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'blog')
        await nextTick()

        const post = withoutCover.findComponent(STUBS.UBlogPost)
        // 单列：不强制等高（卡片高度交回内容）
        expect(post.classes(), `宽度 ${width}`).not.toContain('h-[22rem]')
        expect(
          withoutCover.get('.blog-post [class*="bg-elevated/60"]').classes(),
          `宽度 ${width}`
        ).toContain('hidden')

        // 估算按有无封面分档，单列滚动总高度不虚高
        expect(virtualizeOf(withCover).estimateSize(0)).toBe(336)
        expect(virtualizeOf(withoutCover).estimateSize(0)).toBe(192)
      } finally {
        window.innerWidth = original
      }
    }
  })

  it('博客视图：有封面渲染封面图，多列时没封面补同高占位条（否则行不齐）', () => {
    const withCover = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'blog')
    expect(withCover.find('.blog-post img').attributes('src')).toBe('blob:cover')

    const withoutCover = mountList([makeEntry()], undefined, 'blog')
    expect(withoutCover.find('.blog-post img').exists()).toBe(false)
    // 占位带与封面同高，且多列时是显示的（happy-dom 默认 1024px → 两列）
    expect(withoutCover.find('.blog-post [class*="bg-elevated/60"]').exists()).toBe(true)
  })

  it('列表视图：渲染紧凑单行，单列且零间距（行靠 border 分隔）', () => {
    const wrapper = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'list')

    expect(wrapper.find('article').exists()).toBe(true)
    expect(wrapper.find('.blog-post').exists()).toBe(false)
    // 单行结构：缩略图 + 标题 + 摘要
    expect(wrapper.find('article img').attributes('src')).toBe('blob:cover')
    expect(wrapper.find('article h3').text()).toBe('文章标题')
    expect(virtualizeOf(wrapper).lanes).toBe(1)
    expect(virtualizeOf(wrapper).gap).toBe(0)
  })

  it('列表视图：聚合视图署名源名、单源页署名作者', () => {
    const entries = [makeEntry({ author: '张三' })]
    expect(mountList(entries, true, 'list').find('article').text()).toContain('某科技周刊')
    expect(mountList(entries, undefined, 'list').find('article').text()).toContain('张三')
  })

  it('图片视图：有封面渲染图片，无封面渲染占位块而不是整条消失', () => {
    const withCover = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'image')
    expect(withCover.find('button img').attributes('src')).toBe('blob:cover')

    const withoutCover = mountList([makeEntry({ title: '没有封面的条目' })], undefined, 'image')
    expect(withoutCover.find('button img').exists()).toBe(false)
    // 占位块保留标题，用户仍能看出这是哪一条
    expect(withoutCover.find('button').text()).toContain('没有封面的条目')
    expect(virtualizeOf(withoutCover).gap).toBe(8)
  })

  it('图片视图是瀑布流：图块按封面真实比例，而不是一律正方形', () => {
    const landscape = makeEntry({
      id: 'e-landscape',
      coverUrl: 'blob:landscape',
      images: [{ url: 'https://a.example/l.png', attachment: 'img-0.avif', width: 640, height: 320, cover: true }]
    })
    const portrait = makeEntry({
      id: 'e-portrait',
      coverUrl: 'blob:portrait',
      images: [{ url: 'https://a.example/p.png', attachment: 'img-0.avif', width: 320, height: 640, cover: true }]
    })
    const wrapper = mountList([landscape, portrait], undefined, 'image')

    const tiles = wrapper.findAll('button[style]')
    expect(tiles).toHaveLength(2)
    expect(tiles[0]!.attributes('style')).toContain('aspect-ratio: 2')
    expect(tiles[1]!.attributes('style')).toContain('aspect-ratio: 0.5')

    // 高度估算跟着比例走：横幅比竖幅矮得多（这就是瀑布流与方格网格的区别）
    const { estimateSize } = virtualizeOf(wrapper)
    expect(estimateSize(0)).toBeLessThan(estimateSize(1))
  })

  it('图片视图：缺封面比例的条目按 4:3 兜底，与组件渲染口径一致', () => {
    const wrapper = mountList([makeEntry({ id: 'e-plain' })], undefined, 'image')

    expect(wrapper.get('button[style]').attributes('style')).toContain(String(4 / 3))
    // 兜底高度 = 泳道宽度 / (4/3)，泳道宽度量不到时用 160 兜底 → 120
    expect(virtualizeOf(wrapper).estimateSize(0)).toBe(120)
  })
})

describe('EntryList 已读态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('瀑布流卡片：未读带圆点，已读淡显且没有圆点', () => {
    const unread = mountList([makeEntry({ read: false })])
    expect(unread.find('.blog-post [data-unread]').exists()).toBe(true)
    expect(unread.get('[data-entry-id]').classes()).not.toContain('opacity-60')

    const read = mountList([makeEntry({ read: true })])
    expect(read.find('.blog-post [data-unread]').exists()).toBe(false)
    expect(read.get('[data-entry-id]').classes()).toContain('opacity-60')
  })

  it('列表行：未读带圆点，已读整行淡显', () => {
    const unread = mountList([makeEntry({ read: false })], undefined, 'list')
    expect(unread.find('article [data-unread]').exists()).toBe(true)
    expect(unread.get('article').attributes('data-entry-id')).toBe('entry-1')

    const read = mountList([makeEntry({ read: true })], undefined, 'list')
    expect(read.find('article [data-unread]').exists()).toBe(false)
    expect(read.get('article').classes()).toContain('opacity-60')
  })

  it('图片图块：未读左上角有圆点，已读淡显', () => {
    const unread = mountList([makeEntry({ read: false, coverUrl: 'blob:cover' })], undefined, 'image')
    expect(unread.find('button[style] [data-unread]').exists()).toBe(true)

    const read = mountList([makeEntry({ read: true, coverUrl: 'blob:cover' })], undefined, 'image')
    expect(read.find('button[style] [data-unread]').exists()).toBe(false)
    expect(read.get('button[style]').classes()).toContain('opacity-60')
  })
})

describe('EntryList 选中态高亮', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('详情打开时，列表里对应的那条高亮（宽屏阅读栏正在读的那篇）', () => {
    const entry = makeEntry({ id: 'entry-1' })
    const other = makeEntry({ id: 'entry-2' })
    modalState.isOpen.value = true
    modalState.currentEntry.value = entry

    const wrapper = mountList([entry, other], undefined, 'list')
    expect(wrapper.get('[data-entry-id="entry-1"]').classes()).toContain('bg-primary/10')
    expect(wrapper.get('[data-entry-id="entry-2"]').classes()).not.toContain('bg-primary/10')
  })

  it('详情关闭（窄屏弹窗关掉 / 宽屏点关闭）后没有高亮', () => {
    const entry = makeEntry({ id: 'entry-1' })
    modalState.isOpen.value = false
    modalState.currentEntry.value = entry

    const wrapper = mountList([entry], undefined, 'list')
    expect(wrapper.get('[data-entry-id="entry-1"]').classes()).not.toContain('bg-primary/10')
  })

  it('卡片视图同样按当前条目描边', () => {
    const entry = makeEntry({ id: 'entry-1', coverUrl: 'blob:cover' })
    const other = makeEntry({ id: 'entry-2' })
    modalState.isOpen.value = true
    modalState.currentEntry.value = entry

    const wrapper = mountList([entry, other])
    expect(wrapper.get('[data-entry-id="entry-1"]').classes()).toContain('ring-primary')
    expect(wrapper.get('[data-entry-id="entry-2"]').classes()).not.toContain('ring-primary')
  })
})

describe('EntryList 表格视图', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function tableOf(wrapper: ReturnType<typeof mountList>) {
    return wrapper.getComponent({ name: 'Table' })
  }

  it('一行一条：来源 / 标题 / 日期三列，摘要浅灰跟在标题后面，且不再走 ScrollArea', () => {
    const wrapper = mountList([makeEntry({ description: '这是摘要' })], true, 'table')

    expect(wrapper.find('.scroll-area').exists()).toBe(false)
    expect(wrapper.findAll('th').map(th => th.text())).toEqual(['来源', '标题', '日期'])

    const row = wrapper.get('.table-row')
    expect(row.get('.col-source').text()).toContain('某科技周刊')

    // 标题加粗在前、浅灰摘要在后（同一行流式截断，长了先挤掉摘要）
    const titleCell = row.get('.col-title')
    expect(titleCell.get('.font-medium').text()).toBe('文章标题')
    expect(titleCell.get('.text-muted').text()).toContain('这是摘要')
    expect(titleCell.html().indexOf('文章标题')).toBeLessThan(titleCell.html().indexOf('这是摘要'))

    expect(row.get('.col-date').text()).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/)
  })

  it('署名列：聚合视图显示源名，单源页显示条目作者', () => {
    const entries = [makeEntry({ author: '张三' })]

    const aggregate = mountList(entries, true, 'table')
    expect(aggregate.findAll('th')[0]!.text()).toBe('来源')
    expect(aggregate.get('.col-source').text()).toContain('某科技周刊')

    const single = mountList(entries, undefined, 'table')
    expect(single.findAll('th')[0]!.text()).toBe('作者')
    expect(single.get('.col-source').text()).toContain('张三')
  })

  it('虚拟化按固定行高估高、表头 sticky、table-fixed + w-full 让标题列的 truncate 生效', () => {
    const table = tableOf(mountList([makeEntry()], undefined, 'table'))

    expect(table.props('sticky')).toBe('header')
    // w-full 是硬要求：只给 min-w-full 时表格按内容最小宽度撑开，日期列会被挤出可视区
    const base = (table.props('ui') as { base: string }).base
    expect(base).toContain('table-fixed')
    expect(base).toContain('w-full')

    const virtualize = table.props('virtualize') as { estimateSize: number, overscan: number }
    // 行高必须和 td 主题默认的 p-4 + 一行 text-sm + 1px 分隔线对齐，否则滚动总高对不上
    expect(virtualize.estimateSize).toBe(53)
    expect(virtualize.overscan).toBe(8)
  })

  it('已读态：未读行带圆点，已读整行淡显（走 UTable 的行级 meta）', () => {
    const unread = mountList([makeEntry({ read: false })], undefined, 'table')
    expect(unread.find('.col-title [data-unread]').exists()).toBe(true)
    expect(unread.get('.table-row').classes()).not.toContain('opacity-60')

    const read = mountList([makeEntry({ read: true })], undefined, 'table')
    expect(read.find('.col-title [data-unread]').exists()).toBe(false)
    expect(read.get('.table-row').classes()).toContain('opacity-60')
  })

  it('页尾骨架仍是触底信号；没有更多时换成收尾提示', () => {
    const withMore = mount(EntryList, {
      props: { entries: [makeEntry()], view: 'table', loadMore: vi.fn(), hasMore: () => true },
      global: { stubs: STUBS }
    })
    expect(withMore.find('tbody .skeleton').exists()).toBe(true)

    const noMore = mount(EntryList, {
      props: { entries: [makeEntry()], view: 'table', loadMore: vi.fn(), hasMore: () => false },
      global: { stubs: STUBS }
    })
    expect(noMore.find('.skeleton').exists()).toBe(false)
    expect(noMore.text()).toContain('已加载全部条目')
  })

  it('点击整行或按 Enter（行聚焦）打开详情', async () => {
    const entry = makeEntry()
    const wrapper = mountList([entry], undefined, 'table')

    await wrapper.get('.table-row').trigger('click')
    expect(openEntryMock).toHaveBeenCalledTimes(1)
    expect(openEntryMock.mock.calls[0]![0].id).toBe(entry.id)

    // UTable 只给行 role="button" + tabindex，Enter 由 EntryList 在根上代理
    await wrapper.get('.table-row').trigger('keydown', { key: 'Enter' })
    expect(openEntryMock).toHaveBeenCalledTimes(2)
    expect(openEntryMock.mock.calls[1]![0].id).toBe(entry.id)
  })

  it('单源页的页头当作表体第一行，跟条目一起滚（列头仍在它上面）', () => {
    const wrapper = mount(EntryList, {
      props: { entries: [makeEntry()], view: 'table', header: true },
      slots: { header: '<p class="feed-header">订阅源描述</p>' },
      global: { stubs: STUBS }
    })

    const rows = wrapper.findAll('tbody tr')
    expect(rows[0]!.find('.feed-header').exists()).toBe(true)
    expect(rows[0]!.find('th').exists()).toBe(false)
    expect(wrapper.findAll('thead th')).toHaveLength(3)
  })
})
