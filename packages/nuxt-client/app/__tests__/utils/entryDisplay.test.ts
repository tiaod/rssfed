import { describe, it, expect } from 'vitest'
import type { RssCachedImage, RssEntry } from '../../types/rss'
import {
  entryByline,
  entryCoverAspect,
  entryCoverImage,
  entryDate,
  entryExcerpt,
  entryFeedImages,
  entryFeedName,
  entryRelativeTime,
  feedImageCell,
  feedImagesHeight,
  feedSingleAspect,
  FEED_COLUMN_MAX,
  FEED_IMAGE_GAP,
  FEED_MAX_IMAGES,
  FEED_SINGLE_MAX_ASPECT,
  FEED_SINGLE_MAX_HEIGHT,
  FEED_SINGLE_MIN_ASPECT,
  IMAGE_TILE_FALLBACK_ASPECT
} from '../../utils/entryDisplay'

type FeedPick = Pick<RssEntry, 'feed'>
type BylinePick = Pick<RssEntry, 'feed' | 'author'>

describe('entryExcerpt', () => {
  it('剥掉 HTML 标签并压缩空白', () => {
    expect(entryExcerpt({ description: '<p>你好   <b>世界</b></p>' })).toBe('你好 世界')
  })

  it('没有 description 时回退 content（列表查询会裁掉全文）', () => {
    expect(entryExcerpt({ content: '<div>正文</div>' })).toBe('正文')
  })

  it('优先 description 而不是 content', () => {
    expect(entryExcerpt({ description: '摘要', content: '正文' })).toBe('摘要')
  })

  it('超过长度上限时截断并加省略号', () => {
    expect(entryExcerpt({ description: 'a'.repeat(200) }, 10)).toBe(`${'a'.repeat(10)}…`)
  })

  it('两者都为空时返回空串', () => {
    expect(entryExcerpt({})).toBe('')
  })
})

describe('entryCoverImage', () => {
  it('有封面时带上懒加载与异步解码（滚动时封面进视口最费主线程）', () => {
    expect(entryCoverImage({ coverUrl: 'blob:cover', title: '标题' })).toEqual({
      src: 'blob:cover',
      alt: '标题',
      loading: 'lazy',
      decoding: 'async'
    })
  })

  it('没有封面时返回 undefined，由各视图自己决定占位方式', () => {
    expect(entryCoverImage({ title: '标题' })).toBeUndefined()
  })
})

describe('entryFeedName', () => {
  it('取订阅源名', () => {
    expect(entryFeedName({ feed: { title: '某科技周刊' } } as FeedPick)).toBe('某科技周刊')
  })

  it('源名缺失时兜底', () => {
    expect(entryFeedName({ feed: { title: '' } } as FeedPick)).toBe('未知来源')
    expect(entryFeedName({} as FeedPick)).toBe('未知来源')
  })
})

describe('entryDate（列表行与表格行共用的日期口径）', () => {
  it('按 zh-CN 数字格式输出年月日', () => {
    expect(entryDate({ publishedAt: '2026-07-01T12:00:00.000Z' })).toMatch(/^2026\/7\/1$/)
  })

  it('时间缺失 / 非法时返回空串，由调用方决定省略这一段', () => {
    expect(entryDate({ publishedAt: '' })).toBe('')
    expect(entryDate({ publishedAt: 'not-a-date' })).toBe('')
  })
})

describe('entryByline（列表行 / 表格行 / 社交动态共用的署名口径）', () => {
  const entry = { feed: { title: '某科技周刊' }, author: '张三' } as BylinePick

  it('聚合视图署所属订阅源', () => {
    expect(entryByline(entry, true)).toBe('某科技周刊')
  })

  it('单源页署条目作者', () => {
    expect(entryByline(entry)).toBe('张三')
  })

  it('单源页没有作者时回退源名', () => {
    expect(entryByline({ ...entry, author: undefined })).toBe('某科技周刊')
  })
})

describe('entryRelativeTime（社交动态作者行的相对时间）', () => {
  const now = Date.parse('2026-07-01T12:00:00.000Z')
  const at = (publishedAt: string) => entryRelativeTime({ publishedAt }, now)

  it('一分钟以内是「刚刚」，未来时间（时钟偏差）也按刚刚处理', () => {
    expect(at('2026-07-01T11:59:30.000Z')).toBe('刚刚')
    expect(at('2026-07-01T12:05:00.000Z')).toBe('刚刚')
  })

  it('分钟 / 小时 / 天三档向下取整', () => {
    expect(at('2026-07-01T11:58:00.000Z')).toBe('2 分钟前')
    expect(at('2026-07-01T09:00:00.000Z')).toBe('3 小时前')
    expect(at('2026-06-29T12:00:00.000Z')).toBe('2 天前')
  })

  it('边界：整一分钟 / 一小时 / 一天各自进下一档', () => {
    expect(at('2026-07-01T11:59:00.000Z')).toBe('1 分钟前')
    expect(at('2026-07-01T11:00:00.000Z')).toBe('1 小时前')
    expect(at('2026-06-30T12:00:00.000Z')).toBe('1 天前')
  })

  it('满一周回到绝对日期（与 entryDate 同一口径）', () => {
    expect(at('2026-06-24T12:00:00.000Z')).toMatch(/^2026\/6\/24$/)
    expect(at('2026-01-02T12:00:00.000Z')).toMatch(/^2026\/1\/2$/)
  })

  it('时间缺失 / 非法时返回空串，由调用方省略这一段', () => {
    expect(at('')).toBe('')
    expect(at('not-a-date')).toBe('')
  })
})

