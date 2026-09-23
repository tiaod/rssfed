import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import EntryList from '../../components/EntryList.vue'
import type { RssEntry } from '../../types/rss'

/**
 * 时间线和分类页（跨多个源的聚合视图）显示「订阅源名 + 源图标」，
 * 单源页保持显示条目作者（源已经在页面标题里）。
 *
 * 图标必须走自定义渲染：UBlogPost 的 authors 数组会渲染 UUser，头像默认 32px
 * 且带 hover 放大动画。这里断言的是「showFeed 分支渲染 UAvatar（3xs）+ 源名」，
 * 「单源分支仍渲染 UUser 的作者名」。
 */

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useEntryModal = () => ({ openEntry: vi.fn() })

const STUBS = {
  UPageColumns: { template: '<div class="page-columns"><slot /></div>' },
  UBlogPost: {
    name: 'UBlogPost',
    props: ['title', 'description', 'date', 'image', 'authors', 'ui'],
    template: '<div class="blog-post"><slot name="authors" /></div>'
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
  }
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

function mountList(entries: RssEntry[], showFeed?: boolean) {
  return mount(EntryList, {
    props: { entries, ...(showFeed === undefined ? {} : { showFeed }) },
    global: { stubs: STUBS }
  })
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
