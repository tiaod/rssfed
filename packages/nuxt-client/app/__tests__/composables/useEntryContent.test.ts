// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useEntryContent } from '../../composables/useEntryContent'
import type { RssEntry } from '../../types/rss'

/** 等待 post-flush watcher 与管线内部的 nextTick 全部落定 */
async function settle() {
  for (let i = 0; i < 4; i++) await nextTick()
}

function makeEntry(content: string): RssEntry {
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
    readingTime: 1
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
})
