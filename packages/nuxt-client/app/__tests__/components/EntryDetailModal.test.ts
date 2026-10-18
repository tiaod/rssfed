import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { ref, computed, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import EntryDetailModal from '../../components/EntryDetailModal.vue'
import type { RssEntry } from '../../types/rss'

// ── 测试用全局桩：还原 Nuxt/composables 自动导入，便于在纯 vitest 环境挂载 ──

/** Nuxt 自动导入的 composable 与 swiper 实例桩都挂在 globalThis 上，这里统一做类型化访问 */
const testGlobals = globalThis as unknown as Record<string, unknown>

function makeEntry(n: number): RssEntry {
  return {
    id: `entry-${n}`,
    feedId: 'feed-1',
    title: `标题 ${n}`,
    url: `https://example.com/${n}`,
    publishedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    insertedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    feed: { id: 'feed-1', title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read: false,
    readingTime: 0,
    content: `<p>正文 ${n}</p>`
  }
}

// mock swiper/vue：本组件通过 defineAsyncComponent 动态引用它，用两个渲染槽位的替身验证分支
vi.mock('swiper/vue', async () => {
  const { defineComponent, h } = await vi.importActual<typeof import('vue')>('vue')
  const makeFakeInstance = () => {
    // 冷启动首帧 Swiper 拿到 slides=0（子槽异步挂载未到齐），由 __fill 模拟后续子槽就位
    const slides: HTMLElement[] = []
    const history: [string, { slidesLen: number }][] = []
    const inst = {
      destroyed: false,
      activeIndex: 1,
      slides,
      update: vi.fn(() => history.push(['update', { slidesLen: slides.length }])),
      slideTo: vi.fn(() => history.push(['slideTo', { slidesLen: slides.length }])),
      __fill(n: number) { for (let i = 0; i < n; i++) slides.push(document.createElement('div')) }
    }
    testGlobals.__swiperFake = { inst, history }
    return inst
  }
  return {
    Swiper: defineComponent({
      name: 'MockSwiper',
      emits: ['swiper', 'transitionEnd'],
      setup(_, { emit, slots }) {
        // 与真实实现一致：挂载后把实例抛给父组件
        setTimeout(() => emit('swiper', makeFakeInstance()), 0)
        return () => h('div', { class: 'swiper-stub' }, slots.default?.())
      }
    }),
    SwiperSlide: defineComponent({
      name: 'MockSwiperSlide',
      setup(_, { slots }) {
        return () => h('div', { class: 'swiper-slide-stub' }, slots.default?.())
      }
    })
  }
})

interface ModalGlobals {
  isOpen: Ref<boolean>
  currentEntry: Ref<RssEntry | null>
  entries: Ref<RssEntry[]>
}

let g: ModalGlobals
let modalSize = 'sm:max-w-6xl'
let fixedBars = true

testGlobals.useEntryModal = () => ({
  isOpen: g.isOpen,
  currentEntry: g.currentEntry,
  entries: g.entries,
  openEntry: vi.fn(),
  closeEntry: vi.fn(() => { g.isOpen.value = false }),
  goPrev: vi.fn(),
  goNext: vi.fn(),
  canGoPrev: computed(() => false),
  canGoNext: computed(() => false),
  isLastWithNoMore: () => false
})

testGlobals.useSettings = () => ({
  settings: computed(() => ({ entryModalSize: modalSize, fixedBars })),
  updateSettings: vi.fn()
})

const toastAdd = vi.fn()
testGlobals.useToast = () => ({ add: toastAdd })

/** 用户状态库的写入桩：自动标已读与工具栏的两个切换都走这里 */
const H = vi.hoisted(() => ({
  getEntry: vi.fn(async () => null as unknown),
  markRead: vi.fn(async () => {}),
  toggleSaved: vi.fn(async () => true)
}))

testGlobals.usePouchDb = () => ({
  getEntry: H.getEntry,
  markRead: H.markRead,
  toggleSaved: H.toggleSaved
})

beforeEach(() => {
  g = {
    isOpen: ref(false),
    currentEntry: ref(null),
    entries: ref([])
  }
  modalSize = 'sm:max-w-6xl'
  fixedBars = true
  H.getEntry.mockReset()
  H.getEntry.mockResolvedValue(null)
  H.markRead.mockReset()
  H.markRead.mockResolvedValue(undefined)
  H.toggleSaved.mockReset()
  H.toggleSaved.mockResolvedValue(true)
  toastAdd.mockReset()
})

const STUBS = {
  UModal: {
    name: 'UModal',
    template: '<div class="umodal"><slot name="body" /><slot name="footer" /></div>',
    props: ['open', 'fullscreen', 'scrollable', 'ui', 'title']
  },
  UButton: {
    name: 'UButton',
    props: [
      'icon', 'title', 'ariaLabel', 'ariaPressed', 'variant', 'color', 'size',
      'loading', 'disabled', 'label', 'to', 'target'
    ],
    template: '<button class="ubtn" :data-icon="icon" :data-color="color" :data-variant="variant" :title="title" :aria-label="ariaLabel" :aria-pressed="ariaPressed"><slot>{{ label }}</slot></button>'
  },
  UIcon: true,
  USkeleton: true,
  EntryDetailSkeleton: {
    name: 'EntryDetailSkeleton',
    template: '<div class="entry-detail-skeleton" aria-busy="true" />'
  },
  EntryDetail: {
    props: ['entry'],
    template: '<div class="entry-detail">{{ entry.title }}</div>'
  },
  ClientOnly: {
    template: '<div class="client-only"><slot /></div>'
  }
}

// 组件里的 Swiper / SwiperSlide 是 defineAsyncComponent：首次解析要走一次真实动态 import
// （含 mock 工厂的求值），在慢 runner 上可能拖过断言窗口。这里先预热，把它装进模块缓存，
// 让各用例只需等一个微任务，而不是等模块图。
beforeAll(async () => {
  await import('swiper/vue')
})

/**
 * 全屏分支的 Swiper 走 defineAsyncComponent 懒加载：`import('swiper/vue')` 落地前
 * 只挂到一个空壳，子槽要等模块解析完才渲染。这里等到槽位真的出现再断言——
 * 原先用固定的 `setTimeout(20)` 赌时序，CI runner 一慢就赶不上，发布流水线的
 * test 门禁就曾挂在这条用例上（AssertionError: expected [] to have a length of 3）。
 *
 * 槽位由模板里单个 v-for 一次性铺出，不存在「渲染到一半」，所以只需等到非空；
 * 具体条数仍由各用例自己的 toHaveLength 断言，不放松任何检查。
 */
async function mountFullscreenModal() {
  const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
  await vi.waitFor(() => {
    expect(wrapper.findAll('.swiper-slide-stub').length).toBeGreaterThan(0)
  })
  return wrapper
}

describe('EntryDetailModal', () => {
  it('顶栏标题显示订阅源名字，而不是文章标题', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'UModal' }).props('title')).toBe('源')
  })

  it('源名缺失（FeedDoc 未同步）→ 顶栏回退到文章标题，不出现空白', async () => {
    g.isOpen.value = true
    g.currentEntry.value = { ...makeEntry(1), feed: { ...makeEntry(1).feed, title: '' } }

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    expect(wrapper.findComponent({ name: 'UModal' }).props('title')).toBe('标题 1')
  })

  it('全屏（手机/设置选全屏）→ 改用 Swiper 渲染三槽，并显示当前位置页码', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)
    g.entries.value = [makeEntry(1), makeEntry(2), makeEntry(3)]
    modalSize = 'fullscreen'
    fixedBars = true

    const wrapper = await mountFullscreenModal()

    const slides = wrapper.findAll('.swiper-slide-stub')
    expect(slides).toHaveLength(3)
    // 三个槽依次铺垫上/当前/下一篇
    expect(slides[0]!.text()).toContain('标题 1')
    expect(slides[1]!.text()).toContain('标题 2')
    expect(slides[2]!.text()).toContain('标题 3')
    // 右上角页码：当前位置 2 / 3
    expect(wrapper.text()).toContain('2 / 3')
  })

  it('非全屏（桌面居中弹窗）→ 保持原单条渲染路径，不出现 Swiper', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1)]

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    expect(wrapper.find('.swiper-stub').exists()).toBe(false)
    expect(wrapper.find('.swiper-slide-stub').exists()).toBe(false)
    expect(wrapper.find('.entry-detail').exists()).toBe(true)
  })

  it('全文未到位时正文区显示骨架屏，不把只有标题的投影当正文上屏', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)
    g.entries.value = [makeEntry(1), makeEntry(2), makeEntry(3)]
    // 模拟「投影已到、全文还在路上」：读取一直不落地
    const realPouch = testGlobals.usePouchDb
    testGlobals.usePouchDb = () => ({
      getEntry: vi.fn(() => new Promise(() => {})),
      markRead: H.markRead,
      toggleSaved: H.toggleSaved
    })

    try {
      const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
      await flushPromises()

      // 投影（标题/元信息）不上屏，避免框体先塌成一小条再弹回全文高度
      expect(wrapper.find('.entry-detail').exists()).toBe(false)
      expect(wrapper.find('.entry-detail-skeleton').exists()).toBe(true)
    } finally {
      testGlobals.usePouchDb = realPouch
    }
  })

  it('全屏第一篇 → 左侧不铺空槽占位，也不出现「已经是第一篇了」提示页', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1), makeEntry(2), makeEntry(3)]
    modalSize = 'fullscreen'
    fixedBars = true

    const wrapper = await mountFullscreenModal()

    const slides = wrapper.findAll('.swiper-slide-stub')
    expect(slides).toHaveLength(2)
    expect(slides[0]!.text()).toContain('标题 1')
    expect(slides[1]!.text()).toContain('标题 2')
    expect(wrapper.text()).not.toContain('已经是第一篇了')
  })

  it('全屏最后一篇 → 右侧不铺空槽占位，也不出现「没有下一篇了」提示页', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(3)
    g.entries.value = [makeEntry(1), makeEntry(2), makeEntry(3)]
    modalSize = 'fullscreen'
    fixedBars = true

    const wrapper = await mountFullscreenModal()

    const slides = wrapper.findAll('.swiper-slide-stub')
    expect(slides).toHaveLength(2)
    expect(slides[0]!.text()).toContain('标题 2')
    expect(slides[1]!.text()).toContain('标题 3')
    expect(wrapper.text()).not.toContain('没有下一篇了')
  })

  it('全屏单条（列表只有一篇）→ 只渲一个真实槽，无边缘提示', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1)]
    modalSize = 'fullscreen'
    fixedBars = true

    const wrapper = await mountFullscreenModal()

    const slides = wrapper.findAll('.swiper-slide-stub')
    expect(slides).toHaveLength(1)
    expect(wrapper.text()).not.toContain('已经是第一篇了')
    expect(wrapper.text()).not.toContain('没有下一篇了')
  })

  it('冷启动首帧 Swiper 拿到 slides=0 时，等子槽就位后再对齐（修复刷新后首篇划不动）', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1), makeEntry(2)]
    modalSize = 'fullscreen'
    fixedBars = true

    // 测试环境 rAF 近乎 0ms，会把「等槽位」的帧数上限瞬间烧完。这里手动接管 rAF，
    // 按真实浏览器节奏逐帧推进，才能精确复现「先拿到半成品实例、后补上子槽」的时序
    const pendingRaf: FrameRequestCallback[] = []
    const realRaf = testGlobals.requestAnimationFrame
    testGlobals.requestAnimationFrame = (cb: FrameRequestCallback) => {
      pendingRaf.push(cb)
      return pendingRaf.length
    }
    const pumpRaf = () => {
      const q = pendingRaf.splice(0)
      for (const cb of q) cb(0)
    }
    // 本用例断言的是「这一次挂载」产生的实例，而 __swiperFake 是全局单槽：
    // 先清掉上一次挂载留下的引用，免得读到别人的实例与 history
    testGlobals.__swiperFake = undefined
    try {
      mount(EntryDetailModal, { global: { stubs: STUBS } })

      // Swiper 走 defineAsyncComponent，实例要等模块解析完才由 mock 抛出来。
      // 等它真的出现再往下走 —— 原来靠固定次数的 flushPromises 赌它到了没有，会偶发落空
      await vi.waitFor(() => {
        expect(testGlobals.__swiperFake).toBeTruthy()
      })

      const fake = testGlobals.__swiperFake as {
        inst: { slides: unknown[], __fill: (n: number) => void }
        history: [string, { slidesLen: number }][]
      }
      expect(fake.inst.slides.length).toBe(0) // 复现冷启动首帧：实例就绪但子槽未挂载

      const slideToMeta = () => fake.history
        .filter((h: [string, unknown]) => h[0] === 'slideTo')
        .map((h: [string, { slidesLen: number }]) => h[1].slidesLen)

      fake.inst.__fill(2) // 子槽异步补上
      // 逐帧推进直到看见「槽位就绪后的对齐」：帧数在这里是上限，不是约定 ——
      // 并发跑测试时微任务与帧的落地时机有抖动，写死推 5 帧会偶发推不到（本用例曾随机失败）
      for (let i = 0; i < 40; i++) {
        pumpRaf()
        await flushPromises()
        if (slideToMeta().some(n => n > 0)) break
      }

      const meta = slideToMeta()
      expect(meta.length).toBeGreaterThan(0)
      expect(Math.max(...meta)).toBeGreaterThan(0) // 对齐发生在槽位就绪之后，空几何不得定格
    } finally {
      testGlobals.requestAnimationFrame = realRaf
    }
  })
})

