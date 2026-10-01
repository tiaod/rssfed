import { describe, it, expect } from 'vitest'
import type { RssEntry } from '../../types/rss'
import {
  entryCoverAspect,
  entryCoverImage,
  entryExcerpt,
  entryFeedName,
  IMAGE_TILE_FALLBACK_ASPECT
} from '../../utils/entryDisplay'

type FeedPick = Pick<RssEntry, 'feed'>

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
