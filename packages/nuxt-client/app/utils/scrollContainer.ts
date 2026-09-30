/**
 * 滚动容器定位。
 *
 * 列表页的布局是「并列兄弟」：提示条、列表同在一个 flex 列里，真正滚动的是列表自己
 * （EntryList 的 UScrollArea 根节点，overflow-y-auto），它既不是提示条的祖先，也不是
 * 提示条的后代 —— 只沿祖先链找会一路找到顶也找不到，最后落到 `window.scrollTo`，
 * 而这套面板布局里页面本身并不滚动，于是「回顶部」什么都不会发生。
 *
 * 所以先往锚点子树里找（列表是锚点的后代），找不到再沿祖先链找，仍然没有就返回 null
 * （由调用方交给 window 处理）。
 */

/** 元素自身是否是纵向可滚动容器（有滚动能力且内容确实溢出） */
export function isScrollableY(el: HTMLElement | null): boolean {
  if (!el) return false
  const overflowY = window.getComputedStyle(el).overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false
  return el.scrollHeight > el.clientHeight
}

/** 从锚点向上找第一个纵向可滚动祖先 */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    if (isScrollableY(node)) return node
    node = node.parentElement
  }
  return null
}

/** 在 root 自身及后代中按文档顺序找第一个纵向可滚动元素 */
export function findScrollableDescendant(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  if (isScrollableY(root)) return root
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue
    const found = findScrollableDescendant(child)
    if (found) return found
  }
  return null
}

/**
 * 解析承载某个列表的滚动容器；返回 null 表示「页面级滚动」，交给 window。
 *
 * 先子树后祖先：列表自己的滚动区一定比任何祖先更靠内，也就更接近用户实际滚动的东西。
 */
export function resolveScrollContainer(anchor: HTMLElement | null): HTMLElement | null {
  return findScrollableDescendant(anchor) ?? findScrollParent(anchor)
}