describe('EntryDetailModal 正文区的 pointerdown', () => {
  /**
   * 这两个用例钉住正文区 pointerdown 处理器的两条约束 —— 它们是一对矛盾，缺哪条都会退化：
   *   - 不能掐断冒泡：reka-ui 的 DismissableLayer 靠这次 pointerdown 冒泡到 document
   *     清掉「刚才点在层内」的标记，掐断了下一次点遮罩就会被吞掉（要点两次才关）。
   *   - 但要抵消遮罩层那一下 preventDefault：遮罩层挂着 `pointerdown + .left.prevent`，
   *     正文嵌在遮罩层里，不抵消的话浏览器不补发 mousedown，正文就没法用鼠标拖选。
   */
  async function mountCentered() {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1)]
    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    return wrapper
  }

  it('不掐断冒泡：点正文的 pointerdown 仍会冒泡到祖先（reka-ui 靠它收尾外部点击状态）', async () => {
    const wrapper = await mountCentered()
    // 非全屏（scrollable）正文分支的根节点；祖先用 UModal 桩的根模拟遮罩层
    const body = wrapper.get('.relative.min-h-full')
    const ancestorSpy = vi.fn()
    wrapper.get('.umodal').element.addEventListener('pointerdown', ancestorSpy)

    body.element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0
    }))

    expect(ancestorSpy).toHaveBeenCalledTimes(1)
  })

  it('抵消遮罩层那一次 preventDefault（鼠标左键）：浏览器才会补发 mousedown，正文可拖选', async () => {
    const wrapper = await mountCentered()
    const body = wrapper.get('.relative.min-h-full')
    // 复刻 reka-ui DialogOverlayImpl 的处理器：pointerdown + .left.prevent
    wrapper.get('.umodal').element.addEventListener('pointerdown', (e: Event) => {
      if ((e as PointerEvent).button === 0) e.preventDefault()
    })

    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    body.element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})

