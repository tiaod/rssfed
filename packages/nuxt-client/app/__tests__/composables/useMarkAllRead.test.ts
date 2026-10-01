import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { RssEntry } from '../../types/rss'
import { useMarkAllRead } from '../../composables/useMarkAllRead'

/**
 * 「全部标记为已读」：只标当前已加载的条目、就地更新本地条目、不重查列表。
 *
 * 不重查是有意的：重查会把列表整体替换并跳回顶部，而用户只是点了「标已读」，
 * 没有理由动他的位置。
 */

const H = vi.hoisted(() => ({
  markManyRead: vi.fn(),
  toast: vi.fn()
}))

vi.mock('~/composables/usePouchDb', () => ({
  usePouchDb: () => ({ markManyRead: H.markManyRead })
}))

const globals = globalThis as unknown as Record<string, unknown>
globals.useToast = () => ({ add: H.toast })

function makeEntry(id: string, read = false): RssEntry {
  return {
    id,
    feedId: 'feed-1',
    title: `标题 ${id}`,
    url: `https://example.com/${id}`,
    publishedAt: '2026-07-01T00:00:00.000Z',
    insertedAt: '2026-07-01T00:00:00.000Z',
    feed: { id: 'feed-1', title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read,
    readingTime: 0
  }
}

beforeEach(() => {
  H.markManyRead.mockReset()
  H.toast.mockReset()
})

describe('useMarkAllRead', () => {
  it('把当前列表交给批量接口，并就地置为已读（不重查列表）', async () => {
    H.markManyRead.mockResolvedValue(2)
    const entries = ref<RssEntry[]>([makeEntry('a'), makeEntry('b')])

    await useMarkAllRead(entries)()

    expect(H.markManyRead).toHaveBeenCalledWith([
      { id: 'a', feedId: 'feed-1' },
      { id: 'b', feedId: 'feed-1' }
    ])
    expect(entries.value.every(e => e.read)).toBe(true)
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '已将 2 条标记为已读' }))
  })

  it('列表为空时直接返回，不发请求也不弹提示', async () => {
    const entries = ref<RssEntry[]>([])

    await useMarkAllRead(entries)()

    expect(H.markManyRead).not.toHaveBeenCalled()
    expect(H.toast).not.toHaveBeenCalled()
  })

  it('本来都已是已读时如实提示，数量不吹成列表长度', async () => {
    H.markManyRead.mockResolvedValue(0)
    const entries = ref<RssEntry[]>([makeEntry('a', true)])

    await useMarkAllRead(entries)()

    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '这些条目已经是已读状态' }))
  })

  it('写入失败时弹错误提示，不把本地条目改成已读', async () => {
    H.markManyRead.mockRejectedValue(new Error('磁盘满了'))
    const entries = ref<RssEntry[]>([makeEntry('a')])

    await useMarkAllRead(entries)()

    expect(entries.value[0]!.read).toBe(false)
    expect(H.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '标记失败', color: 'error' }))
  })
})
