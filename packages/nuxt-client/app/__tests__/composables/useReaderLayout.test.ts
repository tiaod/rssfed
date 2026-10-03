import { describe, it, expect } from 'vitest'
import {
  isReaderRoute,
  readerPaneMaxSizeRem,
  READER_PANE_MIN_REM,
  READER_PANE_MIN_WIDTH
} from '../../composables/useReaderLayout'

/**
 * 三栏（列表 + 常驻阅读栏）只在列表页成立。
 *
 * 路由判断是布局的第二把锁：页面卸载时不清共享状态（页面切换的挂载/卸载顺序不保证），
 * 靠「不在列表页就一律不算」兜底，所以这里的边界要钉住。
 */
describe('isReaderRoute', () => {
  it('四个列表页 + 收藏页命中', () => {
    for (const path of [
      '/timeline',
      '/saved',
      '/rss/feed/-EGH98Uu-bNGGYJj',
      '/rss/group/%E6%96%B0%E9%97%BB',
      '/bots/6qtpuepzbtc4m8xdv3wpkntj/posts'
    ]) {
      expect(isReaderRoute(path), path).toBe(true)
    }
  })

  it('单源页读某一篇时的详情地址仍算列表页（阅读栏不该在点开的瞬间消失）', () => {
    for (const path of [
      '/rss/feed/-EGH98Uu-bNGGYJj/entry/entry%3A-EGH98Uu-bNGGYJj%3Aab12cd34ef56',
      '/rss/feed/-EGH98Uu-bNGGYJj/entry/entry-1'
    ]) {
      expect(isReaderRoute(path), path).toBe(true)
    }
  })

  it('非列表页不命中（详情仍走弹窗）', () => {
    for (const path of [
      '/',
      '/profile',
      '/login',
      '/offline',
      '/bots/explore',
      '/bots/6qtpuepzbtc4m8xdv3wpkntj',
      '/rss/feed',
      '/rss/feed/-EGH98Uu-bNGGYJj/extra',
      // 只有 /entry 这一层、没带条目 id：不是详情地址
      '/rss/feed/-EGH98Uu-bNGGYJj/entry',
      '/rss/feed/-EGH98Uu-bNGGYJj/entry/a/b',
      '/bots/6qtpuepzbtc4m8xdv3wpkntj/posts/extra'
    ]) {
      expect(isReaderRoute(path), path).toBe(false)
    }
  })

  it('断点就是侧边栏出现的 lg（1024）', () => {
    expect(READER_PANE_MIN_WIDTH).toBe(1024)
  })
})

/**
 * 阅读栏能拖多宽。固定上限在两种窗口上都不合适（小窗口挤没中间栏、大窗口拖不动），
 * 所以是「视口 - 侧边栏 - 中间栏下限」，再夹在 20~80rem 之间。
 */
describe('readerPaneMaxSizeRem', () => {
  it('大屏放开到绝对上限 80rem', () => {
    expect(readerPaneMaxSizeRem(2560)).toBe(80)
    expect(readerPaneMaxSizeRem(1920)).toBe(80) // 120-33=87 → 夹到 80
  })

  it('中等窗口按「视口 - 侧边栏 15rem - 中间栏下限 18rem」算', () => {
    expect(readerPaneMaxSizeRem(1440)).toBe(57) // 90-33
    expect(readerPaneMaxSizeRem(1280)).toBe(47) // 80-33
  })

  it('小窗口给中间那栏留下限，且不低于阅读栏自己的 min', () => {
    expect(readerPaneMaxSizeRem(1024)).toBe(31) // 64-33
    expect(readerPaneMaxSizeRem(800)).toBe(READER_PANE_MIN_REM) // 50-33=17 → 夹到 20
  })
})
