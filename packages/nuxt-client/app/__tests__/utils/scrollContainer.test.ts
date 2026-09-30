import { describe, it, expect, afterEach } from 'vitest'
import { resolveScrollContainer, findScrollParent, isScrollableY } from '../../utils/scrollContainer'

/**
 * 滚动容器定位。
 *
 * 列表页里提示条和列表是**兄弟**：真正滚动的是列表（UScrollArea 的根，overflow-y-auto），
 * 它不在提示条的祖先链上。以前只沿祖先找，结果一路找到顶都没有，回顶部落到
 * `window.scrollTo`——而这套面板布局里页面本身不滚，等于什么都没做。
 */

// happy-dom 只对挂在文档里的元素算样式，所以整棵树最后都要进 body
afterEach(() => {
  document.body.innerHTML = ''
})

/** happy-dom 不做真实布局：滚动高度只能手写 */
function setScrollSize(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  return el
}

/** 造一个「纵向可滚动」的容器（内容 1000px、视口 300px） */
function scrollable(className = ''): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  el.style.overflowY = 'auto'
  return setScrollSize(el, 1000, 300)
}

/** 挂进文档（这样 getComputedStyle 才读得到 overflow），返回同一节点 */
function attach<T extends HTMLElement>(el: T): T {
  document.body.append(el)
  return el
}

describe('isScrollableY', () => {
  it('overflow-y: auto 且内容溢出才算可滚动', () => {
    expect(isScrollableY(attach(scrollable()))).toBe(true)
  })

  it('内容没溢出不算可滚动', () => {
    const el = document.createElement('div')
    el.style.overflowY = 'auto'
    expect(isScrollableY(attach(setScrollSize(el, 200, 300)))).toBe(false)
  })

  it('overflow: hidden 不算：列表页里被裁剪的过渡容器不能被误认', () => {
    const el = document.createElement('div')
    el.style.overflowY = 'hidden'
    expect(isScrollableY(attach(setScrollSize(el, 1000, 100)))).toBe(false)
  })

  it('null 不算', () => {
    expect(isScrollableY(null)).toBe(false)
  })
})

describe('resolveScrollContainer', () => {
  it('列表与提示条是兄弟时，从共同父级里认出列表自己', () => {
    const banner = document.createElement('div')
    const list = scrollable('list')
    const panel = attach(document.createElement('div'))
    panel.append(banner, list)

    expect(resolveScrollContainer(panel)).toBe(list)
  })

  it('子树优先于祖先：更靠内的滚动区才是用户实际滚的那个', () => {
    const mid = document.createElement('div')
    const outer = attach(scrollable('outer'))
    outer.append(mid)
    mid.append(scrollable('list'))

    expect(resolveScrollContainer(mid)).toBe(outer.querySelector('.list'))
  })

  it('子树里没有就沿祖先链找（页面级滚动区）', () => {
    const inner = document.createElement('div')
    const page = attach(scrollable('page'))
    page.append(inner)

    expect(resolveScrollContainer(inner)).toBe(page)
    expect(findScrollParent(inner)).toBe(page)
  })

  it('哪儿都没有可滚动容器时返回 null（调用方交给 window）', () => {
    expect(resolveScrollContainer(attach(document.createElement('div')))).toBeNull()
  })
})
