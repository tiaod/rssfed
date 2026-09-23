import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import FeedIcon from '../../components/FeedIcon.vue'

/**
 * 侧边栏图标懒加载。
 *
 * 关注三件事：
 *   1. 图标只在需要时才请求（不在挂载时无脑请求全量）；
 *   2. 请求失败（附件/FeedDoc 还没同步下来）时保持文字占位，并在该源同步完成后重试；
 *   3. 菜单项按 index 复用，feedId 换了必须换回占位并重新加载，不能把上一个源的图标贴错。
 */

// usePouchDb 会拉起整套 PouchDB/账号依赖，这里只替换成同步状态的最小实现
const H = vi.hoisted(() => ({ statuses: null as Record<string, { version: number }> | null }))

vi.mock('~/composables/usePouchDb', async () => {
  const { reactive: r } = await import('vue')
  return {
    usePouchSyncStatus: () => (H.statuses ??= r({}))
  }
})

const STUBS = {
  UAvatar: {
    name: 'UAvatar',
    props: ['src', 'text', 'size'],
    template: '<span class="avatar" :data-src="src" :data-text="text" :data-size="size" />'
  }
}

function mountIcon(props: { feedId?: string, fallbackText?: string, loadIcon: (id: string) => Promise<string | null> }) {
  return mount(FeedIcon, { props, global: { stubs: STUBS } })
}

// 测试环境没有可靠的视口判定：删掉 IntersectionObserver，让组件走「直接加载」的退化路径
const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver

beforeEach(() => {
  Reflect.deleteProperty(globalThis, 'IntersectionObserver')
  H.statuses = reactive({})
})

afterEach(() => {
  if (savedIO) (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
  else Reflect.deleteProperty(globalThis, 'IntersectionObserver')
})

describe('FeedIcon', () => {
  it('挂载时请求图标并渲染出来', async () => {
    const loadIcon = vi.fn(async () => 'blob:icon-1')
    const wrapper = mountIcon({ feedId: 'feed-1', fallbackText: '源', loadIcon })

    await vi.waitFor(() => expect(wrapper.find('.avatar').attributes('data-src')).toBe('blob:icon-1'))
    expect(loadIcon).toHaveBeenCalledTimes(1)
    expect(loadIcon).toHaveBeenCalledWith('feed-1')
    // 图标就位后不该再请求
    expect(loadIcon).toHaveBeenCalledTimes(1)
  })

  it('图标尺寸与 UNavigationMenu 的默认头像一致（2xs）', () => {
    // 这个尺寸原本由 UNavigationMenu 内部按主题决定，改由 FeedIcon 渲染后必须自己保证；
    // 写错一次就会直接表现为「侧边栏图标变大/变小」（2xs 与原主题默认值一致）
    const wrapper = mountIcon({ feedId: 'feed-1', fallbackText: '源', loadIcon: vi.fn(async () => null) })
    expect(wrapper.find('.avatar').attributes('data-size')).toBe('2xs')
  })

  it('拿不到图标时保留首字母占位', async () => {
    const loadIcon = vi.fn(async () => null)
    const wrapper = mountIcon({ feedId: 'feed-1', fallbackText: '源', loadIcon })

    await vi.waitFor(() => expect(loadIcon).toHaveBeenCalled())
    expect(wrapper.find('.avatar').attributes('data-src')).toBeUndefined()
    expect(wrapper.find('.avatar').attributes('data-text')).toBe('源')
  })

  it('该源同步完成后重试一次（首次打开时附件常还没落到本地）', async () => {
    let attempt = 0
    const loadIcon = vi.fn(async () => (++attempt === 1 ? null : 'blob:icon-late'))
    const wrapper = mountIcon({ feedId: 'feed-1', fallbackText: '源', loadIcon })

    await vi.waitFor(() => expect(loadIcon).toHaveBeenCalledTimes(1))

    // 模拟该源复制完成：syncStatuses 版本递增
    H.statuses!['feed-1'] = { version: 1 }

    await vi.waitFor(() => expect(wrapper.find('.avatar').attributes('data-src')).toBe('blob:icon-late'))
    expect(loadIcon).toHaveBeenCalledTimes(2)
  })

  it('feedId 变化时换回占位并重新加载（菜单项按 index 复用）', async () => {
    const loadIcon = vi.fn(async (id: string) => `blob:${id}`)
    const wrapper = mountIcon({ feedId: 'feed-1', fallbackText: '源一', loadIcon })

    await vi.waitFor(() => expect(wrapper.find('.avatar').attributes('data-src')).toBe('blob:feed-1'))

    await wrapper.setProps({ feedId: 'feed-2', fallbackText: '源二' })
    await vi.waitFor(() => expect(wrapper.find('.avatar').attributes('data-src')).toBe('blob:feed-2'))
    expect(loadIcon).toHaveBeenLastCalledWith('feed-2')
  })

  it('没有 feedId 时不请求图标（分组/标签项）', async () => {
    const loadIcon = vi.fn(async () => 'blob:never')
    const wrapper = mountIcon({ feedId: '', fallbackText: 'R', loadIcon })

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(loadIcon).not.toHaveBeenCalled()
    expect(wrapper.find('.avatar').attributes('data-text')).toBe('R')
  })

  /**
   * 懒加载的核心保证：注册观察时**不**请求，进入视口后才请求。
   *
   * 注意：FeedIcon 内部共用一个模块级 Observer，本用例必须放在文件最后 ——
   * 上面几个用例改走的是「没有 IntersectionObserver 就直接加载」的退化路径，
   * 到这里才会真正创建 Observer。
   */
  it('进入视口前不请求图标，进入后才请求', async () => {
    const observed: Element[] = []
    let trigger: IntersectionObserverCallback | null = null
    class FakeIO {
      root = null
      rootMargin = ''
      thresholds: number[] = []

      constructor(cb: IntersectionObserverCallback) {
        trigger = cb
      }

      observe(el: Element) {
        observed.push(el)
      }

      unobserve() {}

      disconnect() {}

      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
      = FakeIO as unknown as typeof IntersectionObserver

    const loadIcon = vi.fn(async () => 'blob:icon')
    const wrapper = mountIcon({ feedId: 'feed-1', fallbackText: '源', loadIcon })

    // 只是挂上了观察者，还没读附件、没建 blob URL
    expect(observed).toHaveLength(1)
    expect(loadIcon).not.toHaveBeenCalled()

    trigger!(
      [{ target: observed[0], isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
    await vi.waitFor(() => expect(wrapper.find('.avatar').attributes('data-src')).toBe('blob:icon'))
    expect(loadIcon).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})