describe('entryCoverAspect（图片瀑布流的比例来源）', () => {
  it('取封面压缩后的宽高比', () => {
    expect(entryCoverAspect({
      coverUrl: 'blob:cover',
      images: [
        { url: 'https://a.example/small.png', attachment: 'img-0.avif', width: 640, height: 320, cover: false },
        { url: 'https://a.example/big.png', attachment: 'img-1.avif', width: 1200, height: 800, cover: true }
      ]
    })).toBeCloseTo(1.5)
  })

  it('竖图比例小于 1', () => {
    expect(entryCoverAspect({
      coverUrl: 'blob:cover',
      images: [{ url: 'https://a.example/p.png', attachment: 'img-0.avif', width: 320, height: 800, cover: true }]
    })).toBeCloseTo(0.4)
  })

  it('没有封面（blob 未解析出来）时返回 null，交给调用方兜底', () => {
    expect(entryCoverAspect({
      images: [{ url: 'https://a.example/a.png', attachment: 'img-0.avif', width: 640, height: 320, cover: true }]
    })).toBeNull()
  })

  it('缺尺寸元信息时返回 null', () => {
    expect(entryCoverAspect({
      coverUrl: 'blob:cover',
      images: [{ url: 'https://a.example/a.png', attachment: 'img-0.avif', cover: true }]
    })).toBeNull()
  })

  it('兜底比例是横图 4:3', () => {
    expect(IMAGE_TILE_FALLBACK_ASPECT).toBeCloseTo(4 / 3)
  })
})

describe('entryFeedImages / feedSingleAspect（社交动态的图片区）', () => {
  const cached = (name: string, width?: number, height?: number, cover = false) => ({
    url: `https://a.example/${name}`,
    attachment: name,
    width,
    height,
    cover
  })

  it('只算有本地附件的图（没缓存下来画不出来），且最多 6 张', () => {
    const images = [
      cached('a.avif', 100, 100),
      // 没有附件名：画不出来，跳过（类型说必有，但落盘的文档不受类型约束）
      { url: 'https://a.example/nope.png' } as RssCachedImage,
      ...Array.from({ length: 7 }, (_, i) => cached(`n${i}.avif`, 100, 100))
    ]
    expect(entryFeedImages({ images })).toHaveLength(FEED_MAX_IMAGES)
    expect(entryFeedImages({ images })[0]!.attachment).toBe('a.avif')
  })

  it('没有图时是空数组', () => {
    expect(entryFeedImages({})).toEqual([])
  })

  it('单图：原比例照用；长图 / 超宽图夹进 [0.7, 2.4]', () => {
    expect(feedSingleAspect(cached('a.avif', 1600, 900))).toBeCloseTo(1600 / 900)
    expect(feedSingleAspect(cached('p.avif', 900, 1200))).toBeCloseTo(0.75)
    expect(feedSingleAspect(cached('long.avif', 400, 4000))).toBe(FEED_SINGLE_MIN_ASPECT)
    expect(feedSingleAspect(cached('wide.avif', 4000, 400))).toBe(FEED_SINGLE_MAX_ASPECT)
  })

  it('单图缺尺寸时给 4:3 兜底', () => {
    expect(feedSingleAspect(cached('a.avif'))).toBeCloseTo(4 / 3)
    expect(feedSingleAspect(undefined)).toBeCloseTo(4 / 3)
  })

  it('3 列网格：整行三张是正方形', () => {
    for (const total of [3, 6]) {
      expect(feedImageCell(0, total)).toEqual({ span: 2, aspect: 1 })
      expect(feedImageCell(2, total)).toEqual({ span: 2, aspect: 1 })
    }
  })

  it('最后一行不足三张时横向拉满：1 张跨满、2 张各跨一半', () => {
    // 4 张 = 3 + 1：第 4 张跨满 6 列（3:1）
    expect(feedImageCell(3, 4)).toEqual({ span: 6, aspect: 3 })
    // 5 张 = 3 + 2：后两张各跨 3 列（3:2）
    expect(feedImageCell(3, 5)).toEqual({ span: 3, aspect: 1.5 })
    expect(feedImageCell(4, 5)).toEqual({ span: 3, aspect: 1.5 })
    // 2 张只有一行，同样各跨一半
    expect(feedImageCell(0, 2)).toEqual({ span: 3, aspect: 1.5 })
    expect(feedImageCell(1, 2)).toEqual({ span: 3, aspect: 1.5 })
  })

  it('估算高度：无图 0；单图按比例与 448 上限；多图按行数 × (列宽 / 3)', () => {
    const column = FEED_COLUMN_MAX
    const rowHeight = (column - 2 * FEED_IMAGE_GAP) / 3

    expect(feedImagesHeight([], column)).toBe(0)
    // 16:9：576 / 1.778 = 324，没到 448
    expect(feedImagesHeight([cached('a.avif', 1600, 900)], column)).toBe(324)
    // 竖图 0.75：576 / 0.75 = 768 → 收到 448
    expect(feedImagesHeight([cached('p.avif', 900, 1200)], column)).toBe(FEED_SINGLE_MAX_HEIGHT)
    // 3 张 = 1 行，4~6 张 = 2 行（行间留一个 gap）
    expect(feedImagesHeight([1, 2, 3].map(i => cached(`i${i}.avif`, 100, 100)), column))
      .toBe(Math.round(rowHeight))
    expect(feedImagesHeight([1, 2, 3, 4].map(i => cached(`i${i}.avif`, 100, 100)), column))
      .toBe(Math.round(2 * rowHeight + FEED_IMAGE_GAP))
  })
})
