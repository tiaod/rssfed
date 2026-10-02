import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import EntryReaderPane from '../../components/EntryReaderPane.vue'
import type { RssEntry } from '../../types/rss'

/**
 * 宽屏第三栏（常驻阅读栏）。
 *
 * 它和窄屏弹窗共用 useEntryDetail 的口径，所以这里只验证「版式 + 键盘」这一层：
 * 空态与正文的切换、全文未到位时的骨架、关闭与左右翻页的键位。
 */

const testGlobals = globalThis as unknown as Record<string, unknown>

function makeEntry(n: number, over: Partial<RssEntry> = {}): RssEntry {
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
    content: `<p>正文 ${n}</p>`,
    ...over
  }
}

const H = vi.hoisted(() => ({
  // 返回类型故意放宽成 unknown：桩只关心「全文取到 / 没取到」两种时序，不必拼出完整 RssEntry
  getEntry: vi.fn(async (id: string): Promise<unknown> => ({ id, title: `全文 ${id}`, content: '<p>全文</p>' })),
  markRead: vi.fn(async () => {}),
  toggleSaved: vi.fn(async () => true)
}))

const toastAdd = vi.fn()

/** 通用设置里的「条目详情宽度」：正文列的宽度上限（超出的部分两边留白） */
let modalSize = 'sm:max-w-6xl'
testGlobals.useSettings = () => ({
  settings: ref({ entryModalSize: modalSize, fixedBars: true, view: 'masonry' }),
  updateSettings: vi.fn()
})
const goPrev = vi.fn()
const goNext = vi.fn()
const closeEntry = vi.fn()

interface PaneState {
  isOpen: Ref<boolean>
  currentEntry: Ref<RssEntry | null>
  entries: Ref<RssEntry[]>
  canGoPrev: Ref<boolean>
  canGoNext: Ref<boolean>
}

let g: PaneState

testGlobals.useEntryModal = () => ({
  isOpen: g.isOpen,
  currentEntry: g.currentEntry,
  entries: g.entries,
  openEntry: vi.fn(),
  closeEntry,
  goPrev,
  goNext,
  canGoPrev: computed(() => g.canGoPrev.value),
  canGoNext: computed(() => g.canGoNext.value),
  isLastWithNoMore: () => false
})

testGlobals.usePouchDb = () => ({
  getEntry: H.getEntry,
  markRead: H.markRead,
  toggleSaved: H.toggleSaved
})

testGlobals.useToast = () => ({ add: toastAdd })

const STUBS = {
  // 阅读栏本体是 UDashboardSidebar（side="right" + resizable）：拖动 / 持久化由它负责，
  // 这里只关心两个插槽的内容渲染，桩掉即可
  UDashboardSidebar: {
    name: 'UDashboardSidebar',
    props: ['id', 'side', 'resizable', 'toggle', 'autoClose', 'minSize', 'maxSize', 'defaultSize', 'ui'],
    template: '<div class="reader-sidebar"><slot name="header" /><slot /></div>'
  },
  UButton: {
    name: 'UButton',
    props: [
      'icon', 'title', 'ariaLabel', 'ariaPressed', 'variant', 'color', 'size',
      'loading', 'disabled', 'label', 'to', 'target'
    ],
    template: '<button class="ubtn" :data-icon="icon" :data-color="color" :data-variant="variant" :title="title" :aria-label="ariaLabel" :disabled="disabled"><slot>{{ label }}</slot></button>'
  },
  UIcon: true,
  EntryDetailSkeleton: {
    name: 'EntryDetailSkeleton',
    template: '<div class="entry-detail-skeleton" />'
  },
  EntryDetail: {
    name: 'EntryDetail',
    props: ['entry'],
    template: '<div class="entry-detail">{{ entry.title }}</div>'
  }
}

function mountPane() {
  return mount(EntryReaderPane, { global: { stubs: STUBS } })
}

beforeEach(() => {
  g = {
    isOpen: ref(false),
    currentEntry: ref(null),
    entries: ref([]),
    canGoPrev: ref(false),
    canGoNext: ref(false)
  }
  H.getEntry.mockClear()
  H.getEntry.mockImplementation(async (id: string) => ({ ...makeEntry(1), id, title: `全文 ${id}` }))
  H.markRead.mockClear()
  H.markRead.mockResolvedValue(undefined)
  H.toggleSaved.mockClear()
  toastAdd.mockClear()
  modalSize = 'sm:max-w-6xl'
  goPrev.mockReset()
  goNext.mockReset()
  closeEntry.mockClear()
})

