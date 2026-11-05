import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { RssEntry } from '../../types/rss'
import type { ShareMethod } from '../../composables/useSettings'
import { useEntryShare } from '../../composables/useEntryShare'

/**
 * 分享文章：优先系统分享面板（Web Share API），不可用时复制原文链接。
 *
 * 这里盯的是「有没有按能力选对路径、取消不算失败、失败仍有保底动作」，
 * 版式（按钮放哪）不在单测范围。
 */

const H = vi.hoisted(() => ({
  copy: vi.fn(async () => true),
  toast: vi.fn()
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useToast = () => ({ add: H.toast })
testGlobals.useClipboard = () => ({ copy: H.copy })
// 分享方式偏好：默认 auto，用例按需切换
const shareSettings = ref<{ shareMethod: ShareMethod }>({ shareMethod: 'auto' })
testGlobals.useSettings = () => ({ settings: shareSettings })

function makeEntry(over: Partial<RssEntry> = {}): RssEntry {
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
    readingTime: 0,
    ...over
  }
}

/** 给本用例装上（或卸下）Web Share API：happy-dom 默认没有 navigator.share */
function stubShare(impl?: () => Promise<void>) {
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    writable: true,
    value: impl
  })
}

/** 模拟设备的主要输入方式：auto 模式下据此决定「手机用面板、电脑复制」 */
function stubCoarsePointer(coarse: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  H.copy.mockResolvedValue(true)
  shareSettings.value = { shareMethod: 'auto' }
  stubShare(undefined)
  // 默认按桌面处理，触屏用例自己声明
  stubCoarsePointer(false)
})

describe('useEntryShare', () => {
  it('触屏设备（auto）：把标题与原文链接交给系统分享面板，不再走复制', async () => {
    stubCoarsePointer(true)
    const shareFn = vi.fn(async () => {})
    stubShare(shareFn)

    await useEntryShare(() => makeEntry()).share()

    expect(shareFn).toHaveBeenCalledWith({ title: '文章标题', url: 'https://a.example/1' })
    expect(H.copy).not.toHaveBeenCalled()
  })

  it('桌面设备（auto）：即使浏览器支持系统面板也只复制链接', async () => {
    const shareFn = vi.fn(async () => {})
    stubShare(shareFn)

    await useEntryShare(() => makeEntry()).share()

    expect(shareFn).not.toHaveBeenCalled()
    expect(H.copy).toHaveBeenCalledWith('https://a.example/1')
  })

  it('system：桌面设备也尝试系统分享面板（与 auto 的区别）', async () => {
    const shareFn = vi.fn(async () => {})
    stubShare(shareFn)
    shareSettings.value = { shareMethod: 'system' }

    await useEntryShare(() => makeEntry()).share()

    expect(shareFn).toHaveBeenCalledWith({ title: '文章标题', url: 'https://a.example/1' })
    expect(H.copy).not.toHaveBeenCalled()
  })

  it('有摘要时把摘要作为 text 一并交给系统分享面板', async () => {
    stubCoarsePointer(true)
    const shareFn = vi.fn(async () => {})
    stubShare(shareFn)

    await useEntryShare(() => makeEntry({
      description: '<p>这是一段<strong>摘要</strong>正文。</p>'
    })).share()

    expect(shareFn).toHaveBeenCalledWith({
      title: '文章标题',
      url: 'https://a.example/1',
      text: '这是一段摘要正文。'
    })
  })

  it('用户选了「复制链接」：即使有 Web Share API 也只复制，不弹系统面板', async () => {
    const shareFn = vi.fn(async () => {})
    stubShare(shareFn)
    shareSettings.value = { shareMethod: 'clipboard' }

    await useEntryShare(() => makeEntry()).share()

    expect(shareFn).not.toHaveBeenCalled()
    expect(H.copy).toHaveBeenCalledWith('https://a.example/1')
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '链接已复制' }))
  })

  it('用户取消分享（AbortError）：不当成失败，也不退回复制', async () => {
    stubCoarsePointer(true)
    const shareFn = vi.fn(async () => {
      throw Object.assign(new Error('用户取消'), { name: 'AbortError' })
    })
    stubShare(shareFn)

    const { share, shareBusy } = useEntryShare(() => makeEntry())
    await share()

    expect(H.copy).not.toHaveBeenCalled()
    expect(H.toast).not.toHaveBeenCalled()
    expect(shareBusy.value).toBe(false)
  })

  it('系统分享面板调用失败：退回复制链接，动作仍有结果', async () => {
    stubCoarsePointer(true)
    stubShare(vi.fn(async () => {
      throw new Error('权限被拒')
    }))

    await useEntryShare(() => makeEntry()).share()

    expect(H.copy).toHaveBeenCalledWith('https://a.example/1')
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'success' }))
  })

  it('触屏 auto 但浏览器没有 Web Share API（非安全上下文）：复制链接并提示成功', async () => {
    stubCoarsePointer(true)

    await useEntryShare(() => makeEntry()).share()

    expect(H.copy).toHaveBeenCalledWith('https://a.example/1')
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '链接已复制' }))
  })

  it('剪贴板不可用（copy 返回 false）：提示复制失败', async () => {
    H.copy.mockResolvedValue(false)

    await useEntryShare(() => makeEntry()).share()

    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  })

  it('没有原文链接的条目：提示无法分享，既不调分享面板也不复制', async () => {
    const shareFn = vi.fn(async () => {})
    stubShare(shareFn)

    await useEntryShare(() => makeEntry({ url: '' })).share()

    expect(shareFn).not.toHaveBeenCalled()
    expect(H.copy).not.toHaveBeenCalled()
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'neutral' }))
  })

  it('没有条目（详情面未选中任何一篇）：空操作', async () => {
    await useEntryShare(() => null).share()

    expect(H.copy).not.toHaveBeenCalled()
    expect(H.toast).not.toHaveBeenCalled()
  })
})
