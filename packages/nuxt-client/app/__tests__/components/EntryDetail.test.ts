// @vitest-environment jsdom
// 正文净化断言依赖 DOMPurify，而它与 happy-dom 不兼容（见 useSafeHtml.test.ts 的说明）
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EntryDetail from '../../components/EntryDetail.vue'
import type { RssEntry } from '../../types/rss'

const mockEntry: RssEntry = {
  id: 'entry:feed1:abc123',
  feedId: 'feed1',
  title: '测试文章标题',
  url: 'https://example.com/article',
  content: '<p>文章正文内容</p>',
  description: '文章摘要',
  author: '测试作者',
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
  readingTime: 5,
  enclosures: [
    { url: 'https://example.com/file.pdf', mimeType: 'application/pdf', size: 1024 }
  ]
}

/**
 * 统一的挂载选项。
 * ClientOnly 是 Nuxt 内置组件，vitest 里没有 Nuxt runtime，直接透传 slot
 * 等价于「已挂载」状态（真实 SSR 下它刻意不渲染正文，见 EntryDetail 的说明）。
 * VueEasyLightbox 是 teleport 到 body 的第三方组件，测试里 stub 掉即可。
 */
function mountEntry(entry: RssEntry) {
  return mount(EntryDetail, {
    props: { entry },
    global: {
      stubs: {
        ClientOnly: { template: '<slot />' },
        VueEasyLightbox: true,
        UButton: true,
        UIcon: true
      }
    }
  })
}

describe('EntryDetail', () => {
  it('渲染文章标题', () => {
    expect(mountEntry(mockEntry).find('h1').text()).toBe('测试文章标题')
  })

  it('有作者时只署作者名，不再重复订阅源名（源名已在详情顶栏）', () => {
    const meta = mountEntry(mockEntry).find('header > div')

    expect(meta.text()).toContain('测试作者')
    expect(meta.text()).not.toContain('测试订阅源')
    // 元信息之间只靠 flex 间距分隔，不再用「·」
    expect(meta.text()).not.toContain('·')
  })

  it('没有作者时用订阅源名代替', () => {
    const meta = mountEntry({ ...mockEntry, author: undefined }).find('header > div')

    expect(meta.text()).toContain('测试订阅源')
  })

  it('渲染文章内容', () => {
    const contentDiv = mountEntry(mockEntry).find('.entry-content')
    expect(contentDiv.html()).toContain('文章正文内容')
  })

  it('注入前剥离正文里的 XSS payload', () => {
    const wrapper = mountEntry({
      ...mockEntry,
      content: '<p>正常正文</p><script>alert(1)</script><img src="https://a/b.png" onerror="alert(2)">'
    })

    const html = wrapper.find('.entry-content').html()
    expect(html).toContain('正常正文')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
  })

  it('正文外链在新窗口打开且带 noopener', () => {
    const wrapper = mountEntry({
      ...mockEntry,
      content: '<p><a href="https://example.com/x">外链</a></p>'
    })

    const link = wrapper.find('.entry-content a')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
  })

  it('与订阅源同源的 iframe 会渲染出来（相对地址改写为绝对地址）', () => {
    const wrapper = mountEntry({
      ...mockEntry,
      content: '<iframe src="/player.html"></iframe><iframe src="https://evil.example/x"></iframe>'
    })

    const frames = wrapper.findAll('.entry-content iframe')
    expect(frames).toHaveLength(1)
    expect(frames[0]!.attributes('src')).toBe('https://example.com/player.html')
  })

  it('没有附件时不显示附件区', () => {
    const wrapper = mountEntry({ ...mockEntry, enclosures: undefined })

    expect(wrapper.find('footer').exists()).toBe(false)
  })
})
