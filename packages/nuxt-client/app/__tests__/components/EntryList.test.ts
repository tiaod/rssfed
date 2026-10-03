import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref, h, defineComponent, type PropType } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
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
 * 信息流操作栏的写入（EntrySocialItem 经 useEntryActions 调它们）。
 * 默认成功，要验失败分支的用例自己改返回值。
 */
const H = vi.hoisted(() => ({
  markRead: vi.fn(async () => {}),
  toggleSaved: vi.fn(async () => true),
  toast: vi.fn(),
  // 泛型写出签名：各用例会按需换成抛错的实现（附件没同步下来）
  getEntryAttachment: vi.fn<(id: string, name: string) => Promise<Blob>>(async () => new Blob(['x']))
}))
testGlobals.usePouchDb = () => ({
  markRead: H.markRead,
  toggleSaved: H.toggleSaved,
  getEntryAttachment: H.getEntryAttachment
})
testGlobals.useToast = () => ({ add: H.toast })
// 信息流的相册把附件 blob 转成 URL（happy-dom 不带 createObjectURL）
vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:stub') })

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
  /**
   * UButton：按有没有 `to` 渲染成链接或按钮，并把图标/配色/无障碍名挂成 data-*，
   * 信息流操作栏的断言就是读这几个属性（与 EntryReaderPane.test 同一套桩）。
   *
   * 用 render 函数而不是 `<component :is="'button'">`：动态组件会把 'button' 解析成
   * 名字叫 Button 的组件（大小写不敏感），也就是这个桩自己，直接无限递归。
   */
  UButton: defineComponent({
    name: 'UButton',
    props: {
      icon: String,
      color: String,
      variant: String,
      size: String,
      ariaLabel: String,
      ariaPressed: [String, Boolean] as PropType<string | boolean>,
      title: String,
      loading: Boolean,
      disabled: Boolean,
      label: String,
      to: String,
      target: String,
      rel: String
    },
    emits: ['click'],
    setup(props, { slots, emit }) {
      return () => {
        const attrs: Record<string, unknown> = {
          'class': 'ubtn',
          'data-icon': props.icon,
          'data-color': props.color,
          'data-variant': props.variant,
          'data-size': props.size,
          'title': props.title,
          'aria-label': props.ariaLabel,
          'aria-pressed': props.ariaPressed,
          'onClick': (event: Event) => emit('click', event)
        }
        if (props.to) {
          attrs.href = props.to
          attrs.target = props.target
          attrs.rel = props.rel
        } else {
          attrs.disabled = props.disabled
        }
        return h(props.to ? 'a' : 'button', attrs, slots.default?.() ?? props.label)
      }
    }
  }),
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

