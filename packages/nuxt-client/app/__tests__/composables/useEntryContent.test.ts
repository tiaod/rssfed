// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useEntryContent } from '../../composables/useEntryContent'
import { sanitizeEntryHtml } from '../../composables/useSafeHtml'
import { buildPlaceholderMap } from '../../utils/entryImagePlaceholders'
import type { RssCachedImage, RssEntry } from '../../types/rss'

/** 附件读取：占位图换成 blob 的唯一异步依赖 */
const H = vi.hoisted(() => ({ getEntryAttachment: vi.fn() }))
vi.mock('~/composables/usePouchDb', () => ({
  usePouchDb: () => ({ getEntryAttachment: H.getEntryAttachment })
}))

beforeEach(() => {
  vi.clearAllMocks()
  H.getEntryAttachment.mockImplementation(async (_id: string, name: string) => new Blob([name]))
  // jsdom 没实现 blob URL
  URL.createObjectURL = vi.fn(() => 'blob:stub')
  URL.revokeObjectURL = vi.fn()
})

/** 等待 post-flush watcher 与管线内部的 nextTick 全部落定 */
async function settle() {
  for (let i = 0; i < 4; i++) await nextTick()
}

function makeEntry(content: string, over: Partial<RssEntry> = {}): RssEntry {
  return {
    id: 'entry:feed1:abc123',
    feedId: 'feed1',
    title: '标题',
    url: 'https://example.com/article',
    content,
    publishedAt: '2026-06-01T10:00:00Z',
    insertedAt: '2026-06-01T10:00:00Z',
    feed: {
      id: 'feed1',
      title: '测试订阅源',
      siteUrl: 'https://example.com',
      feedUrl: 'https://example.com/rss',
      lastFetchedAt: '2026-06-01T10:00:00Z'
    },
    starred: false,
    read: false,
    readingTime: 1,
    ...over
  }
}

describe('useEntryContent', () => {
  it('净化后的 HTML 变化时重跑增强管线', async () => {
    const content = ref('<p>第一版</p>')
    const onReady = vi.fn()
    const entry = ref(makeEntry('<p>第一版</p>'))

    const Probe = defineComponent({
      setup() {
        const el = ref<HTMLElement | null>(null)
        // 第四个参数是净化后的正文：站点设置（iframe 白名单）到齐后它会二次变化，
        // v-html 随之整块重写 DOM，管线必须跟着重跑
        useEntryContent(() => entry.value, el, { onReady }, content)
        return () => h('div', { ref: el, innerHTML: content.value })
      }
    })

    mount(Probe)
    await settle()
    expect(onReady).toHaveBeenCalledTimes(1)

    content.value = '<p>第二版</p>'
    await settle()
    expect(onReady).toHaveBeenCalledTimes(2)
  })

  it('不传净化后的 HTML 时行为与原来一致（只在内容元素就绪时跑一次）', async () => {
    const onReady = vi.fn()
    const entry = ref(makeEntry('<p>正文</p>'))

    const Probe = defineComponent({
      setup() {
        const el = ref<HTMLElement | null>(null)
        useEntryContent(() => entry.value, el, { onReady })
        return () => h('div', { ref: el, innerHTML: entry.value.content })
      }
    })

    mount(Probe)
    await settle()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  /**
   * 占位 → 真身这一段。关键顺序：占位由 sanitize（useSafeHtml）在**注入之前**做好，
   * 管线只负责把附件读成 blob；注入时 src 已经是 data:，浏览器不会去抓源站图。
   */
  describe('本地附件图片（占位 → blob）', () => {
    const images: RssCachedImage[] = [
      { url: 'https://cdn.example/a.jpg', attachment: 'img-0.avif', width: 1080, height: 608 }
    ]

    /** 造 HTML：与 EntryDetail 一样，先把正文交给 sanitize（含占位），再进 v-html */
    function sanitizedWithPlaceholders(raw: string, entry: RssEntry) {
      return sanitizeEntryHtml(
        raw,
        { entryUrl: entry.url },
        { baseUrl: entry.url, map: buildPlaceholderMap(entry.images) }
      )
    }

    function mountWithHtml(entry: RssEntry, html: string) {
      const htmlRef = ref(html)
      const Probe = defineComponent({
        setup() {
          const el = ref<HTMLElement | null>(null)
          useEntryContent(() => entry, el, {}, htmlRef)
          return () => h('div', { ref: el, innerHTML: htmlRef.value })
        }
      })
      return mount(Probe)
    }

    it('占位图读附件后换成 blob URL，并摘掉占位标记', async () => {
      const entry = makeEntry('<img src="https://cdn.example/a.jpg">', { images })
      const wrapper = mountWithHtml(entry, sanitizedWithPlaceholders(entry.content ?? '', entry))
      await settle()

      const img = wrapper.element.querySelector('img')!
      expect(H.getEntryAttachment).toHaveBeenCalledWith(entry.id, 'img-0.avif')
      expect(img.getAttribute('src')).toBe('blob:stub')
      expect(img.hasAttribute('data-orig-src')).toBe(false)
      // 注入前就算好的版面尺寸保持不动
      expect(img.getAttribute('width')).toBe('1080')
    })

    it('附件读不出来时回填原始地址（保持"缺失就用原地址"的旧行为）', async () => {
      H.getEntryAttachment.mockRejectedValue(new Error('missing'))
      const entry = makeEntry('<img src="https://cdn.example/a.jpg">', { images })
      const wrapper = mountWithHtml(entry, sanitizedWithPlaceholders(entry.content ?? '', entry))
      await settle()

      const img = wrapper.element.querySelector('img')!
      expect(img.getAttribute('src')).toBe('https://cdn.example/a.jpg')
      expect(img.hasAttribute('data-orig-src')).toBe(false)
      expect(URL.createObjectURL).not.toHaveBeenCalled()
    })

    it('未占位的缓存图仍按 src 匹配后换成 blob（兼容旧路径）', async () => {
      const entry = makeEntry('<img src="https://cdn.example/a.jpg">', { images })
      // 不做占位（等价于净化时没有拿到 images 表）
      const wrapper = mountWithHtml(entry, sanitizeEntryHtml(entry.content))
      await settle()

      const img = wrapper.element.querySelector('img')!
      expect(img.getAttribute('src')).toBe('blob:stub')
    })

    it('不在缓存里的图一个附件都不读（继续走网络）', async () => {
      const entry = makeEntry('<img src="https://other.example/x.png">', { images })
      const wrapper = mountWithHtml(entry, sanitizedWithPlaceholders(entry.content ?? '', entry))
      await settle()

      expect(H.getEntryAttachment).not.toHaveBeenCalled()
      expect(wrapper.element.querySelector('img')!.getAttribute('src')).toBe('https://other.example/x.png')
    })
  })
})
