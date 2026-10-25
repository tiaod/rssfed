// @vitest-environment jsdom
// 需要真实 DOMParser 无关，但需要 document.createElement('img') 与属性语义；jsdom 齐全
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { RssCachedImage } from '../../types/rss'
import { TRANSPARENT_PIXEL } from '../../utils/blurhash'
import {
  applyImagePlaceholder,
  buildPlaceholderMap,
  clearImageSkeleton,
  IMAGE_SKELETON_ATTR,
  IMAGE_SKELETON_CLASSES,
  isPlaceholder,
  ORIGINAL_SRC_ATTR,
  restoreOriginalSrc,
  revealImageSkeleton
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

/**
 * 没有可用占位的图（本地没缓存 / 老条目透明占位）铺骨架：
 * 关掉图片加载或离线时，至少是块灰占位，而不是一块空白 + 破图图标。
 */
describe('骨架占位', () => {
  /** 读内联 aspect-ratio（jsdom 会把 "3 / 1" 归一化，测试里按数值比） */
  function aspectOf(img: HTMLImageElement): number {
    const raw = img.style.aspectRatio
    const [w, h] = raw.split('/').map(part => Number(part.trim()))
    return h === undefined || Number.isNaN(h) ? w! : w! / h
  }

  /** 骨架该有的样子：标记 + 主题类（静态）+ 默认隐藏、等管线放行 150ms 延迟淡入 */
  function expectSkeleton(img: HTMLImageElement) {
    expect(img.getAttribute(IMAGE_SKELETON_ATTR)).toBe(IMAGE_SKELETON_CLASSES)
    for (const token of IMAGE_SKELETON_CLASSES.split(' ')) expect(img.classList.contains(token)).toBe(true)
    // 默认不可见 + 150ms 延迟淡入：加载快的图全程不出现灰块
    expect(img.style.opacity).toBe('0')
    expect(img.style.transition).toContain('150ms')
  }

  it('本地没有缓存的图：铺骨架，src 保持源站地址（该走网络继续走网络）', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    expect(applyImagePlaceholder(img, 'https://blog.example/1', buildPlaceholderMap([cachedImage()]))).toBe(false)

    expectSkeleton(img)
    expect(img.getAttribute('src')).toBe('https://other.example/x.png')
    // 无尺寸信息：先按 16:9 撑满一行，否则加载前高度是 0、骨架看不见
    expect(img.style.aspectRatio).toBe('16 / 9')
    expect(img.style.width).toBe('100%')
    // 比例是猜的：加载中按 cover 裁掉溢出部分（保顶部），不能按默认 fill 拉变形
    expect(img.style.objectFit).toBe('cover')
    expect(img.style.objectPosition).toBe('center top')
  })

  it('正文声明过宽高的图：只铺骨架，不覆盖它自己的尺寸', () => {
    const img = makeImg({ src: 'https://other.example/x.png', width: '100', height: '60' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))

    expectSkeleton(img)
    expect(img.style.aspectRatio).toBe('')
    expect(img.style.width).toBe('')
    expect(img.getAttribute('width')).toBe('100')
  })

  it('没有标准宽高、但有公众号的 data-ratio（高/宽）：按它占位，而不是 16:9', () => {
    // 2440×560 的横幅，微信编辑器写入 data-ratio = 560/2440 ≈ 0.2295
    const img = makeImg({ 'src': 'https://other.example/banner.png', 'data-ratio': '0.2295', 'data-w': '1080' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))

    expectSkeleton(img)
    expect(aspectOf(img)).toBeCloseTo(1 / 0.2295, 5)
    expect(img.style.width).toBe('100%')
    // 比例是精确的，图不会被拉伸 → 不需要裁切
    expect(img.style.objectFit).toBe('')
    expect(img.style.objectPosition).toBe('')
  })

  it('data-width + data-height 同样能当比例来源', () => {
    const img = makeImg({ 'src': 'https://other.example/x.png', 'data-width': '900', 'data-height': '300' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))
    expect(aspectOf(img)).toBe(3)
  })

  it('data-ratio 非法 / 缺失时退回 16:9 兜底', () => {
    const cases: Array<Record<string, string>> = [
      { 'src': 'https://other.example/x.png', 'data-ratio': '0' },
      { 'src': 'https://other.example/x.png', 'data-ratio': 'abc' },
      { src: 'https://other.example/x.png' }
    ]
    for (const attrs of cases) {
      const img = makeImg(attrs)
      applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))
      expect(img.style.aspectRatio).toBe('16 / 9')
    }
  })

  it('标准 width/height 优先于 data-ratio', () => {
    const img = makeImg({
      'src': 'https://other.example/x.png',
      'width': '100',
      'height': '50',
      'data-ratio': '0.1'
    })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))
    // 宽高都在，浏览器按属性占位，不再补内联尺寸
    expect(img.style.aspectRatio).toBe('')
  })

  it('1×1 追踪像素/表情不铺骨架（不把一像素撑成一块大厅）', () => {
    const img = makeImg({ src: 'https://other.example/pixel.gif', width: '1', height: '1' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))
    expect(img.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(false)
  })

  it('data: / blob: 图不联网也不需要骨架', () => {
    const inline = makeImg({ src: 'data:image/png;base64,AAAA' })
    const blob = makeImg({ src: 'blob:https://reader.example/123' })
    applyImagePlaceholder(inline, undefined, buildPlaceholderMap(undefined))
    applyImagePlaceholder(blob, undefined, buildPlaceholderMap(undefined))
    expect(inline.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(false)
    expect(blob.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(false)
  })

  it('命中本地缓存但没有 blurhash（占位是 1×1 透明）：补骨架，等附件读出来再摘', () => {
    const img = makeImg({ src: 'https://cdn.example/a.jpg' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap([cachedImage()]))

    expect(img.getAttribute('src')).toBe(TRANSPARENT_PIXEL)
    expectSkeleton(img)
  })

  it('命中本地缓存且有 blurhash：不铺骨架（blurhash 本身就是可见的占位）', () => {
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

    const img = makeImg({ src: 'https://cdn.example/a.jpg' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap([cachedImage({ blurhash: 'L43yGppefQpepyflfQflfQfQfQfQ' })]))

    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,BLURHASH')
    expect(img.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(false)
  })

  it('源站内联 background-color 会压掉工具类：用内联 !important 顶掉，摘骨架时还原', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    // 公众号富文本导出常见写法：内联 transparent 压过 bg-elevated，灰底会看不见
    img.style.backgroundColor = 'transparent'
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))

    expect(img.style.getPropertyValue('background-color')).toBe('var(--ui-bg-elevated)')
    expect(img.style.getPropertyPriority('background-color')).toBe('important')

    clearImageSkeleton(img)
    expect(img.style.getPropertyValue('background-color')).toBe('transparent')
    expect(img.style.getPropertyPriority('background-color')).toBe('')
  })

  it('源站自己写了 object-fit 就不覆盖（只补缺的），摘骨架时也不会删它', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    img.style.objectFit = 'contain'
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))

    expect(img.style.objectFit).toBe('contain')
    expect(img.style.objectPosition).toBe('center top')

    clearImageSkeleton(img)
    expect(img.style.objectFit).toBe('contain')
    expect(img.style.objectPosition).toBe('')
  })

  it('revealImageSkeleton 只对仍带骨架的图放行淡入；没铺骨架的图不受影响', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))
    expect(img.style.opacity).toBe('0')

    revealImageSkeleton(img)
    expect(img.style.opacity).toBe('1')
    // 重复调用无副作用（transition 才是延迟来源，opacity 只从 0 变 1）
    revealImageSkeleton(img)
    expect(img.style.opacity).toBe('1')
    expect(img.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(true)

    const plain = makeImg({ src: 'https://cdn.example/a.jpg' })
    revealImageSkeleton(plain)
    expect(plain.style.opacity).toBe('')
  })

  it('clearImageSkeleton 把主题类与临时尺寸一起摘干净', () => {
    const img = makeImg({ src: 'https://other.example/x.png' })
    applyImagePlaceholder(img, undefined, buildPlaceholderMap(undefined))
    expect(img.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(true)

    clearImageSkeleton(img)

    expect(img.hasAttribute(IMAGE_SKELETON_ATTR)).toBe(false)
    for (const token of IMAGE_SKELETON_CLASSES.split(' ')) expect(img.classList.contains(token)).toBe(false)
    expect(img.style.aspectRatio).toBe('')
    expect(img.style.width).toBe('')
    expect(img.style.objectFit).toBe('')
    expect(img.style.objectPosition).toBe('')
    expect(img.style.opacity).toBe('')
    expect(img.style.transition).toBe('')
    expect(img.getAttribute('src')).toBe('https://other.example/x.png')
    // 幂等：再摘一次不抛错
    expect(() => clearImageSkeleton(img)).not.toThrow()
  })
})