describe('EntryDetailModal 的历史记录', () => {
  it('地址里没有条目（时间线 / 收藏页）→ 打开时照旧压一条自己的历史', async () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    try {
      mount(EntryDetailModal, { global: { stubs: STUBS } })
      await flushPromises()
      g.currentEntry.value = makeEntry(1)
      g.isOpen.value = true
      await flushPromises()

      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ __entryModal: true }),
        '',
        expect.any(String)
      )
    } finally {
      pushSpy.mockRestore()
    }
  })

  it('地址里已经带着这一篇（单源页详情地址）→ 不再压历史，返回键与关闭都交给路由', async () => {
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    // 判据读的是 router.currentRoute（Nuxt 的 _route 慢一拍，实测打开那一刻还是旧地址）；
    // 这里刻意让 useRoute() 停留在**旧地址**上，钉住「不能读它」
    testGlobals.useRoute = () => ({ params: {} })
    testGlobals.useRouter = () => ({ currentRoute: { value: { params: { id: 'feed-1', entryId: 'entry-1' } } } })
    try {
      mount(EntryDetailModal, { global: { stubs: STUBS } })
      await flushPromises()
      g.currentEntry.value = makeEntry(1)
      g.isOpen.value = true
      await flushPromises()

      // 打开：不压自己的历史（压了会和路由的历史打架，返回键要按两次才关得掉详情）
      expect(pushSpy).not.toHaveBeenCalled()

      // 关闭：也不替路由退历史（地址由 useEntryRoute 换回列表页）
      g.isOpen.value = false
      await flushPromises()
      expect(goSpy).not.toHaveBeenCalled()
    } finally {
      pushSpy.mockRestore()
      goSpy.mockRestore()
      testGlobals.useRouter = () => ({ currentRoute: { value: { params: {} } } })
    }
  })
})

