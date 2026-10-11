// @vitest-environment jsdom
// 需要真实 DOMParser 无关，但需要 document.createElement('img') 与属性语义；jsdom 齐全
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { RssCachedImage } from '../../types/rss'
import { TRANSPARENT_PIXEL } from '../../utils/blurhash'
import {
  applyImagePlaceholder,
  buildPlaceholderMap,
  isPlaceholder,
  ORIGINAL_SRC_ATTR,
  restoreOriginalSrc
} from '../../utils/entryImagePlaceholders'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 与 entry.images 里的元数据形状一致 */
function cachedImage(over: Partial<RssCachedImage> = {}): RssCachedImage {
  return { url: 'https://cdn.example/a.jpg', attachment: 'img-0.avif', width: 1080, height: 608, ...over }
}

/** 造一张与净化输出同形的 <img> */
function makeImg(attrs: Record<string, string>): HTMLImageElement {
  const img = document.createElement('img')
  for (const [key, value] of Object.entries(attrs)) img.setAttribute(key, value)
  return img
}

describe('buildPlaceholderMap', () => {
  it('把 images 里的附件映射成占位表（键是图片绝对地址）', () => {
    const map = buildPlaceholderMap([
      cachedImage(),
      cachedImage({ url: 'https://cdn.example/b.webp', attachment: 'img-1.avif', width: 320, height: 240 })
    ])
    expect([...map.keys()]).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.webp'])
    expect(map.get('https://cdn.example/a.jpg')).toMatchObject({
      attachment: 'img-0.avif',
      width: 1080,
      height: 608
    })
  })

  it('没有 images 时是空表', () => {
    expect(buildPlaceholderMap(undefined).size).toBe(0)
    expect(buildPlaceholderMap([]).size).toBe(0)
  })

  it('跳过缺 url / attachment 的脏元数据', () => {
    const map = buildPlaceholderMap([
      cachedImage({ url: '' }),
      cachedImage({ attachment: '' }),
      cachedImage()
    ])
    expect(map.size).toBe(1)
  })

  it('没有 blurhash 时占位是 1×1 透明像素（老条目）', () => {
    const map = buildPlaceholderMap([cachedImage()])
    expect(map.get('https://cdn.example/a.jpg')!.src).toBe(TRANSPARENT_PIXEL)
  })

  it('有 blurhash 时占位由它解出（canvas 可用时）', () => {
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    })
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return createElement(tag)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ putImageData: vi.fn() }),
        toDataURL: () => 'data:image/jpeg;base64,BLURHASH'
      } as unknown as HTMLCanvasElement
    })

    const map = buildPlaceholderMap([cachedImage({ blurhash: 'L43yGppefQpepyflfQflfQfQfQfQ' })])
    expect(map.get('https://cdn.example/a.jpg')!.src).toBe('data:image/jpeg;base64,BLURHASH')
  })
})

describe('applyImagePlaceholder', () => {
  it('命中缓存：src 换成占位，原始地址进 data-orig-src，并按原图尺寸占住版面', () => {
    const img = makeImg({ src: 'https://cdn.example/a.jpg', alt: '图' })
    const changed = applyImagePlaceholder(img, 'https://blog.example/post/1', buildPlaceholderMap([cachedImage()]))

    expect(changed).toBe(true)
    expect(img.getAttribute('src')).toBe(TRANSPARENT_PIXEL)
    expect(img.getAttribute(ORIGINAL_SRC_ATTR)).toBe('https://cdn.example/a.jpg')
    expect(img.getAttribute('width')).toBe('1080')
    expect(img.getAttribute('height')).toBe('608')
    // 其余属性与懒加载属性不受影响
    expect(img.getAttribute('alt')).toBe('图')
  })

  it('相对地址按 entry.url 解析后匹配（与抓取端同一基准）', () => {
    const map = buildPlaceholderMap([cachedImage({ url: 'https://blog.example/posts/img/rel.png' })])
    const img = makeImg({ src: 'img/rel.png' })
    expect(applyImagePlaceholder(img, 'https://blog.example/posts/1', map)).toBe(true)
    expect(img.getAttribute(ORIGINAL_SRC_ATTR)).toBe('https://blog.example/posts/img/rel.png')
  })

  it('不在缓存里的图原样不动（该走网络就走网络）', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    expect(applyImagePlaceholder(img, 'https://blog.example/1', buildPlaceholderMap([cachedImage()]))).toBe(false)
    expect(img.getAttribute('src')).toBe('https://other.example/x.png')
    expect(img.hasAttribute(ORIGINAL_SRC_ATTR)).toBe(false)
  })

  it('空表 / 非法地址 / 无 src 都直接放过', () => {
    const empty = buildPlaceholderMap(undefined)
    expect(applyImagePlaceholder(makeImg({ src: 'https://cdn.example/a.jpg' }), undefined, empty)).toBe(false)
    expect(applyImagePlaceholder(makeImg({ src: 'not a url' }), undefined, buildPlaceholderMap([cachedImage()]))).toBe(false)
    expect(applyImagePlaceholder(makeImg({}), undefined, buildPlaceholderMap([cachedImage()]))).toBe(false)
  })

  it('正文自己声明了尺寸时不覆盖（小图标等尺寸是内容的一部分）', () => {
    const img = makeImg({ src: 'https://cdn.example/a.jpg', width: '100', height: '100' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap([cachedImage()]))
    expect(img.getAttribute('width')).toBe('100')
    expect(img.getAttribute('height')).toBe('100')
  })

  it('元数据缺尺寸时只换 src，不补尺寸属性', () => {
    const img = makeImg({ src: 'https://cdn.example/a.jpg' })
    const map = buildPlaceholderMap([cachedImage({ width: undefined, height: undefined })])
    applyImagePlaceholder(img, undefined, map)
    expect(img.hasAttribute('width')).toBe(false)
    expect(img.getAttribute('src')).toBe(TRANSPARENT_PIXEL)
  })

  it('data: URI 与协议相对地址不会被误判为缓存命中', () => {
    const map = buildPlaceholderMap([cachedImage()])
    expect(applyImagePlaceholder(makeImg({ src: 'data:image/png;base64,AAAA' }), 'https://blog.example/1', map)).toBe(false)
    // 协议相对地址会解析成 https://cdn.example/a.jpg，属于命中 —— 这是对的
    const protocolRelative = makeImg({ src: '//cdn.example/a.jpg' })
    expect(applyImagePlaceholder(protocolRelative, 'https://blog.example/1', map)).toBe(true)
  })

  it('isPlaceholder 以 data-orig-src 为准', () => {
    const img = makeImg({ src: 'https://cdn.example/a.jpg' })
    expect(isPlaceholder(img)).toBe(false)
    applyImagePlaceholder(img, undefined, buildPlaceholderMap([cachedImage()]))
    expect(isPlaceholder(img)).toBe(true)
  })
})

describe('restoreOriginalSrc', () => {
  it('把原始地址写回 src 并摘掉标记（附件读失败时回退原地址）', () => {
    const img = makeImg({ src: 'https://cdn.example/a.jpg' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap([cachedImage()]))

    expect(restoreOriginalSrc(img)).toBe(true)
    expect(img.getAttribute('src')).toBe('https://cdn.example/a.jpg')
    expect(img.hasAttribute(ORIGINAL_SRC_ATTR)).toBe(false)
  })

  it('没有标记时什么都不做（未占位的图本来就在走原地址）', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    expect(restoreOriginalSrc(img)).toBe(false)
    expect(img.getAttribute('src')).toBe('https://other.example/x.png')
  })
})