describe('EntryReaderPane 版式', () => {
  it('没选中条目时是常驻占位态，不渲染正文', () => {
    const wrapper = mountPane()

    expect(wrapper.text()).toContain('从列表中选择一篇开始阅读')
    expect(wrapper.find('.entry-detail').exists()).toBe(false)
  })

  it('选中后渲染正文（全文就位才上屏，不用只有标题的投影顶替）', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)
    g.entries.value = [makeEntry(2)]

    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.get('.entry-detail').text()).toBe('全文 entry-2')
    expect(H.getEntry).toHaveBeenCalledWith('entry-2')
    // 顶栏显示订阅源名与当前位置
    expect(wrapper.text()).toContain('源')
    expect(wrapper.text()).toContain('1 / 1')
  })

  it('正文列按通用设置的「条目详情宽度」限宽（mx-auto：多出来的宽度两边留白）', async () => {
    modalSize = 'sm:max-w-2xl'
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)

    const wrapper = mountPane()
    await flushPromises()

    const column = wrapper.get('.mx-auto')
    expect(column.classes()).toContain('sm:max-w-2xl')
    expect(column.classes()).toContain('relative')
  })

  it('设置选「全屏」时正文列不限宽（与弹窗选全屏同义：铺满）', async () => {
    modalSize = 'fullscreen'
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)

    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.get('.mx-auto').classes().some(c => c.includes('max-w'))).toBe(false)
  })

  it('全文未到位时正文区是骨架屏', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)
    H.getEntry.mockImplementation(() => new Promise(() => {}))

    const wrapper = mountPane()
    await flushPromises()

    expect(wrapper.find('.entry-detail').exists()).toBe(false)
    expect(wrapper.find('.entry-detail-skeleton').exists()).toBe(true)
  })

  it('关闭后不残留上一篇的源名与动作（closeEntry 只置 isOpen，currentEntry 还留着）', async () => {
    // 先读一篇，再关掉：顶栏必须回到空态，星标 / 阅读原文不能还作用在上一篇上
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(2)
    const wrapper = mountPane()
    await flushPromises()
    expect(wrapper.text()).toContain('源')

    g.isOpen.value = false
    await flushPromises()

    expect(wrapper.text()).toContain('从列表中选择一篇开始阅读')
    expect(wrapper.text()).not.toContain('1 / 1')
    expect(wrapper.find('[aria-label="收藏"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[aria-label="阅读原文"]').exists()).toBe(false)
  })
})

describe('EntryReaderPane 交互', () => {
  it('打开即标已读（与弹窗同一口径）', async () => {
    const entry = makeEntry(3)
    g.isOpen.value = true
    g.currentEntry.value = entry

    mountPane()
    await flushPromises()

    expect(entry.read).toBe(true)
    expect(H.markRead).toHaveBeenCalledWith('entry-3', 'feed-1', true)
  })

  it('已读 / 未读按钮沿用列表页「只看未读」开关那套图标与配色', async () => {
    g.isOpen.value = true
    const entry = makeEntry(2)
    g.currentEntry.value = entry

    const wrapper = mountPane()
    await flushPromises()

    // 打开即标已读 → 空心圈 + 中性 ghost（与列表开关的「关闭」态一致）
    const readBtn = wrapper.get('[aria-label="标为未读"]')
    expect(readBtn.attributes('data-icon')).toBe('i-lucide-circle')
    expect(readBtn.attributes('data-color')).toBe('neutral')
    expect(readBtn.attributes('data-variant')).toBe('ghost')

    // 点「标为未读」→ 圈内实心点 + 主色软底（与列表开关的「开启」态一致）
    await readBtn.trigger('click')
    await flushPromises()

    const unreadBtn = wrapper.get('[aria-label="标为已读"]')
    expect(unreadBtn.attributes('data-icon')).toBe('i-lucide-circle-dot')
    expect(unreadBtn.attributes('data-color')).toBe('primary')
    expect(unreadBtn.attributes('data-variant')).toBe('soft')
  })

  it('Esc 退出阅读（清掉选中，回到占位态）', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)

    mountPane()
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(closeEntry).toHaveBeenCalled()
  })

  it('左右方向键翻篇；越界时只提示、不翻', async () => {
    g.isOpen.value = true
    g.currentEntry.value = makeEntry(1)
    g.entries.value = [makeEntry(1), makeEntry(2)]
    g.canGoNext.value = true
    goNext.mockReturnValue(makeEntry(2))

    mountPane()
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(goNext).toHaveBeenCalled()

    // 第一篇还按 ←：canGoPrev 为假 → 不翻页，改为提示
    g.canGoPrev.value = false
    goPrev.mockReturnValue(null)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    expect(goPrev).toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '已经是第一篇了' }))
  })
})
