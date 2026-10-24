import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
const modalState = {
  isOpen: ref(false),
  currentEntry: ref<RssEntry | null>(null),
  /** 详情里有没有翻过篇（上一篇 / 下一篇）；没翻篇就关掉不该再定位、闪一下 */
  navigated: ref(false)
}
/** 打开详情：表格视图的行点击 / Enter 也要走到这里 */
const openEntryMock = vi.fn()

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useEntryModal = () => ({
  openEntry: openEntryMock,
  isOpen: modalState.isOpen,
  currentEntry: modalState.currentEntry,
  navigatedInDetail: modalState.navigated
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
// 信息流的相册把附件 blob 转成 URL（happy-dom 不带 createObjectURL）。
// 只补静态方法、保留 URL 构造函数：收尾提示用 `new URL(...)` 校验站点地址的协议
vi.stubGlobal('URL', class extends URL {
  static override createObjectURL = vi.fn(() => 'blob:stub')
})

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

/**
 * 关闭详情后的「滚回刚才那条」：条目还没渲染出来时，EntryList 用 ScrollArea 暴露的虚拟化实例
 * 按 index 估算目标位置（默认返回 undefined → 退化成用条目的实时矩形，那是更准的真值）。
 */
const revealOffsetForIndex = vi.fn<(index: number, align?: string) => [number, string] | undefined>(() => undefined)

const STUBS = {
  // ScrollArea（虚拟化）在单测里退化成「把 items 全渲染出来」，但仍按真实组件的样子
  // 暴露 $el 与 virtualizer（关闭详情后的定位要用后者，见 EntryList 的 revealEntry）
  UScrollArea: {
    name: 'ScrollArea',
    props: ['items', 'virtualize', 'ui'],
    data: () => ({ virtualizer: { getOffsetForIndex: revealOffsetForIndex } }),
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
  modalState.navigated.value = false
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

/**
 * 单源页滚到底时的「去原网站看更多」。
 *
 * 判据三条：本地还有没有更多（hasMore）+ 有没有合法站点地址 + 是不是真的到底了。
 * 聚合页不传 siteUrl，就只剩一句收尾文字；地址来自抓取的源元信息，协议不合法时不能当 href。
 */
describe('EntryList 收尾提示：去原网站看更多', () => {
  function mountEnd(props: Record<string, unknown> = {}) {
    return mount(EntryList, {
      props: { entries: [makeEntry()], loadMore: vi.fn(), hasMore: () => false, ...props },
      global: { stubs: STUBS }
    })
  }

  it('到底且传了站点地址：给出新标签页打开的「去原网站看更多」', () => {
    const wrapper = mountEnd({ siteUrl: 'https://a.example/' })

    expect(wrapper.text()).toContain('已加载全部条目')
    const link = wrapper.get('a.ubtn')
    expect(link.text()).toContain('去原网站看更多')
    expect(link.attributes('href')).toBe('https://a.example/')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('聚合页（不传 siteUrl）：只显示收尾文字，不给外链', () => {
    const wrapper = mountEnd()

    expect(wrapper.text()).toContain('已加载全部条目')
    expect(wrapper.find('a.ubtn').exists()).toBe(false)
  })

  it('还有更多时不出现收尾提示，也不给外链', () => {
    const wrapper = mountEnd({ siteUrl: 'https://a.example/', hasMore: () => true })

    expect(wrapper.text()).not.toContain('已加载全部条目')
    expect(wrapper.find('a.ubtn').exists()).toBe(false)
  })

  it('站点地址协议不合法（javascript:）时不渲染外链', () => {
    const wrapper = mountEnd({ siteUrl: 'javascript:alert(1)' })

    expect(wrapper.text()).toContain('已加载全部条目')
    expect(wrapper.find('a.ubtn').exists()).toBe(false)
  })

  it('表格视图的收尾行同样带外链（与虚拟化列表共用同一份提示）', () => {
    const wrapper = mount(EntryList, {
      props: {
        entries: [makeEntry()],
        view: 'table',
        loadMore: vi.fn(),
        hasMore: () => false,
        siteUrl: 'https://a.example/'
      },
      global: { stubs: STUBS }
    })

    const link = wrapper.get('tbody a.ubtn')
    expect(link.text()).toContain('去原网站看更多')
    expect(link.attributes('href')).toBe('https://a.example/')
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

describe('EntryList 关闭详情后回到刚才读的那条', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * 详情「打开某一篇 → 关掉」：EntryList 只认 isOpen 的这次变化（弹窗关闭 / 阅读栏 X / 返回键都是它）。
   *
   * `navigated` 对应真实世界里用户有没有在详情里点过「上一篇 / 下一篇」（见 useEntryModal 的
   * navigatedInDetail）：默认 true，即「翻过篇才关掉」，走定位 + 闪一下那条路径；传 false 是
   * 「点开读完直接返回」，这时列表还停在点开的那条上，不该有任何动作。
   */
  async function openThenClose(entry: RssEntry, navigated = true) {
    modalState.navigated.value = false
    modalState.currentEntry.value = entry
    modalState.isOpen.value = true
    await nextTick()
    modalState.navigated.value = navigated
    modalState.isOpen.value = false
    await nextTick()
  }

  /** 给单个元素塞一份固定几何：happy-dom 不做布局，矩形全零，可见性判定得自己给 */
  function stubRect(el: Element, top: number, height: number) {
    el.getBoundingClientRect = () => ({
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      height,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect
  }

  /** 矩形随滚动位置上移的条目：happy-dom 不做布局，条目跟列表一起走这件事得自己模拟 */
  function stubMovingRect(el: Element, scroller: HTMLElement, top: number, height: number) {
    el.getBoundingClientRect = () => {
      const moved = top - scroller.scrollTop
      return {
        top: moved,
        bottom: moved + height,
        left: 0,
        right: 0,
        width: 0,
        height,
        x: 0,
        y: moved,
        toJSON: () => ({})
      } as DOMRect
    }
  }

  /** 让 happy-dom 的元素「内容溢出」：真实滚动容器的判据就是这一个（见 EntryList 的 revealScroller） */
  function stubScrollable(el: HTMLElement, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  }

  /**
   * 接管 requestAnimationFrame：定位动画是自己逐帧推的，测试里得一帧一帧地推。
   *
   * 只伪造 performance（不碰 setTimeout，闪一下的定时器还是真的），每推一帧把时钟往前 16ms ——
   * 动画每帧走的距离按 dt 算，时钟不动就永远不动。
   */
  function controlFrames() {
    // 用 id -> 回调 的映射而不是队列：cancelAnimationFrame 必须真的作废那一帧 ——
    // 新一次定位会取消上一轮，作废不掉就会多出一个一直在跑的空循环
    const pending = new Map<number, FrameRequestCallback>()
    let next = 1
    vi.useFakeTimers({ toFake: ['performance'] })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.set(next, cb)
      return next++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pending.delete(id)
    })
    return {
      /** 推一帧（时钟 +16ms）；给了 scroller + scrollTop 就先把位置设过去 */
      step(scroller?: HTMLElement, scrollTop?: number) {
        if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop
        const nextFrame = pending.entries().next()
        if (nextFrame.done) return
        const [id, cb] = nextFrame.value
        pending.delete(id)
        vi.advanceTimersByTime(16)
        cb(0)
      },
      /** 连推 n 帧 */
      steps(count: number) {
        for (let i = 0; i < count; i++) this.step()
      }
    }
  }

  it('关掉详情后，刚刚在读的那条闪过一下，其余条目不受影响', async () => {
    const first = makeEntry({ id: 'entry-1' })
    // 真实 id 形如 entry:<feedId>:<hash>，定位不能靠拼选择器（这里顺带覆盖带 `:` 的 id）
    const second = makeEntry({ id: 'entry:feed-1:bbb' })
    const wrapper = mountList([first, second], undefined, 'list')

    await openThenClose(second)

    expect(wrapper.get('[data-entry-id="entry:feed-1:bbb"]').attributes('data-flash')).toBe('true')
    expect(wrapper.get('[data-entry-id="entry-1"]').attributes('data-flash')).toBeUndefined()
  })

  it('没翻过篇、读完直接返回：既不滚也不闪，列表停在用户自己停的位置', async () => {
    // id 故意选别的用例不用的：本文件的 wrappers 不卸载，共享的 modalState 会把「关闭」这一下
    // 广播给所有还挂着的 EntryList —— 撞上同名条目就会多起一轮定位动画，把后面的帧断言搅乱
    const entries = ['entry-no-nav-1', 'entry-no-nav-2'].map(id => makeEntry({ id }))
    const wrapper = mountList(entries, undefined, 'list')
    const scroller = wrapper.get('.scroll-area').element as HTMLElement
    stubRect(scroller, 0, 600)
    stubScrollable(scroller, 600, 2_000)
    // 故意摆成「在视口外」：没翻过篇时它也只是一个普通条目，不该有任何定位动作
    stubMovingRect(wrapper.get('[data-entry-id="entry-no-nav-2"]').element, scroller, 900, 96)

    try {
      await openThenClose(entries[1]!, false)
      await nextTick()

      expect(scroller.scrollTop).toBe(0)
      expect(revealOffsetForIndex).not.toHaveBeenCalled()
      expect(wrapper.find('[data-flash="true"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('已经看得见的那条只闪不滚：不推走用户当前的滚动位置', async () => {
    const entry = makeEntry({ id: 'entry-1' })
    const wrapper = mountList([entry], undefined, 'list')
    stubRect(wrapper.get('.scroll-area').element, 0, 600)
    stubRect(wrapper.get('[data-entry-id="entry-1"]').element, 200, 96)

    await openThenClose(entry)

    expect(revealOffsetForIndex).not.toHaveBeenCalled()
    expect(wrapper.get('[data-entry-id="entry-1"]').attributes('data-flash')).toBe('true')
  })

  it('条目在视口外时滑过去：一帧一帧地走，不是一步跳到位', async () => {
    const entries = ['entry-1', 'entry-2'].map(id => makeEntry({ id }))
    const wrapper = mountList(entries, undefined, 'list')
    const scroller = wrapper.get('.scroll-area').element as HTMLElement
    stubRect(scroller, 0, 600)
    stubScrollable(scroller, 600, 2_000)
    // 第二条此刻在视口下方 900px 处（矩形跟着滚动位置走：条目本来就随列表上移）
    stubMovingRect(wrapper.get('[data-entry-id="entry-2"]').element, scroller, 900, 96)
    const frames = controlFrames()

    await openThenClose(entries[1]!)
    expect(scroller.scrollTop).toBe(0) // 还没推帧：不动
    // 居中目标 = 900 − (600 − 96) / 2 = 648
    frames.step()
    const first = scroller.scrollTop
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(648) // 只走了一小步
    frames.steps(60)
    expect(scroller.scrollTop).toBeCloseTo(648, 1)
    await nextTick()
    expect(wrapper.get('[data-entry-id="entry-2"]').attributes('data-flash')).toBe('true')
  })

  it('滑到位了才闪：滑动途中不闪', async () => {
    const entries = ['entry-1', 'entry-2'].map(id => makeEntry({ id }))
    const wrapper = mountList(entries, undefined, 'list')
    const scroller = wrapper.get('.scroll-area').element as HTMLElement
    stubRect(scroller, 0, 600)
    stubScrollable(scroller, 600, 2_000)
    stubMovingRect(wrapper.get('[data-entry-id="entry-2"]').element, scroller, 900, 96)
    const frames = controlFrames()
    const flashed = () => wrapper.get('[data-entry-id="entry-2"]').attributes('data-flash')

    await openThenClose(entries[1]!)
    // 动画刚开始：条目还在下面飞，这时候闪一下等于没闪
    frames.steps(3)
    await nextTick()
    expect(flashed()).toBeUndefined()

    frames.steps(60) // 滑到 648，条目落进视口
    await nextTick()
    expect(flashed()).toBe('true')
  })

  it('滑动途中位置才量准：会跟着新位置继续滑，不会停在旧的终点上', async () => {
    const entries = ['entry-1', 'entry-2'].map(id => makeEntry({ id }))
    const wrapper = mountList(entries, undefined, 'list')
    const scroller = wrapper.get('.scroll-area').element as HTMLElement
    stubRect(scroller, 0, 600)
    stubScrollable(scroller, 600, 3_000)
    const item = wrapper.get('[data-entry-id="entry-2"]').element
    stubMovingRect(item, scroller, 900, 96) // 先按「在视口下方 900px」估
    const frames = controlFrames()

    await openThenClose(entries[1]!)
    frames.steps(8) // 滑到一半（此时离 648 还有一段）
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBeLessThan(648)

    // 滑动途中才量准（瀑布流 / 图片视图就是这样）：其实在更下面
    stubMovingRect(item, scroller, 2_400, 96)
    frames.steps(80) // 目标变成 2_400 − 252 = 2_148，动画继续朝它去
    expect(scroller.scrollTop).toBeCloseTo(2_148, 0)
    await nextTick()
    expect(wrapper.get('[data-entry-id="entry-2"]').attributes('data-flash')).toBe('true')
  })

  it('怎么滑都到不了（位置压根不动）时照闪，不会一直不闪', async () => {
    const entries = ['entry-1', 'entry-2'].map(id => makeEntry({ id }))
    const wrapper = mountList(entries, undefined, 'list')
    const scroller = wrapper.get('.scroll-area').element as HTMLElement
    stubRect(scroller, 0, 600)
    stubScrollable(scroller, 600, 2_000)
    // 露出大半但没完整落进视口 → 会走定位；而条目始终在视口外（模拟滚不动 / 已经贴着列表头尾）
    stubRect(wrapper.get('[data-entry-id="entry-2"]').element, 900, 96)
    const frames = controlFrames()

    await openThenClose(entries[1]!)
    frames.steps(120)
    await nextTick()

    // 闪一下总比什么都不做强：用户至少知道刚才读的是这条
    expect(wrapper.get('[data-entry-id="entry-2"]').attributes('data-flash')).toBe('true')
  })

  it('条目还没渲染出来时按虚拟化的 index 估算目标（页头也算一项）', async () => {
    const entries = ['entry-1', 'entry-2', 'entry-3'].map(id => makeEntry({ id }))
    // 这个桩不渲染任何条目（虚拟化把视口外的条目摘掉就是这个样子），只能靠实例估算
    const emptyScrollArea = { ...STUBS.UScrollArea, template: '<div class="scroll-area"></div>' }
    const wrapper = mount(EntryList, {
      props: { entries, view: 'list' as ListView, header: true },
      global: { stubs: { ...STUBS, UScrollArea: emptyScrollArea } },
      slots: { header: '<p class="feed-header">订阅源描述</p>' }
    })
    const scroller = wrapper.get('.scroll-area').element as HTMLElement
    stubRect(scroller, 0, 600)
    stubScrollable(scroller, 600, 5_000)
    revealOffsetForIndex.mockReturnValue([1_234, 'center'])
    const frames = controlFrames()

    await openThenClose(entries[2]!)

    // 列表视图恒为单列 → 页头 1 项，条目从第 2 项（index 1）开始
    expect(revealOffsetForIndex).toHaveBeenCalledWith(3, 'center')
    frames.steps(60)
    expect(scroller.scrollTop).toBeCloseTo(1_234, 0)
  })

  it('条目不在当前列表里（换源 / 被「只看未读」筛掉）时什么都不做', async () => {
    const wrapper = mountList([makeEntry({ id: 'entry-1' })], undefined, 'list')

    await openThenClose(makeEntry({ id: 'entry-999' }))

    expect(revealOffsetForIndex).not.toHaveBeenCalled()
    expect(wrapper.find('[data-flash="true"]').exists()).toBe(false)
  })

  it('闪一下是临时的：到点后标记自己摘掉，不会变成第二个「选中态」', async () => {
    vi.useFakeTimers()
    try {
      const entry = makeEntry({ id: 'entry-1' })
      const wrapper = mountList([entry], undefined, 'list')

      await openThenClose(entry)
      expect(wrapper.get('[data-entry-id="entry-1"]').attributes('data-flash')).toBe('true')

      vi.advanceTimersByTime(2000)
      await nextTick()
      expect(wrapper.get('[data-entry-id="entry-1"]').attributes('data-flash')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('表格视图：行挂不上 data-* 属性，改用 entry-flash 类闪一下', async () => {
    const first = makeEntry({ id: 'entry-1' })
    const second = makeEntry({ id: 'entry-2' })
    const wrapper = mountList([first, second], undefined, 'table')

    await openThenClose(second)

    const rows = wrapper.findAll('.table-row')
    expect(rows[1]!.classes()).toContain('entry-flash')
    expect(rows[0]!.classes()).not.toContain('entry-flash')
  })

  it('表格视图：目标行还没渲染时靠「已渲染行 + 固定行高」外推位置，并滑过去', async () => {
    const entries = ['entry-1', 'entry-2', 'entry-3'].map(id => makeEntry({ id }))
    // 这个桩只渲染第一行（虚拟化把视口外的行摘掉就是这个样子）：目标行只能靠外推
    const oneRowTable = { ...UTableStub, template: UTableStub.template.replace('v-for="item in data"', 'v-for="item in data.slice(0, 1)"') }
    const wrapper = mount(EntryList, {
      props: { entries, view: 'table' as ListView },
      global: { stubs: { ...STUBS, UTable: oneRowTable } }
    })
    // UTable 不暴露虚拟化实例，只能量：happy-dom 不做布局，容器高度要自己给
    const root = wrapper.get('.table').element as HTMLElement
    Object.defineProperty(root, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(root, 'scrollHeight', { value: 2_000, configurable: true })
    root.scrollTop = 300
    stubRect(root, 0, 600)
    // 锚点行（entry-1）的内容位置在 300：scrollTop = 300 时它正好贴视口顶部（矩形随滚动移动）
    stubMovingRect(wrapper.findAll('.table-row')[0]!.element, root, 300, 53)

    const frames = controlFrames()
    await openThenClose(entries[2]!)

    // 外推：300 + (300 − 300 − 0) + (2 − 0) × 53 − (600 − 53) / 2 = 132.5
    frames.step()
    expect(root.scrollTop).toBeLessThan(300) // 往上滑，而且是先走一小步
    expect(root.scrollTop).toBeGreaterThan(132.5)
    frames.steps(40)
    expect(root.scrollTop).toBeCloseTo(132.5, 0)
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
