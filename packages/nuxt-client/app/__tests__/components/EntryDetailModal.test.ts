import { describe, it, expect, beforeEach, vi } from 'vitest'
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

testGlobals.useToast = () => ({ add: vi.fn() })
testGlobals.usePouchDb = () => ({
  getEntry: vi.fn(async () => null)
})

beforeEach(() => {
  g = {
    isOpen: ref(false),
    currentEntry: ref(null),
    entries: ref([])
  }
  modalSize = 'sm:max-w-6xl'
  fixedBars = true
})

const STUBS = {
  UModal: {
    name: 'UModal',
    template: '<div class="umodal"><slot name="body" /><slot name="footer" /></div>',
    props: ['open', 'fullscreen', 'scrollable', 'ui', 'title']
  },
  UButton: true,
  UIcon: true,
  USkeleton: true,
  EntryDetail: {
    props: ['entry'],
    template: '<div class="entry-detail">{{ entry.title }}</div>'
  },
  ClientOnly: {
    template: '<div class="client-only"><slot /></div>'
  }
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

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    await new Promise(r => setTimeout(r, 20))
    await flushPromises()

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

  it('全屏第一篇 → 左侧不铺空槽占位，也不出现「已经是第一篇了」提示页', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1), makeEntry(2), makeEntry(3)]
    modalSize = 'fullscreen'
    fixedBars = true

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    await new Promise(r => setTimeout(r, 20))
    await flushPromises()

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

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    await new Promise(r => setTimeout(r, 20))
    await flushPromises()

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

    const wrapper = mount(EntryDetailModal, { global: { stubs: STUBS } })
    await flushPromises()
    await new Promise(r => setTimeout(r, 20))
    await flushPromises()

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
    try {
      mount(EntryDetailModal, { global: { stubs: STUBS } })
      await flushPromises()
      pumpRaf() // 让 emit('swiper') 的微任务先落地，再推一帧
      await flushPromises()

      const fake = testGlobals.__swiperFake as {
        inst: { slides: unknown[], __fill: (n: number) => void }
        history: [string, { slidesLen: number }][]
      }
      expect(fake.inst).toBeTruthy()
      expect(fake.inst.slides.length).toBe(0) // 复现冷启动首帧：实例就绪但子槽未挂载

      fake.inst.__fill(2) // 子槽异步补上
      pumpRaf() // 下一帧应看到槽位就绪并执行对齐
      await flushPromises()

      const slideToMeta = fake.history
        .filter((h: [string, unknown]) => h[0] === 'slideTo')
        .map((h: [string, { slidesLen: number }]) => h[1].slidesLen)
      expect(slideToMeta.length).toBeGreaterThan(0)
      expect(Math.max(...slideToMeta)).toBeGreaterThan(0) // 对齐发生在槽位就绪之后，空几何不得定格
    } finally {
      testGlobals.requestAnimationFrame = realRaf
    }
  })
})
