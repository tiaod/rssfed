import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  blurhashPlaceholder,
  blurhashToDataUrl,
  decodeBlurhash,
  placeholderSize,
  TRANSPARENT_PIXEL
} from '../../utils/blurhash'

/**
 * 与官方 `blurhash@2.0.5` 对齐的互通用例：字符串与采样点像素值都由**参考实现**算出
 * （服务端编码用例用的是同一批字符串，见 hono-server 的 `__tests__/blurhash.test.ts`）。
 * 两端各自与参考实现对齐，就等价于两端彼此互通。
 */
const INTEROP_CASES = [
  {
    name: '纯色（青绿）32×24',
    blurhash: 'L43yGppefQpepyflfQflfQfQfQfQ',
    width: 32,
    height: 24,
    samples: [
      { x: 0, y: 0, rgba: [37, 140, 176, 255] },
      { x: 31, y: 23, rgba: [26, 115, 144, 255] },
      { x: 16, y: 12, rgba: [32, 128, 160, 255] }
    ]
  },
  {
    name: '水平黑白渐变 32×16',
    blurhash: 'LEHoI600~qM{-;IUofayfQfQfQfQ',
    width: 32,
    height: 16,
    samples: [
      { x: 0, y: 0, rgba: [153, 153, 153, 255] },
      { x: 31, y: 15, rgba: [177, 177, 177, 255] },
      { x: 16, y: 8, rgba: [131, 131, 131, 255] }
    ]
  },
  {
    name: '纯红 16×16',
    blurhash: 'LKTI:j|cfQ|c|co1fQo1fQfQfQfQ',
    width: 16,
    height: 16,
    samples: [
      { x: 0, y: 0, rgba: [255, 0, 0, 255] },
      { x: 15, y: 15, rgba: [212, 0, 0, 255] },
      { x: 8, y: 8, rgba: [255, 0, 0, 255] }
    ]
  }
] as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe('decodeBlurhash', () => {
  for (const testCase of INTEROP_CASES) {
    it(`${testCase.name}：采样点与参考实现一致`, () => {
      const pixels = decodeBlurhash(testCase.blurhash, testCase.width, testCase.height)
      expect(pixels).not.toBeNull()
      for (const sample of testCase.samples) {
        const offset = (sample.y * testCase.width + sample.x) * 4
        expect(
          [
            pixels![offset],
            pixels![offset + 1],
            pixels![offset + 2],
            pixels![offset + 3]
          ],
          `(${sample.x},${sample.y})`
        ).toEqual([...sample.rgba])
      }
    })
  }

  it('可按任意目标尺寸解码：像素数正确、alpha 一律不透明', () => {
    const pixels = decodeBlurhash('L43yGppefQpepyflfQflfQfQfQfQ', 8, 6)
    expect(pixels).toHaveLength(8 * 6 * 4)
    for (let i = 3; i < pixels!.length; i += 4) expect(pixels![i]).toBe(255)
    // 纯色图的直流分量主导：中心像素应落在原色附近
    const center = (3 * 8 + 4) * 4
    expect(Math.abs(pixels![center]! - 32)).toBeLessThanOrEqual(8)
    expect(Math.abs(pixels![center + 1]! - 128)).toBeLessThanOrEqual(8)
  })

  it('字符串非法/分量数与长度不符时返回 null（不抛错，退化为透明占位）', () => {
    expect(decodeBlurhash('', 8, 8)).toBeNull()
    expect(decodeBlurhash('L43y', 8, 8)).toBeNull()
    expect(decodeBlurhash('L43yGppefQpepyflfQflfQfQfQfQ', 0, 8)).toBeNull()
    // 首字符声明 4×3 分量（28 位），但字符串只有 6 位
    expect(decodeBlurhash('L43yGp', 8, 8)).toBeNull()
    // 非 base83 字符（`!` 不在字母表里；`~` 在，不能拿来当非法样本）
    expect(decodeBlurhash('L43yGppefQpepyflfQflfQfQfQ!!', 8, 8)).toBeNull()
  })
})

describe('placeholderSize', () => {
  it('按原图宽高比缩放，长边限制在 16-96 之间（版面由 width/height 属性占住，这里只管模糊底色）', () => {
    expect(placeholderSize(1080, 608)).toEqual({ width: 96, height: 54 })
    expect(placeholderSize(4000, 2000)).toEqual({ width: 96, height: 48 })
    expect(placeholderSize(10, 10)).toEqual({ width: 16, height: 16 })
    // 竖长图限长边：不能按宽度缩放成 96×720（解码耗时与像素数成正比）
    expect(placeholderSize(1200, 9000)).toEqual({ width: 13, height: 96 })
  })

  it('缺尺寸时退回正方形默认边长', () => {
    expect(placeholderSize()).toEqual({ width: 96, height: 96 })
    expect(placeholderSize(800, undefined)).toEqual({ width: 96, height: 96 })
  })
})

describe('blurhashPlaceholder', () => {
  it('没有 blurhash 时用 1×1 透明像素', () => {
    expect(blurhashPlaceholder(undefined, 100, 50)).toBe(TRANSPARENT_PIXEL)
  })

  it('环境没有 canvas 时同样退化为透明像素（SSR / 无 canvas 的测试环境）', () => {
    expect(blurhashToDataUrl('L43yGppefQpepyflfQflfQfQfQfQ', 8, 8)).toBeNull()
    expect(blurhashPlaceholder('L43yGppefQpepyflfQflfQfQfQfQ', 100, 50)).toBe(TRANSPARENT_PIXEL)
  })

  it('有 canvas 时产出 blurhash 解出的 data URL，并按 hash + 尺寸缓存（同一张不重复解码）', () => {
    // happy-dom 没有 ImageData（真实浏览器有）：补一个只承载数据的桩
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    })
    const putImageData = vi.fn()
    const toDataURL = vi.fn(() => 'data:image/jpeg;base64,BLURHASH')
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return createElement(tag)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ putImageData }),
        toDataURL
      } as unknown as HTMLCanvasElement
    })

    expect(blurhashToDataUrl('L43yGppefQpepyflfQflfQfQfQfQ', 8, 8)).toBe('data:image/jpeg;base64,BLURHASH')
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', expect.any(Number)) // 渐变图必须用 JPEG（PNG 会大两个数量级）
    expect(putImageData).toHaveBeenCalledTimes(1)
    // 同一 hash + 同一尺寸：走缓存
    expect(blurhashToDataUrl('L43yGppefQpepyflfQflfQfQfQfQ', 8, 8)).toBe('data:image/jpeg;base64,BLURHASH')
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', expect.any(Number)) // 渐变图必须用 JPEG（PNG 会大两个数量级）
    expect(putImageData).toHaveBeenCalledTimes(1)
    expect(toDataURL).toHaveBeenCalledTimes(1)
    // 不同尺寸：重新解码
    expect(blurhashPlaceholder('L43yGppefQpepyflfQflfQfQfQfQ', 100, 50)).toBe('data:image/jpeg;base64,BLURHASH')
    expect(putImageData).toHaveBeenCalledTimes(2)
  })

  it('canvas 抛错时不影响调用方（返回透明像素）', () => {
    // 换一个没被上面缓存过的 hash：缓存是模块级的，同一个 key 会直接命中缓存而不建 canvas
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('canvas disabled')
    })
    expect(blurhashPlaceholder('LKTI:j|cfQ|c|co1fQo1fQfQfQfQ', 100, 50)).toBe(TRANSPARENT_PIXEL)
  })
})
