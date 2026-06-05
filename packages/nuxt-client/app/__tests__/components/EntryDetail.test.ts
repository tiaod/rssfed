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
    lastFetchedAt: '2026-06-01T10:00:00Z',
  },
  starred: false,
  read: false,
  readingTime: 5,
  enclosures: [
    { url: 'https://example.com/file.pdf', mimeType: 'application/pdf', size: 1024 },
  ],
}

describe('EntryDetail', () => {
  it('渲染文章标题', () => {
    const wrapper = mount(EntryDetail, {
      props: { entry: mockEntry },
      global: {
        stubs: {
          UButton: true,
          UIcon: true,
        },
      },
    })

    expect(wrapper.find('h1').text()).toBe('测试文章标题')
  })

  it('显示作者和订阅源信息', () => {
    const wrapper = mount(EntryDetail, {
      props: { entry: mockEntry },
      global: {
        stubs: {
          UButton: true,
          UIcon: true,
        },
      },
    })

    expect(wrapper.text()).toContain('测试作者')
    expect(wrapper.text()).toContain('测试订阅源')
  })

  it('渲染文章内容 (v-html)', () => {
    const wrapper = mount(EntryDetail, {
      props: { entry: mockEntry },
      global: {
        stubs: {
          UButton: true,
          UIcon: true,
        },
      },
    })

    const contentDiv = wrapper.find('.entry-content')
    expect(contentDiv.html()).toContain('文章正文内容')
  })

  it('没有附件时不显示附件区', () => {
    const entryWithoutEnclosures = { ...mockEntry, enclosures: undefined }
    const wrapper = mount(EntryDetail, {
      props: { entry: entryWithoutEnclosures },
      global: {
        stubs: {
          UButton: true,
          UIcon: true,
        },
      },
    })

    expect(wrapper.find('footer').exists()).toBe(false)
  })
})