describe('EntryList 社交动态视图', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    H.markRead.mockResolvedValue(undefined)
    H.toggleSaved.mockResolvedValue(true)
    H.getEntryAttachment.mockImplementation(async () => new Blob(['x']))
  })

  /** 相对时间是确定值：按「距现在 N 小时」造，不受跑测试的时间影响 */
  function hoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3600_000).toISOString()
  }

  it('一条一条的信息流：作者行（头像 + 署名 + 相对时间）+ 正文热区 + 图片在文字下方', () => {
    const wrapper = mountList(
      [makeEntry({
        coverUrl: 'blob:cover',
        description: '这是摘要',
        publishedAt: hoursAgo(3),
        images: [{ url: 'https://a.example/c.png', attachment: 'img-0.avif', width: 1600, height: 900, cover: true }]
      })],
      true,
      'social'
    )

    // 不再是卡片视图（封面通栏的 UBlogPost）
    expect(wrapper.find('.blog-post').exists()).toBe(false)

    const article = wrapper.get('article')
    expect(article.attributes('data-entry-id')).toBe('entry-1')
    // 作者行：聚合视图署源名；头像是 md(32px)，信息流的头像比卡片署名的 3xs 大得多
    expect(article.get('header').text()).toContain('某科技周刊')
    expect(article.get('header').text()).toContain('3 小时前')
    expect(article.get('.avatar').attributes('data-size')).toBe('md')

    // 只有正文是打开详情的热区：标题 + 摘要 + 图片都在按钮里
    const body = article.get('button')
    expect(body.get('h3').text()).toBe('文章标题')
    expect(body.text()).toContain('这是摘要')

    // 单列、零间距（条与条靠分隔线划分）
    expect(virtualizeOf(wrapper).lanes).toBe(1)
    expect(virtualizeOf(wrapper).gap).toBe(0)
  })

  it('单图按原比例上屏（封面那张不重复取附件）', async () => {
    const entry = makeEntry({
      id: 'social-single',
      coverUrl: 'blob:cover',
      images: [{ url: 'https://a.example/c.png', attachment: 'single-0.avif', width: 1600, height: 900, cover: true }]
    })
    const wrapper = mountList([entry], undefined, 'social')
    await flushPromises()

    const img = wrapper.get('article button img')
    expect(img.attributes('src')).toBe('blob:cover')
    // 比例来自压缩后的尺寸，图片没加载时高度就是对的
    expect(img.attributes('style')).toContain('aspect-ratio: 1.777')
    // 限高限宽：长图/超宽图靠它收住，横图按列宽铺满
    expect(img.classes()).toContain('max-h-[28rem]')
    expect(img.classes()).toContain('max-w-full')
    expect(H.getEntryAttachment).not.toHaveBeenCalled()
  })

  it('多图铺成 3 列相册网格：整行三张是正方形，最后一行横向拉满', async () => {
    const image = (name: string, cover = false) => ({
      url: `https://a.example/${name}`, attachment: name, width: 400, height: 400, cover
    })
    const entry = makeEntry({
      id: 'social-grid',
      coverUrl: 'blob:cover',
      images: [image('grid-cover.avif', true), image('grid-1.avif'), image('grid-2.avif'), image('grid-3.avif')]
    })
    const wrapper = mountList([entry], undefined, 'social')
    await flushPromises()

    const grid = wrapper.get('article button .grid')
    expect(grid.classes()).toContain('grid-cols-6')
    const cells = grid.findAll('div')
    expect(cells).toHaveLength(4)

    // 前三个各跨 2 列（3 列一行）且都是正方形
    for (const cell of cells.slice(0, 3)) {
      expect(cell.attributes('style')).toContain('grid-column: span 2 / span 2')
      expect(cell.attributes('style')).toContain('aspect-ratio: 1')
    }
    // 第 4 张独占最后一行：跨满 6 列、3:1 的横幅
    expect(cells[3]!.attributes('style')).toContain('grid-column: span 6 / span 6')
    expect(cells[3]!.attributes('style')).toContain('aspect-ratio: 3')
    // 格子里的图一律裁成格子比例
    expect(cells[0]!.get('img').classes()).toContain('object-cover')
  })

  it('超过 6 张只铺前 6 张', async () => {
    const image = (i: number, cover = false) => ({
      url: `https://a.example/g${i}.png`, attachment: `many-${i}.avif`, width: 400, height: 400, cover
    })
    const entry = makeEntry({
      id: 'social-many',
      coverUrl: 'blob:cover',
      images: [image(0, true), ...Array.from({ length: 8 }, (_, i) => image(i + 1))]
    })

    const wrapper = mountList([entry], undefined, 'social')
    await flushPromises()

    expect(wrapper.get('article button .grid').findAll('div')).toHaveLength(6)
  })

  it('附件没同步下来的图片不占格子（没有空框）', async () => {
    H.getEntryAttachment.mockImplementation(async (_id: string, name: string) => {
      if (name.includes('gone')) throw new Error('404')
      return new Blob(['x'])
    })
    const image = (name: string, cover = false) => ({
      url: `https://a.example/${name}`, attachment: name, width: 400, height: 400, cover
    })
    const entry = makeEntry({
      id: 'social-partial',
      coverUrl: 'blob:cover',
      images: [image('partial-cover.avif', true), image('gone.avif'), image('partial-keep.avif')]
    })

    const wrapper = mountList([entry], undefined, 'social')
    await flushPromises()

    expect(wrapper.get('article button .grid').findAll('div')).toHaveLength(2)
  })

  it('单源页的署名换成作者（头像仍是源图标 —— 条目数据里没有作者头像）', () => {
    const wrapper = mountList([makeEntry({ author: '张三' })], undefined, 'social')

    expect(wrapper.get('header').text()).toContain('张三')
    expect(wrapper.get('.avatar').attributes('data-src')).toBe('blob:feed-icon')
  })

  it('时间缺失时不渲染相对时间那一段，不留空占位', () => {
    const wrapper = mountList([makeEntry({ publishedAt: '' })], true, 'social')

    expect(wrapper.find('header time').exists()).toBe(false)
    expect(wrapper.get('header').text()).not.toContain('刚刚')
  })

  it('已读淡显且没有圆点，未读带圆点', () => {
    const unread = mountList([makeEntry()], undefined, 'social')
    expect(unread.find('[data-entry-id] [data-unread]').exists()).toBe(true)
    expect(unread.get('[data-entry-id]').classes()).not.toContain('opacity-60')

    const read = mountList([makeEntry({ read: true })], undefined, 'social')
    expect(read.find('[data-entry-id] [data-unread]').exists()).toBe(false)
    expect(read.get('[data-entry-id]').classes()).toContain('opacity-60')
  })

  it('点击正文打开详情', async () => {
    const entry = makeEntry()
    const wrapper = mountList([entry], undefined, 'social')

    await wrapper.get('article button').trigger('click')
    expect(openEntryMock).toHaveBeenCalledTimes(1)
    expect(openEntryMock.mock.calls[0]![0].id).toBe(entry.id)
  })

  it('高度估算：文字档 + 图片区（单图按比例限高，多图按行数）', () => {
    // 文字档 170 是实测值（作者行 + 一行标题 + 两行摘要 + 操作栏）；
    // 测试里量不到容器宽度 → 列宽按 max-w-xl，图片区再减掉头像那一栏（FEED_CONTENT_INDENT）
    const column = 576 - 40
    const rowHeight = (column - 2 * 6) / 3
    const plain = mountList([makeEntry()], undefined, 'social')
    expect(virtualizeOf(plain).estimateSize(0)).toBe(170)

    const cover = (width: number, height: number, id = 'entry-1') => makeEntry({
      id,
      coverUrl: 'blob:cover',
      images: [{ url: 'https://a.example/c.png', attachment: `${id}-0.avif`, width, height, cover: true }]
    })

    // 16:9：536 / 1.778 = 301，没到 448 的上限
    const wide = mountList([cover(1600, 900, 'est-wide')], undefined, 'social')
    expect(virtualizeOf(wide).estimateSize(0)).toBe(170 + 8 + Math.round(column / (1600 / 900)))

    // 竖图 0.75：536 / 0.75 = 715 → 收到 448 上限
    const portrait = mountList([cover(900, 1200, 'est-portrait')], undefined, 'social')
    expect(virtualizeOf(portrait).estimateSize(0)).toBe(170 + 8 + 448)

    // 3 张一行、6 张两行（行高 = 列宽的 1/3，行间一个 gap）
    const grid = (count: number, id: string) => makeEntry({
      id,
      coverUrl: 'blob:cover',
      images: Array.from({ length: count }, (_, i) => ({
        url: `https://a.example/${i}.png`, attachment: `${id}-${i}.avif`, width: 400, height: 400, cover: i === 0
      }))
    })
    expect(virtualizeOf(mountList([grid(3, 'est-3')], undefined, 'social')).estimateSize(0))
      .toBe(170 + 8 + Math.round(rowHeight))
    expect(virtualizeOf(mountList([grid(6, 'est-6')], undefined, 'social')).estimateSize(0))
      .toBe(170 + 8 + Math.round(2 * rowHeight + 6))
  })

  it('分隔线挂在内容列上（与文字两端对齐），不是横贯整条泳道', () => {
    const wrapper = mountList([makeEntry()], undefined, 'social')

    const article = wrapper.get('article')
    expect(article.classes()).not.toContain('border-b') // 整条泳道不画线
    const column = article.get('div')
    expect(column.classes()).toContain('border-b')
    expect(column.classes()).toContain('max-w-xl') // 576px：以后右侧还要加一栏
    expect(column.classes()).toContain('mx-auto')
  })

  it('操作栏：标为已读 / 收藏 / 新窗口打开原文，记号沿用详情工具栏那一套', () => {
    const wrapper = mountList([makeEntry()], undefined, 'social')
    const footer = wrapper.get('footer')

    // 三个动作连排靠左（原文不单独甩到右边、也不套分组容器）
    expect(footer.classes()).not.toContain('justify-between')
    expect([...footer.element.children].map(el => el.tagName)).toEqual(['BUTTON', 'BUTTON', 'A'])

    expect(footer.get('[aria-label="标为已读"]').attributes('data-icon')).toBe('i-lucide-circle-dot')
    expect(footer.get('[aria-label="收藏"]').attributes('data-icon')).toBe('i-lucide-star')

    // 原文是真链接（新窗口），不经过详情弹窗
    const external = footer.get('[aria-label^="在新窗口打开原文"]')
    expect(external.attributes('href')).toBe('https://a.example/1')
    expect(external.attributes('target')).toBe('_blank')
    expect(external.attributes('rel')).toBe('noopener noreferrer')
  })

  it('点收藏与标为已读：写本地库并把结果就地写回这条，界面跟着变（不重查列表）', async () => {
    const entry = makeEntry()
    const wrapper = mountList([entry], undefined, 'social')

    H.toggleSaved.mockResolvedValue(true)
    await wrapper.get('footer [aria-label="收藏"]').trigger('click')
    await flushPromises()
    expect(H.toggleSaved).toHaveBeenCalledWith('entry-1', 'feed-1')
    expect(entry.starred).toBe(true)

    await wrapper.get('footer [aria-label="标为已读"]').trigger('click')
    await flushPromises()
    expect(H.markRead).toHaveBeenCalledWith('entry-1', 'feed-1', true)
    expect(entry.read).toBe(true)

    // 就地写回后：星标变「取消收藏」+ 软底，未读圆点消失、整条淡显
    const star = wrapper.get('footer [aria-label="取消收藏"]')
    expect(star.attributes('data-variant')).toBe('soft')
    expect(wrapper.find('header [data-unread]').exists()).toBe(false)
    expect(wrapper.get('[data-entry-id]').classes()).toContain('opacity-60')
  })

  it('操作栏的按钮不在打开详情的热区里（点它不会顺带开详情）', async () => {
    const wrapper = mountList([makeEntry()], undefined, 'social')

    await wrapper.get('footer [aria-label="收藏"]').trigger('click')
    await flushPromises()

    expect(openEntryMock).not.toHaveBeenCalled()
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
