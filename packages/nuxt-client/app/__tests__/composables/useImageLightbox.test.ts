// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { useImageLightbox } from '../../composables/useImageLightbox'

/**
 * 造一张可控的 <img>。
 *
 * happy-dom 不会真的加载图片：naturalWidth/complete 的默认值与我们想表达的
 * 「已加载的真实图片」「1x1 追踪像素」「还没加载完」三种状态对不上，
 * 所以这里显式覆盖这两个属性，让用例只依赖我们给定的语义。
 */
function makeImg(src: string, opts: { complete?: boolean, width?: number, height?: number, alt?: string } = {}) {
  const img = document.createElement('img')
  if (src) img.setAttribute('src', src)
  if (opts.alt !== undefined) img.setAttribute('alt', opts.alt)
  Object.defineProperty(img, 'complete', { value: opts.complete ?? true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: opts.width ?? 800, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: opts.height ?? 600, configurable: true })
  return img
}

/** 每个用例独立的容器 + effect scope（onScopeDispose 需要有活跃 scope，否则 Vue 会告警） */
let container: HTMLElement
let scope: EffectScope

function setup(imgs: HTMLImageElement[]) {
  container = document.createElement('div')
  for (const img of imgs) container.appendChild(img)
  document.body.appendChild(container)

  const containerRef = ref<HTMLElement | undefined>(container)
  scope = effectScope()
  // useImageLightbox 内部用 onScopeDispose 清监听，必须跑在 scope 里
  const api = scope.run(() => useImageLightbox(containerRef))!
  return api
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  scope?.stop()
  document.body.innerHTML = ''
})

describe('useImageLightbox', () => {
  it('attach 收集图片的地址与 alt，并默认不展示', () => {
    const { visible, index, images, attach } = setup([
      makeImg('https://example.com/a.png', { alt: '图 A' }),
      makeImg('https://example.com/b.png')
    ])

    attach()

    expect(visible.value).toBe(false)
    expect(index.value).toBe(0)
    expect(images.value).toHaveLength(2)
    expect(images.value[0]).toMatchObject({ src: 'https://example.com/a.png', title: '图 A' })
    // 没有 alt 时不产生空标题
    expect(images.value[1]!.title).toBeUndefined()
  })

  it('点击第 N 张图时打开 lightbox 并定位到同一张', () => {
    const imgs = [makeImg('https://example.com/1.png'), makeImg('https://example.com/2.png')]
    const { visible, index, attach } = setup(imgs)

    attach()
    imgs[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(visible.value).toBe(true)
    expect(index.value).toBe(1)
  })

  it('点击时阻止默认行为，避免图片被外层链接带走', () => {
    const img = makeImg('https://example.com/a.png')
    const { attach } = setup([img])
    attach()

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    img.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('过滤 1x1 追踪像素：既不进图集，点它也不会打开 lightbox', () => {
    const pixel = makeImg('https://example.com/pixel.gif', { width: 1, height: 1 })
    const real = makeImg('https://example.com/photo.jpg')
    const { images, visible, index, attach } = setup([pixel, real])

    attach()

    expect(images.value.map(i => i.src)).toEqual(['https://example.com/photo.jpg'])

    // 追踪像素没有被挂上监听，点它保持不展示
    pixel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(false)

    // 真实图片的索引因过滤而重排（photo 虽然排第二，但只收集到它就应是 0）
    real.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(true)
    expect(index.value).toBe(0)
  })

  it('还没加载完的图片（complete=false）不会被误判成追踪像素', () => {
    // naturalWidth 在加载完成前恒为 0，只按尺寸判定会把正常图片全部误杀
    const loading = makeImg('https://example.com/slow.jpg', { complete: false, width: 0, height: 0 })
    const { images, attach } = setup([loading])

    attach()

    expect(images.value.map(i => i.src)).toEqual(['https://example.com/slow.jpg'])
  })

  it('detach 摘掉全部点击监听、复位光标并关闭 lightbox', () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, images, attach, detach } = setup([img])

    attach()
    expect(img.style.cursor).toBe('zoom-in')

    detach()
    expect(visible.value).toBe(false)

    // 再点已 detach 的图不应打开
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(false)
    expect(img.style.cursor).toBe('')
    // images 保留最后一轮结果（供退出动画使用），这里只断言不再新增监听
    expect(images.value).toHaveLength(1)
  })

  it('重复 attach 不会累积监听：一次点击只切换一次状态', () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, attach } = setup([img])

    attach()
    attach()
    attach()

    // detach 先于绑定执行，所以只应存在一个监听；这里用关闭再点来验证没有残留
    visible.value = false
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(true)
  })

  it('正文里没有图片时 attach 不报错也不进入展示态', () => {
    const { visible, images, attach } = setup([])

    expect(() => attach()).not.toThrow()
    expect(visible.value).toBe(false)
    expect(images.value).toEqual([])
  })

  it('ESC 在 capture 阶段被吃掉：只关 lightbox，不冒泡给外层 UModal', () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, attach } = setup([img])
    attach()
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(true)

    // 模拟外层 UModal（Reka UI Dialog）在 document 上挂的 ESC 监听
    const outerHandler = vi.fn()
    document.addEventListener('keydown', outerHandler)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    img.dispatchEvent(event)

    expect(visible.value).toBe(false) // lightbox 关了
    expect(outerHandler).not.toHaveBeenCalled() // 条目弹窗没跟着关
    expect(event.defaultPrevented).toBe(true)

    document.removeEventListener('keydown', outerHandler)
  })

  it('lightbox 未打开时 ESC 不受干预，交给外层处理', () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, attach } = setup([img])
    attach()
    expect(visible.value).toBe(false)

    const outerHandler = vi.fn()
    document.addEventListener('keydown', outerHandler)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    img.dispatchEvent(event)

    expect(outerHandler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)

    document.removeEventListener('keydown', outerHandler)
  })

  it('非 ESC 按键完全透传', () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, attach } = setup([img])
    attach()
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(true)

    const outerHandler = vi.fn()
    document.addEventListener('keydown', outerHandler)
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    img.dispatchEvent(event)

    expect(outerHandler).toHaveBeenCalledTimes(1)
    expect(visible.value).toBe(true) // 方向键不该关掉 lightbox

    document.removeEventListener('keydown', outerHandler)
  })

  it('打开后给 .vel-modal 补 data-dismissable-layer，让 Reka UI 认为它在弹窗内部', async () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, attach } = setup([img])
    attach()

    // lightbox 真实组件 teleport 到 body 后渲染出的根节点
    const modal = document.createElement('div')
    modal.className = 'vel-modal'
    document.body.appendChild(modal)

    visible.value = true
    await nextTick()
    await nextTick()

    expect(modal.getAttribute('data-dismissable-layer')).toBe('')
  })

  it('作用域销毁时自动 detach，不留全局 keydown 监听', () => {
    const img = makeImg('https://example.com/a.png')
    const { visible, attach } = setup([img])
    attach()
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visible.value).toBe(true)

    scope.stop()

    expect(visible.value).toBe(false)

    // 销毁后再按 ESC，不应再被这个 composable 拦掉
    const outerHandler = vi.fn()
    document.addEventListener('keydown', outerHandler)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    expect(outerHandler).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', outerHandler)
  })
})
