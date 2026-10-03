import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, ref, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import type { ListView } from '../../utils/listViews'
import { useFeedView, useGroupView, useTimelineView } from '../../composables/useListView'

/**
 * 视图解析：三层默认（订阅源 -> 分组 -> 全局）+ 会话内覆盖。
 *
 * 两个替身必须自己装：真实的 Nuxt useState 是全局单例，
 * 而 setup.ts 里的简单替身每次调用都新建 ref，测不出「会话内跨组件记忆」。
 */
const globals = globalThis as unknown as Record<string, unknown>
const stateStore = new Map<string, Ref<unknown>>()

function mockSettings(view: ListView) {
  globals.useSettings = () => ({ settings: ref({ view }), updateSettings: vi.fn() })
}

function mockPouch(overrides: Record<string, unknown> = {}) {
  const pouch = {
    getSubscriptionViewPrefs: vi.fn(async () => ({ view: null, category: null })),
    getGroupView: vi.fn(async () => null),
    ...overrides
  }
  globals.usePouchDb = () => pouch
  return pouch
}

/** 单源 / 分组视图在 onMounted 里读偏好，必须挂在组件里跑 */
async function mountWith<T>(use: () => T): Promise<T> {
  let api!: T
  mount(defineComponent({
    setup() {
      api = use()
      return () => h('div')
    }
  }))
  await flushPromises()
  return api
}

beforeEach(() => {
  stateStore.clear()
  globals.useState = vi.fn(<T>(key: string, init: () => T) => {
    if (!stateStore.has(key)) stateStore.set(key, ref(init()))
    return stateStore.get(key) as Ref<T>
  })
})

describe('时间线视图', () => {
  it('默认取全局设置', () => {
    mockSettings('blog')
    expect(useTimelineView().view.value).toBe('blog')
  })

  it('切换只影响本次会话，且跨组件共享同一份覆盖', () => {
    mockSettings('masonry')

    const first = useTimelineView()
    first.setView('image')
    expect(first.view.value).toBe('image')
    expect(first.overridden.value).toBe(true)

    // 会话内别的组件（例如从别处再进时间线）读到的是同一个覆盖，不是配置默认值
    const second = useTimelineView()
    expect(second.view.value).toBe('image')

    second.resetView()
    expect(first.view.value).toBe('masonry')
    expect(first.overridden.value).toBe(false)
  })
})

describe('单源页视图：订阅源 -> 分组 -> 全局', () => {
  it('订阅源自己配了就用它', async () => {
    mockSettings('list')
    const pouch = mockPouch({
      getSubscriptionViewPrefs: vi.fn(async () => ({ view: 'blog', category: '摄影' })),
      getGroupView: vi.fn(async () => 'image')
    })

    const api = await mountWith(() => useFeedView('feed-1'))

    expect(api.view.value).toBe('blog')
    // 分组偏好照样读出来（订阅源清除自己的视图后要立刻回退到它）
    expect(pouch.getGroupView).toHaveBeenCalledWith('摄影')
  })

  it('订阅源没配就回退分组', async () => {
    mockSettings('list')
    mockPouch({
      getSubscriptionViewPrefs: vi.fn(async () => ({ view: null, category: '摄影' })),
      getGroupView: vi.fn(async () => 'image')
    })

    const api = await mountWith(() => useFeedView('feed-1'))

    expect(api.view.value).toBe('image')
  })

  it('订阅源和分组都没配就回退全局', async () => {
    mockSettings('list')
    mockPouch({
      getSubscriptionViewPrefs: vi.fn(async () => ({ view: null, category: null }))
    })

    const api = await mountWith(() => useFeedView('feed-1'))

    expect(api.view.value).toBe('list')
  })

  it('订阅源与分组偏好都查不到（离线 / 未配置）时按未配置处理', async () => {
    mockSettings('masonry')
    mockPouch() // 两个 getter 都返回 null

    expect((await mountWith(() => useFeedView('feed-1'))).view.value).toBe('masonry')
  })

  it('会话内切换优先于配置默认，撤销后回到配置默认', async () => {
    mockSettings('list')
    mockPouch({
      getSubscriptionViewPrefs: vi.fn(async () => ({ view: 'blog', category: null }))
    })

    const api = await mountWith(() => useFeedView('feed-1'))
    expect(api.view.value).toBe('blog')

    api.setView('image')
    expect(api.view.value).toBe('image')

    api.resetView()
    expect(api.view.value).toBe('blog')
  })
})

describe('分组页视图：分组 -> 全局', () => {
  it('分组配了就用分组', async () => {
    mockSettings('masonry')
    mockPouch({ getGroupView: vi.fn(async () => 'image') })

    const api = await mountWith(() => useGroupView('摄影'))

    expect(api.view.value).toBe('image')
  })

  it('分组没配就回退全局', async () => {
    mockSettings('blog')
    mockPouch()

    expect((await mountWith(() => useGroupView('摄影'))).view.value).toBe('blog')
  })
})

/**
 * 发布给布局的「生效视图」决定详情走阅读栏还是弹窗（见 useReaderLayout 的 useReaderPaneMode）。
 *
 * 订阅源 / 分组的默认视图是异步读出来的：解析完成前 `view` 只是个暂定值（全局默认）。
 * 把它发布出去，三栏就会在切页的瞬间塌成弹窗、等偏好读完再弹回来 —— 用户看到的是
 * 「在读的文章突然变成一个弹窗」。
 */
describe('阅读栏视图的发布（切页时三栏不塌）', () => {
  const publishedView = () =>
    (stateStore.get('reader-pane-view') as Ref<ListView | null> | undefined)?.value ?? null

  it('偏好没读完时不发布暂定值：保留上一页发布的「列表」', async () => {
    mockSettings('masonry') // 暂定值 = 全局默认（瀑布流），一旦发布出去就会塌成弹窗
    let resolvePrefs!: (prefs: { view: ListView | null, category: string | null }) => void
    mockPouch({
      getSubscriptionViewPrefs: vi.fn(() => new Promise((resolve) => { resolvePrefs = resolve }))
    })
    // 上一个源（列表视图）已经发布过 list
    stateStore.set('reader-pane-view', ref<ListView | null>('list'))

    const api = await mountWith(() => useFeedView('feed-1'))
    expect(api.view.value).toBe('masonry') // 页面暂时按全局默认渲染
    expect(publishedView()).toBe('list') // 但没发布出去：三栏原地不动

    resolvePrefs({ view: 'list', category: null })
    await flushPromises()
    expect(api.view.value).toBe('list')
    expect(publishedView()).toBe('list')
  })

  it('偏好读完且确实不是「列表」→ 才发布出去（详情交回弹窗）', async () => {
    mockSettings('masonry')
    mockPouch({ getSubscriptionViewPrefs: vi.fn(async () => ({ view: null, category: null })) })
    stateStore.set('reader-pane-view', ref<ListView | null>('list'))

    await mountWith(() => useFeedView('feed-1'))

    expect(publishedView()).toBe('masonry')
  })

  it('偏好读取失败也要解除「未就绪」：否则这一页永远不发布，三栏会一直停在上一个源的状态', async () => {
    mockSettings('masonry')
    mockPouch({
      getSubscriptionViewPrefs: vi.fn(async () => { throw new Error('离线') })
    })
    stateStore.set('reader-pane-view', ref<ListView | null>('list'))

    const api = await mountWith(() => useFeedView('feed-1'))

    expect(api.view.value).toBe('masonry') // 回退全局默认
    expect(publishedView()).toBe('masonry')
  })
})
