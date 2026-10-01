import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
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

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useEntryModal = () => ({ openEntry: vi.fn() })
// EntryList 用 IntersectionObserver 观察页尾骨架（骨架可见即触底加载）
testGlobals.useIntersectionObserver = vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }))

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
    template: '<div class="blog-post"><slot name="header" /><slot name="authors" /></div>'
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
  }
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

  it('博客视图：卡片等高（固定封面高 + 固定卡片高 + 行数截断），间距比瀑布流大', () => {
    const wrapper = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'blog')

    const post = wrapper.findComponent(STUBS.UBlogPost)
    const ui = post.props('ui') as { title: string, description: string, header: string }
    expect(ui.title).toContain('line-clamp-2')
    expect(ui.description).toContain('line-clamp-2')
    // 高度写在插槽子元素上（封面条 / 占位带），header 自己不写死高度：
    // 手机单列时占位带一 hidden，header 就自然塌成 0 高
    expect(ui.header).not.toContain('h-36')
    expect(post.classes()).toContain('sm:h-[22rem]')

    const virtualize = virtualizeOf(wrapper)
    expect(virtualize.gap).toBe(24)
    // 多列：估算值 = 写死的真实高度（泳道按估算分配，估不准就会参差）
    expect(virtualize.estimateSize(0)).toBe(352)
  })

  it('博客视图：手机单列不强制等高，没有封面的条目不再留占位带', async () => {
    const original = window.innerWidth
    try {
      window.innerWidth = 390
      const withCover = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'blog')
      const withoutCover = mountList([makeEntry()], undefined, 'blog')
      await nextTick()

      // 占位带 hidden（sm:flex）：单列没有行要对齐，不该白占 144px
      expect(withoutCover.get('.blog-post [class*="sm:flex"]').classes()).toContain('hidden')
      // 估算按有无封面分档，滚动总高度不虚高
      expect(virtualizeOf(withCover).estimateSize(0)).toBe(336)
      expect(virtualizeOf(withoutCover).estimateSize(0)).toBe(192)
    } finally {
      window.innerWidth = original
    }
  })

  it('博客视图：有封面渲染封面图，多列时没封面补同高占位条（否则行不齐）', () => {
    const withCover = mountList([makeEntry({ coverUrl: 'blob:cover' })], undefined, 'blog')
    expect(withCover.find('.blog-post img').attributes('src')).toBe('blob:cover')

    const withoutCover = mountList([makeEntry()], undefined, 'blog')
    expect(withoutCover.find('.blog-post img').exists()).toBe(false)
    // 占位条与封面同高
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
