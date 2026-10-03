import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import type { RssEntry } from '../../types/rss'
import { useEntryImages } from '../../composables/useEntryImages'

/**
 * 信息流的相册图源：列表投影只解好了封面那张 blob URL，其余几张要按条目懒取。
 *
 * 盯四件事：封面不再重复读附件、取不到的格子不出现（不是留个空框）、附件级缓存不重复读
 * IndexedDB、条目换了以后旧结果不许落到新条目上（竞态）。
 * 每个用例用不同的条目 id / 附件名 —— 缓存是模块级的，会跨用例留着（这正是它的用途）。
 */

const H = vi.hoisted(() => ({
  getEntryAttachment: vi.fn()
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.usePouchDb = () => ({ getEntryAttachment: H.getEntryAttachment })

const cached = (name: string, cover = false) => ({
  url: `https://a.example/${name}`,
  attachment: name,
  width: 100,
  height: 100,
  cover
})

let seq = 0
function makeEntry(over: Partial<RssEntry> = {}): RssEntry {
  seq += 1
  return {
    id: `entry-${seq}`,
    feedId: 'feed-1',
    title: '一条带图的动态',
    url: 'https://a.example/1',
    publishedAt: '2026-07-01T00:00:00.000Z',
    insertedAt: '2026-07-01T00:00:00.000Z',
    feed: {
      id: 'feed-1',
      title: '某源',
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

beforeEach(() => {
  vi.clearAllMocks()
  H.getEntryAttachment.mockImplementation(async (_id: string, name: string) => new Blob([name]))
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}-stub`) })
})

describe('useEntryImages', () => {
  it('封面直接用 enrichEntries 解好的 coverUrl，不再读一次附件', async () => {
    const entry = makeEntry({
      coverUrl: 'blob:cover',
      images: [cached('cover.avif', true), cached('img-1.avif'), cached('img-2.avif')]
    })

    const { media } = useEntryImages(() => entry)
    await vi.waitFor(() => expect(media.value).toHaveLength(3))

    expect(media.value[0]!.src).toBe('blob:cover')
    // 正文两张各自解出了 blob URL（stub 只按字节数生成，这里只验不是封面那个 URL）
    expect(media.value.slice(1).map(m => m.src)).toEqual([
      expect.stringContaining('blob:'),
      expect.stringContaining('blob:')
    ])
    expect(media.value.slice(1).every(m => m.src !== 'blob:cover')).toBe(true)
    // 只取了两张正文图，封面没再读
    expect(H.getEntryAttachment).toHaveBeenCalledTimes(2)
    expect(H.getEntryAttachment).toHaveBeenCalledWith(entry.id, 'img-1.avif')
  })

  it('附件没同步下来（取附件抛错）的格子不出现', async () => {
    H.getEntryAttachment.mockImplementation(async (_id: string, name: string) => {
      if (name.includes('gone')) throw new Error('404 missing')
      return new Blob([name])
    })
    const entry = makeEntry({
      coverUrl: 'blob:cover',
      images: [cached('cover.avif', true), cached('gone.avif'), cached('keep.avif')]
    })

    const { media } = useEntryImages(() => entry)
    await vi.waitFor(() => expect(media.value).toHaveLength(2))

    expect(media.value[0]!.src).toBe('blob:cover')
    expect(H.getEntryAttachment).toHaveBeenCalledWith(entry.id, 'keep.avif')
  })

  it('同一张附件第二次渲染直接用缓存，不再读 IndexedDB', async () => {
    const images = [cached('cover.avif', true), cached('shared.avif')]
    const first = makeEntry({ coverUrl: 'blob:cover-a', images })

    const a = useEntryImages(() => first)
    await vi.waitFor(() => expect(a.media.value).toHaveLength(2))
    expect(H.getEntryAttachment).toHaveBeenCalledTimes(1)

    // 同一个条目对象再挂一次（虚拟列表来回滚动就是这种重复挂载）
    const b = useEntryImages(() => first)
    await vi.waitFor(() => expect(b.media.value).toHaveLength(2))

    expect(H.getEntryAttachment).toHaveBeenCalledTimes(1)
  })

  it('超过 6 张只取前 6 张', async () => {
    const images = [cached('cover.avif', true), ...Array.from({ length: 8 }, (_, i) => cached(`many${i}.avif`))]
    const entry = makeEntry({ coverUrl: 'blob:cover', images })

    const { media } = useEntryImages(() => entry)
    await vi.waitFor(() => expect(media.value).toHaveLength(6))

    expect(H.getEntryAttachment).toHaveBeenCalledTimes(5)
  })

  it('没有图的条目不发任何请求', async () => {
    const { media } = useEntryImages(() => makeEntry())
    await nextTick()

    expect(media.value).toEqual([])
    expect(H.getEntryAttachment).not.toHaveBeenCalled()
  })

  it('条目内容被换掉后重解一次（旧条目的图不留在新条目上）', async () => {
    // 组件里拿到的是列表数组里的响应式对象，就地换内容要能触发重解
    const entry = reactive(makeEntry({
      coverUrl: 'blob:cover-1',
      images: [cached('cover.avif', true), cached('old.avif')]
    }))
    const { media } = useEntryImages(() => entry)
    await vi.waitFor(() => expect(media.value).toHaveLength(2))

    entry.coverUrl = 'blob:cover-2'
    entry.images = [cached('cover.avif', true), cached('new-1.avif'), cached('new-2.avif')]
    await vi.waitFor(() => expect(media.value).toHaveLength(3))

    expect(media.value[0]!.src).toBe('blob:cover-2')
    expect(H.getEntryAttachment).toHaveBeenCalledWith(entry.id, 'new-2.avif')
  })
})