describe('EntryDetailModal 的已读 / 收藏', () => {
  it('打开即标已读：就地更新列表里的那条并写库', async () => {
    g.isOpen.value = true
    const entry = makeEntry(1)
    g.currentEntry.value = entry

    mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    expect(entry.read).toBe(true)
    expect(H.markRead).toHaveBeenCalledWith('entry-1', 'feed-1', true)
  })

  it('已经读过的条目不再写一次', async () => {
    g.isOpen.value = true
    g.currentEntry.value = { ...makeEntry(1), read: true }

    mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    expect(H.markRead).not.toHaveBeenCalled()
  })

  it('自动标记写库失败 → 界面状态退回未读（不显示没落盘的状态）', async () => {
    H.markRead.mockRejectedValueOnce(new Error('磁盘满了'))
    g.isOpen.value = true
    const entry = makeEntry(1)
    g.currentEntry.value = entry

    mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    expect(entry.read).toBe(false)
  })

  it('工具栏「标为未读」：写库成功后当前条目置回未读', async () => {
    g.isOpen.value = true
    const entry = makeEntry(1)
    g.currentEntry.value = entry

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    // 挂载时已自动标为已读，按钮此刻的语义就是「标为未读」
    H.markRead.mockClear()

    await wrapper.get('[aria-label="标为未读"]').trigger('click')
    await flushPromises()

    expect(H.markRead).toHaveBeenCalledWith('entry-1', 'feed-1', false)
    expect(entry.read).toBe(false)
  })

  it('工具栏的已读 / 未读按钮用列表页那套圆圈图标（circle / circle-dot）', async () => {
    g.isOpen.value = true
    const entry = makeEntry(1)
    g.currentEntry.value = entry

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    // 打开即标已读 → 空心圈 + 中性 ghost
    const readBtn = wrapper.get('[aria-label="标为未读"]')
    expect(readBtn.attributes('data-icon')).toBe('i-lucide-circle')

    await readBtn.trigger('click')
    await flushPromises()

    // 未读 → 圈内实心点 + 主色软底
    const unreadBtn = wrapper.get('[aria-label="标为已读"]')
    expect(unreadBtn.attributes('data-icon')).toBe('i-lucide-circle-dot')
    expect(unreadBtn.attributes('data-color')).toBe('primary')
    expect(unreadBtn.attributes('data-variant')).toBe('soft')
  })

  it('工具栏星标：收藏与取消收藏都按本地库返回的状态就地更新', async () => {
    g.isOpen.value = true
    const entry = makeEntry(1)
    g.currentEntry.value = entry

    H.toggleSaved.mockResolvedValueOnce(true)
    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()

    await wrapper.get('[aria-label="收藏"]').trigger('click')
    await flushPromises()

    expect(H.toggleSaved).toHaveBeenCalledWith('entry-1', 'feed-1')
    expect(entry.starred).toBe(true)

    H.toggleSaved.mockResolvedValueOnce(false)
    await wrapper.get('[aria-label="取消收藏"]').trigger('click')
    await flushPromises()

    expect(entry.starred).toBe(false)
  })

  it('写库失败时收藏状态不翻转，并弹出错误提示', async () => {
    g.isOpen.value = true
    const entry = makeEntry(1)
    g.currentEntry.value = entry
    H.toggleSaved.mockRejectedValueOnce(new Error('磁盘满了'))

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    await wrapper.get('[aria-label="收藏"]').trigger('click')
    await flushPromises()

    expect(entry.starred).toBe(false)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  })
})
